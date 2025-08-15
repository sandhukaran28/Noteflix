// src/routes/jobs.js
const { Router } = require("express");
const { db } = require("../db");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");
const { spawnSync } = require("child_process");

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

// ---------- create job ----------
r.post("/process", (req, res) => {
  const user = req.user;
  const {
    assetId,
    style = "kenburns",
    duration = 90,
    dialogue = "solo",
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
    JSON.stringify({ style, duration, dialogue }),
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

// ---------- output (Range) ----------
r.get("/:id/output", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row || !row.outputPath || !fs.existsSync(row.outputPath))
    return res.status(404).json({ error: "not found" });

  const stat = fs.statSync(row.outputPath);
  const range = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, "").split("-");
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    res.writeHead(206, {
      "Content-Range": `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(row.outputPath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      "Content-Length": stat.size,
      "Content-Type": "video/mp4",
      "Accept-Ranges": "bytes",
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

      // 2) Extract text + Ollama script
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
        const excerpt = (notes || "").trim().slice(0, 4000);
        const duet = ctx.dialogue === "duet";
        const prompt = `
You are scripting a short educational podcast${duet ? " with TWO speakers (Alex and Sam)" : ""}.
${duet ? "Write alternating lines starting with 'Alex:' and 'Sam:'." : "Write a single narrator script."}
Constraints:
- Length: ~60–120 seconds total
- Friendly, precise, clear. Short sentences. No filler.
- Keep it grounded in the NOTES content. If missing, infer a reasonable, generic overview.

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

      // Save script, and a sanitized TTS text
      const scriptPath = path.join(ctx.jobDir, "script.txt");
      fs.writeFileSync(scriptPath, scriptText, "utf8");

      const ttsText = scriptText
        .replace(/\r/g, " ")
        .replace(/\n+/g, ". ")
        .replace(/[ \t]+/g, " ")
        .trim();
      const ttsPath = path.join(ctx.jobDir, "tts.txt");
      fs.writeFileSync(ttsPath, ttsText, "utf8");

      // 3) TTS (solo/duet) -> narration.wav (optional)
      async function synthSolo(ctx, ttsPath) {
        if (!hasCmd("espeak-ng")) {
          return {
            path: null,
            log: "INFO: espeak-ng not found; proceeding captions-only.",
          };
        }
        const out = path.join(ctx.jobDir, "narration.wav");
        const cmd = `espeak-ng -v en+f3 -s 150 -p 45 -a 140 -g 8 -w "${out}" -f "${ttsPath}"`;
        const r = sh(cmd);
        return fs.existsSync(out)
          ? { path: out, log: r.stderr || "" }
          : { path: null, log: "WARN: TTS failed; proceeding without narration." };
      }

      function parseDuet(script) {
        const lines = script
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const segs = [];
        for (const line of lines) {
          const m = /^(Alex|Sam):\s*(.+)$/i.exec(line);
          if (m) segs.push({ speaker: m[1].toLowerCase(), text: m[2] });
        }
        if (segs.length === 0) {
          const sentences = script
            .replace(/\r/g, " ")
            .split(/(?<=[.!?])\s+/)
            .filter(Boolean);
          for (let i = 0; i < sentences.length; i++) {
            segs.push({
              speaker: i % 2 === 0 ? "alex" : "sam",
              text: sentences[i],
            });
          }
        }
        return segs;
      }

      async function synthDuet(ctx, scriptText) {
        if (!hasCmd("espeak-ng")) {
          return { path: null, log: "INFO: espeak-ng not found; duet captions-only." };
        }
        const segs = parseDuet(scriptText);
        const work = [];
        const logs = [];
        for (let i = 0; i < segs.length; i++) {
          const { speaker, text } = segs[i];
          const wav = path.join(
            ctx.jobDir,
            `seg-${String(i + 1).padStart(3, "0")}.wav`
          );
          const clean = text
            .replace(/\r/g, " ")
            .replace(/\n+/g, ". ")
            .replace(/[ \t]+/g, " ")
            .trim();

          // write each segment to a file to avoid quoting issues
          const segTxt = path.join(
            ctx.jobDir,
            `seg-${String(i + 1).padStart(3, "0")}.txt`
          );
          fs.writeFileSync(segTxt, clean + "\n", "utf8");

          // distinct voices + pacing
          const voice = speaker === "alex" ? "en+f3" : "en+m3";
          const speed = speaker === "alex" ? 145 : 148;
          const pitch = speaker === "alex" ? 48 : 42;

          const cmd = `espeak-ng -v ${voice} -s ${speed} -p ${pitch} -a 140 -g 10 -w "${wav}" -f "${segTxt}"`;
          const r = sh(cmd);
          if (r.stderr) logs.push(r.stderr);
          if (!fs.existsSync(wav))
            return { path: null, log: "WARN: duet TTS failed; captions-only." };

          // 200ms turn-taking pause
          const pad = path.join(
            ctx.jobDir,
            `sil-${String(i + 1).padStart(3, "0")}.wav`
          );
          sh(
            `ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.20 "${pad}" >/dev/null 2>&1`
          );
          work.push(wav, pad);
        }

        // concat segments
        const list = path.join(ctx.jobDir, "concat.txt");
        fs.writeFileSync(
          list,
          work.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"),
          "utf8"
        );
        const out = path.join(ctx.jobDir, "narration.wav");
        const concat = sh(
          `ffmpeg -y -f concat -safe 0 -i "${list}" -ar 44100 -ac 1 -c:a pcm_s16le "${out}"`
        );
        if (concat.stderr) logs.push(concat.stderr);
        return fs.existsSync(out)
          ? { path: out, log: logs.join("\n") }
          : { path: null, log: "WARN: concat failed; duet captions-only." };
      }

      let narrationPath = null;
      if (ctx.dialogue === "duet") {
        const duetRes = await synthDuet(ctx, scriptText);
        log(duetRes.log || "");
        narrationPath = duetRes.path;
      } else {
        const soloRes = await synthSolo(ctx, ttsPath);
        log(soloRes.log || "");
        narrationPath = soloRes.path;
      }
      const hasAudio = Boolean(narrationPath);

      // 4) captions
      const vtt = makeVttFromScript(scriptText);
      const vttPath = path.join(ctx.jobDir, "captions.vtt");
      fs.writeFileSync(vttPath, vtt, "utf8");

      // 5) duration-aware timing & encoding
      const slides = fs
        .readdirSync(ctx.jobDir)
        .filter((f) => /^slide-.*\.png$/i.test(f))
        .sort();
      const nSlides = Math.max(1, slides.length);

      const perSlideSec = Math.max(
        3,
        Math.round((ctx.duration || 90) / nSlides)
      );
      const fpsOut = 30;
      const dFrames = perSlideSec * fpsOut; // zoompan d=frames per input image
      const vf = `zoompan=z='zoom+0.001':d=${dFrames}:s=1920x1080,fps=${fpsOut},subtitles='${vttPath.replace(
        /'/g,
        "\\'"
      )}',format=yuv420p`;
      const fr = 1 / perSlideSec; // input images per second

      const cmd = hasAudio
        ? `ffmpeg -y -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -i "${narrationPath}" -filter_complex "${vf}" -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 192k -shortest "${ctx.outputPath}"`
        : `ffmpeg -y -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -filter_complex "${vf}" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p "${ctx.outputPath}"`;

      const enc = spawn("bash", ["-lc", cmd]);
      enc.stdout.on("data", (d) => log(d.toString()));
      enc.stderr.on("data", (d) => log(d.toString()));
      await new Promise((resolve) => enc.on("close", resolve));

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
