// src/routes/jobs.js
const { Router } = require("express");
const { db } = require("../db");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { synthesizePodcast } = require("../utils/tts");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const TMP_DIR = path.join(DATA_ROOT, "tmp");
const OUT_DIR = path.join(DATA_ROOT, "outputs");
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const r = Router();

// ---------- helpers ----------
function sh(cmd, opts = {}) {
  return spawnSync("bash", ["-lc", cmd], { encoding: "utf8", ...opts });
}

function hasCmd(name) {
  const r = sh(`command -v ${name} || which ${name} || true`);
  return r.status === 0 && r.stdout.trim().length > 0;
}

// helper: get audio duration with ffprobe
function getAudioDuration(file) {
  try {
    const out = spawnSync(
      "bash",
      [
        "-lc",
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${file}"`,
      ],
      { encoding: "utf8" }
    );
    if (out.status === 0) {
      return Math.ceil(parseFloat(out.stdout.trim()));
    }
  } catch (e) {
    return null;
  }
  return null;
}

async function callOllama(prompt, { base, model }) {
  const url = `${base || "http://localhost:11434"}/api/generate`;
  const body = {
    model: model || "llama3",
    prompt,
    stream: false,
    options: { temperature: 0.6 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

function makeVttFromScript(text) {
  const cleaned = text.replace(/\r/g, "").trim();
  const parts = cleaned.split(/(?<=[\.\!\?])\s+/).filter(Boolean);
  let t = 0;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3, "0")}`;
  };
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < parts.length; i++) {
    const dur = 3;
    const start = stamp(t);
    const end = stamp(t + dur);
    vtt += `${i + 1}\n${start} --> ${end}\n${parts[i]}\n\n`;
    t += dur;
  }
  if (parts.length === 0) {
    vtt += `1\n00:00:00.000 --> 00:00:03.000\n(no script)\n\n`;
  }
  return vtt;
}

// remove timecodes/markdown and collapse spaces for TTS
function cleanForTTS(text) {
  return text
    .normalize("NFKD")
    .replace(/Here is the script[^:]*:\s*/gi, "")
    .replace(/\b(Alex|Sam):\s*/gi, "")
    .replace(/[^\x00-\x7F]+/g, " ")
    .replace(/\*\*?\s*\[[^\]]+\]\s*\*?\s*/g, " ")
    .replace(/\[[0-9:\- ]+seconds?\]/gi, " ")
    .replace(/\*\*/g, " ")
    .replace(/[_`#>•▪︎•·–—“”‘’]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------- create job ----------
r.post("/process", (req, res) => {
  const user = req.user;
  const {
    assetId,
    style = "kenburns",
    duration = 90,
    dialogue = "solo",
    encodeProfile = "balanced", // NEW
  } = req.body || {};

  const asset = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(assetId);
  if (!asset) return res.status(400).json({ error: "invalid assetId" });

  const id = uuid();
  const jobDir = path.join(TMP_DIR, id);
  const logsPath = path.join(jobDir, "logs.txt");
  const outDir = path.join(OUT_DIR, id);
  const outputPath = path.join(outDir, "video.mp4");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  db.prepare(
    `INSERT INTO jobs(id, assetId, owner, params, status, logsPath)
     VALUES(?, ?, ?, ?, 'pending', ?)`
  ).run(
    id,
    assetId,
    user?.sub || "unknown",
    JSON.stringify({ style, duration, dialogue, encodeProfile }),
    logsPath
  );

  process.nextTick(() =>
    runJob(id, asset, {
      jobDir,
      outDir,
      outputPath,
      logsPath,
      duration,
      dialogue,
      encodeProfile,
    })
  );

  res.json({ jobId: id });
});

// ---------- list + details ----------
r.get("/", (req, res) => {
  const user = req.user;
  const rows = db
    .prepare(`SELECT * FROM jobs WHERE owner = ? ORDER BY rowid DESC LIMIT 50`)
    .all(user?.sub || "unknown");
  res.json(rows);
});

r.get("/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// ---------- logs ----------
r.get("/:id/logs", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row || !row.logsPath)
    return res.status(404).json({ error: "not found" });
  if (!fs.existsSync(row.logsPath)) return res.status(200).send("");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  fs.createReadStream(row.logsPath).pipe(res);
});

// ---------- output (Download) ----------
r.get("/:id/output", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row || !row.outputPath || !fs.existsSync(row.outputPath)) {
    return res.status(404).json({ error: "not found" });
  }

  const stat = fs.statSync(row.outputPath);

  // Always set download header
  res.setHeader("Content-Disposition", "attachment; filename=video.mp4");
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;

    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Content-Length": end - start + 1,
    });

    fs.createReadStream(row.outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
    });

    fs.createReadStream(row.outputPath).pipe(res);
  }
});

module.exports = r;

// ---------- worker ----------
function runJob(id, asset, ctx) {
  const log = (s) => fs.appendFileSync(ctx.logsPath, s + "\n");
  const start = Date.now();
  db.prepare(
    `UPDATE jobs SET status='running', startedAt=datetime('now') WHERE id=?`
  ).run(id);

  (async () => {
    try {
      // 1) PDF -> images (or copy single image)
      const isPdf = asset.type === "pdf";
      if (isPdf) {
        if (!hasCmd("pdftoppm"))
          throw new Error("pdftoppm not found (install poppler-utils)");
        const p1 = sh(
          `mkdir -p "${ctx.jobDir}" && pdftoppm -png "${asset.path}" "${ctx.jobDir}/slide"`
        );
        log(p1.stdout || "");
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("pdf->images failed");
      } else {
        sh(`mkdir -p "${ctx.jobDir}"`);
        const p1 = sh(`cp "${asset.path}" "${ctx.jobDir}/slide-001.png"`);
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("copy image failed");
      }

      // visibility for debugging
      const ls = sh(`ls -l "${ctx.jobDir}" | head -n 40`);
      log(ls.stdout || "");
      log(ls.stderr || "");

      // 2) Extract text + Ollama script (duration-aware)
      let scriptText = "";
      if (isPdf) {
        if (!hasCmd("pdftotext"))
          log("WARN: pdftotext not found; using fallback summary prompt.");
        let notes = "";
        if (hasCmd("pdftotext")) {
          const textPath = path.join(ctx.jobDir, "notes.txt");
          const t1 = sh(`pdftotext "${asset.path}" "${textPath}"`);
          log(t1.stderr || "");
          if (t1.status === 0 && fs.existsSync(textPath)) {
            notes = fs.readFileSync(textPath, "utf8");
          }
        }

        // Dynamic word target from requested duration
        const wpm = 150; // ~2.5 words/sec
        const targetSeconds = Math.max(
          30,
          Math.min(600, Number(ctx.duration || 90))
        ); // clamp 30s–10m
        const targetWords = Math.round((wpm / 60) * targetSeconds);

        const duet = ctx.dialogue === "duet";
        const excerpt = (notes || "").trim().slice(0, 4000);
        const prompt = `
You are scripting a short educational podcast${
          duet ? " with TWO speakers (Alex and Sam)" : ""
        }.
${
  duet
    ? "Write alternating lines starting with 'Alex:' and 'Sam:'."
    : "Write a single narrator script."
}

Constraints:
- Target length: ~${targetWords} words (≈ ${targetSeconds} seconds at ~${wpm} wpm).
- Friendly, precise, clear. Short sentences (6–16 words). No filler.
- Keep it grounded in the NOTES content. If missing, infer a reasonable, generic overview.
- Do NOT include stage directions, timecodes, or markdown—just the spoken lines.

NOTES:
${excerpt || "(No extracted text available. Create a generic study overview.)"}
`.trim();

        const base = process.env.OLLAMA_BASE || "http://localhost:11434";
        const model = process.env.OLLAMA_MODEL || "llama3";
        log(`Calling Ollama at ${base} with model ${model} ...`);
        try {
          scriptText = await callOllama(prompt, { base, model });
        } catch (e) {
          log("Ollama call failed: " + e.message);
          scriptText =
            "Welcome to NoteFlix. This is an automatically generated study summary. Please review your notes and key definitions.";
        }
      } else {
        scriptText =
          "This video animates your uploaded slide. Add more pages for a richer episode.";
      }

      // Save raw script
      const scriptPath = path.join(ctx.jobDir, "script.txt");
      fs.writeFileSync(scriptPath, scriptText, "utf8");

      // 3) TTS (solo/duet) -> narration.wav using Piper (via utils/tts)
      log("Cleaning script for TTS...");
      const cleaned = cleanForTTS(scriptText);

      let scriptLines;
      if (ctx.dialogue === "duet") {
        // If lines like "Alex: ..." / "Sam: ..." exist, preserve order.
        const labeled = cleaned
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const hasLabels = labeled.some((l) => /^alex:|^sam:/i.test(l));
        if (hasLabels) {
          scriptLines = labeled.map((l) => l.replace(/^(alex|sam):\s*/i, ""));
        } else {
          // Fallback: alternate by sentence
          scriptLines = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
        }
      } else {
        // solo narrator — one big line is fine; Piper pauses at sentence boundaries
        scriptLines = [cleaned];
      }

      fs.writeFileSync(
        path.join(ctx.jobDir, "tts_clean.txt"),
        scriptLines.join("\n"),
        "utf8"
      );
      log("Starting TTS synthesis (Piper)...");
      let narrationPath = null;
      try {
        narrationPath = path.join(ctx.jobDir, "narration.wav");
        const voices = {
          voiceA: process.env.PIPER_VOICE_A || "/app/models/en_US-amy-medium.onnx",
          voiceB: process.env.PIPER_VOICE_B || "/app/models/en_US-ryan-high.onnx",
        };
        await synthesizePodcast(
          scriptLines,
          narrationPath,
          ctx.dialogue === "duet",
          voices
        );
        log("TTS synthesis complete");
      } catch (e) {
        log("TTS synthesis failed: " + e.message);
        narrationPath = null;
      }
      const hasAudio = !!narrationPath && fs.existsSync(narrationPath);

      // 4) captions
      const vtt = makeVttFromScript(scriptText);
      const vttPath = path.join(ctx.jobDir, "captions.vtt");
      fs.writeFileSync(vttPath, vtt, "utf8");

      // 5) duration-aware timing & HEAVIER encoding
      const slides = fs
        .readdirSync(ctx.jobDir)
        .filter((f) => /^slide-.*\.png$/i.test(f))
        .sort();
      const nSlides = Math.max(1, slides.length);

      // narration-aware duration
      let totalDuration = ctx.duration || 90;
      if (hasAudio) {
        const dur = getAudioDuration(narrationPath);
        if (dur && dur > 0) {
          totalDuration = dur;
          log(`Detected narration length: ${dur}s`);
        }
      }

      const profile = String(ctx.encodeProfile || "balanced").toLowerCase();

      // Timing (slightly longer floor per slide)
      const perSlideSec = Math.max(4, Math.round(totalDuration / nSlides));
      const baseFps =
        profile === "insane" ? 60 : profile === "heavy" ? 48 : 30;
      const dFrames = perSlideSec * baseFps;
      const fr = 1 / perSlideSec;

      // Output resolution targets (upscale to burn CPU)
      const outW = profile === "insane" ? 3840 : profile === "heavy" ? 2560 : 1920;
      const outH = profile === "insane" ? 2160 : profile === "heavy" ? 1440 : 1080;

      const subtitlePathEsc = vttPath.replace(/'/g, "\\'");
      const zoom = `zoompan=z='zoom+0.001':d=${dFrames}:s=${outW}x${outH}`;
      const baseFilters = [
        zoom,
        `scale=${outW}:${outH}:flags=lanczos`,
        // captions intentionally NOT burned into the video
        `unsharp=5:5:0.5:5:5:0.5`,
        `eq=contrast=1.05:brightness=0.02:saturation=1.05`,
        `vignette=PI/6`,
      ];

      // Motion interpolation is very CPU-heavy
      if (profile !== "balanced") {
        baseFilters.push(
          `minterpolate='mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps=${baseFps}'`
        );
      }
      baseFilters.push(`format=yuv420p`);
      const vf = baseFilters.join(",");

      // Audio filter: normalize & resample
      const af = hasAudio
        ? `-ar 48000 -af "loudnorm=I=-16:LRA=11:TP=-1.5"`
        : "";

      // x264 settings
      const preset = profile === "insane" ? "veryslow" : profile === "heavy" ? "slower" : "slow";
      const crf = profile === "insane" ? 16 : profile === "heavy" ? 18 : 20;

      if (profile !== "balanced") {
        // 2-pass to double CPU work and improve allocation
        const passlog = path.join(ctx.jobDir, "ffpass");
        const cmd1 = `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" ${
          hasAudio ? `-i "${narrationPath}"` : ""
        } -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p -an -pass 1 -passlogfile "${passlog}" -f mp4 /dev/null`;
        log("ENC PASS1: " + cmd1);
        const enc1 = spawn("bash", ["-lc", cmd1]);
        enc1.stdout.on("data", (d) => log(d.toString()));
        enc1.stderr.on("data", (d) => log(d.toString()));
        await new Promise((resolve) => enc1.on("close", resolve));

        const cmd2 = `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" ${
          hasAudio ? `-i "${narrationPath}"` : ""
        } -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p ${
          hasAudio ? `${af} -c:a aac -b:a 192k` : ""
        } -movflags +faststart -shortest -pass 2 -passlogfile "${passlog}" "${ctx.outputPath}"`;
        log("ENC PASS2: " + cmd2);
        const enc2 = spawn("bash", ["-lc", cmd2]);
        enc2.stdout.on("data", (d) => log(d.toString()));
        enc2.stderr.on("data", (d) => log(d.toString()));
        await new Promise((resolve) => enc2.on("close", resolve));
      } else {
        // Single-pass balanced
        const cmd = hasAudio
          ? `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -i "${narrationPath}" -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p ${af} -c:a aac -b:a 192k -movflags +faststart -shortest "${ctx.outputPath}"`
          : `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p -movflags +faststart "${ctx.outputPath}"`;
        log("ENC: " + cmd);
        const enc = spawn("bash", ["-lc", cmd]);
        enc.stdout.on("data", (d) => log(d.toString()));
        enc.stderr.on("data", (d) => log(d.toString()));
        await new Promise((resolve) => enc.on("close", resolve));
      }

      const cpuSeconds = Math.round((Date.now() - start) / 1000);
      if (!fs.existsSync(ctx.outputPath))
        throw new Error("ffmpeg failed to produce output");

      db.prepare(
        `UPDATE jobs SET status='done', finishedAt=datetime('now'), cpuSeconds=?, outputPath=? WHERE id=?`
      ).run(cpuSeconds, ctx.outputPath, id);
      log("JOB DONE");
    } catch (err) {
      const cpuSeconds = Math.round((Date.now() - start) / 1000);
      db.prepare(
        `UPDATE jobs SET status='failed', finishedAt=datetime('now'), cpuSeconds=? WHERE id=?`
      ).run(cpuSeconds, id);
      log("FAILED: " + (err && err.message ? err.message : String(err)));
    }
  })();
}
