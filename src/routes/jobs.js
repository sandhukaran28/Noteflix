const { Router } = require("express");
const { db } = require("../db");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const TMP_DIR = path.join(DATA_ROOT, "tmp");
const OUT_DIR = path.join(DATA_ROOT, "outputs");
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const r = Router();

// === Helpers (add near top of jobs.js) ===
const { spawnSync } = require("child_process");

function sh(cmd, opts = {}) {
  // runs in bash for portability with our other steps
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
    options: { temperature: 0.6 }
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const json = await res.json();
  return json.response;
}

function makeVttFromScript(text) {
  // naive: split by sentence-ish boundaries; 3s per chunk
  const cleaned = text.replace(/\r/g, "").trim();
  const parts = cleaned.split(/(?<=[\.\!\?])\s+/).filter(Boolean);
  let t = 0;
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec - Math.floor(sec)) * 1000);
    return `${pad(h)}:${pad(m)}:${pad(s)}.${String(ms).padStart(3,"0")}`;
  };
  let vtt = "WEBVTT\n\n";
  for (let i = 0; i < parts.length; i++) {
    const dur = 3; // seconds per sentence
    const start = stamp(t);
    const end = stamp(t + dur);
    vtt += `${i+1}\n${start} --> ${end}\n${parts[i]}\n\n`;
    t += dur;
  }
  if (parts.length === 0) {
    vtt += `1\n00:00:00.000 --> 00:00:03.000\n(no script)\n\n`;
  }
  return vtt;
}


// ---------- CREATE JOB (CPU work) ----------
r.post("/process", (req, res) => {
  const user = req.user;
  const { assetId, style = "kenburns", duration = 90 } = req.body || {};
  const asset = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(assetId);
  if (!asset) return res.status(400).json({ error: "invalid assetId" });

  const id = uuid();
  const jobDir = path.join(TMP_DIR, id);
  const logsPath = path.join(jobDir, "logs.txt");
  const outDir = path.join(OUT_DIR, id);
  const outputPath = path.join(outDir, "video.mp4");
  fs.mkdirSync(jobDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });

  db.prepare(`INSERT INTO jobs(id, assetId, owner, params, status, logsPath)
              VALUES(?, ?, ?, ?, 'pending', ?)`)
    .run(id, assetId, user?.sub || "unknown", JSON.stringify({ style, duration }), logsPath);

  process.nextTick(() => runJob(id, asset, { jobDir, outDir, outputPath, logsPath, duration }));

  res.json({ jobId: id });
});

// ---------- LIST + DETAILS ----------
r.get("/", (req, res) => {
  const user = req.user;
  const rows = db.prepare(`SELECT * FROM jobs WHERE owner = ? ORDER BY rowid DESC LIMIT 50`)
                 .all(user?.sub || "unknown");
  res.json(rows);
});

r.get("/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

// ---------- LOGS (text/plain stream) ----------
r.get("/:id/logs", (req, res) => {
  const row = db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(req.params.id);
  if (!row || !row.logsPath) return res.status(404).json({ error: "not found" });
  if (!fs.existsSync(row.logsPath)) return res.status(200).send(""); // job started but no logs yet
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  fs.createReadStream(row.logsPath).pipe(res);
});

// ---------- OUTPUT (video with Range support) ----------
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

// ---------- Worker ----------
function runJob(id, asset, ctx) {
  const log = (s) => fs.appendFileSync(ctx.logsPath, s + "\n");
  const start = Date.now();
  db.prepare(`UPDATE jobs SET status='running', startedAt=datetime('now') WHERE id=?`).run(id);

  (async () => {
    try {
      // 1) Convert PDF->images (or copy image)
      const isPdf = (asset.type === "pdf");
      if (isPdf) {
        if (!hasCmd("pdftoppm")) throw new Error("pdftoppm not found (install poppler-utils)");
        const p1 = sh(`mkdir -p "${ctx.jobDir}" && pdftoppm -png "${asset.path}" "${ctx.jobDir}/slide"`);
        log(p1.stdout || "");
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("pdf->images failed");
      } else {
        sh(`mkdir -p "${ctx.jobDir}"`);
        const p1 = sh(`cp "${asset.path}" "${ctx.jobDir}/slide-001.png"`);
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("copy image failed");
      }

      // after the pdftoppm/copy step succeeds:
const ls = sh(`ls -l "${ctx.jobDir}" | head -n 20`);
log(ls.stdout || "");
log(ls.stderr || "");


      // 2) Extract text from PDF (if available) -> script via Ollama
      let scriptText = "";
      if (isPdf) {
        if (!hasCmd("pdftotext")) log("WARN: pdftotext not found; using fallback summary prompt.");
        let notes = "";
        if (hasCmd("pdftotext")) {
          const textPath = path.join(ctx.jobDir, "notes.txt");
          const t1 = sh(`pdftotext "${asset.path}" "${textPath}"`);
          log(t1.stderr || "");
          if (t1.status === 0 && fs.existsSync(textPath)) {
            notes = fs.readFileSync(textPath, "utf8");
          }
        }
        // Cut to ~4k chars to keep prompt small
        const excerpt = (notes || "").trim().slice(0, 4000);
        const prompt = `
You are a study coach. Turn the following lecture notes into a concise, engaging podcast script (spoken voice, first person plural, friendly but precise). Use short sentences. Avoid jargon unless necessary. 60-120 seconds total.

NOTES:
${excerpt || "(No extracted text available. Create a generic motivational study summary about the topic implied by the filename.)"}
        `.trim();

        const base = process.env.OLLAMA_BASE || "http://localhost:11434";
        const model = process.env.OLLAMA_MODEL || "llama3";
        log(`Calling Ollama at ${base} with model ${model} ...`);
        try {
          scriptText = await callOllama(prompt, { base, model });
        } catch (e) {
          log("Ollama call failed: " + e.message);
          scriptText = "Welcome to NoteFlix. This is an automatically generated study summary. Please review your notes and key definitions.";
        }
      } else {
        scriptText = "This video animates your uploaded slide. Add more pages for a richer episode.";
      }

      // Save script for reference
      const scriptPath = path.join(ctx.jobDir, "script.txt");
      fs.writeFileSync(scriptPath, scriptText, "utf8");

      // 3) Optional TTS via espeak-ng -> narration.wav (fallback to captions-only)
      let narrationPath = null;
let narrationCmd = null;

if (hasCmd("pico2wave")) {
  narrationPath = path.join(ctx.jobDir, "narration.wav");
  narrationCmd = `pico2wave -l en-US -w "${narrationPath}" ${JSON.stringify(scriptText)}`;
} else if (hasCmd("espeak-ng")) {
  narrationPath = path.join(ctx.jobDir, "narration.wav");
  narrationCmd = `espeak-ng -v en+f3 -s 170 -w "${narrationPath}" ${JSON.stringify(scriptText)}`;
}

if (narrationCmd) {
  const tts = sh(narrationCmd);
  log(tts.stderr || "");
  if (tts.status !== 0 || !fs.existsSync(narrationPath)) {
    log("WARN: TTS failed; proceeding without narration audio.");
    narrationPath = null;
  }
} else {
  log("INFO: no TTS tool found; proceeding without narration audio (captions only).");
}

const hasAudio = Boolean(narrationPath);

      // 4) Create captions.vtt from script
      const vtt = makeVttFromScript(scriptText);
      const vttPath = path.join(ctx.jobDir, "captions.vtt");
      fs.writeFileSync(vttPath, vtt, "utf8");

      // 5) Assemble slideshow with Ken Burns + captions (and audio if present)
     const vf = `zoompan=z='zoom+0.001':d=150:s=1920x1080,fps=30,subtitles='${vttPath.replace(/'/g,"\\'")}',format=yuv420p`;
const fr = 1/5;
const cmd = hasAudio
  ? `ffmpeg -y -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -i "${narrationPath}" -filter_complex "${vf}" -c:v libx264 -preset slow -crf 20 -c:a aac -b:a 192k -shortest "${ctx.outputPath}"`
  : `ffmpeg -y -framerate ${fr} -pattern_type glob -i "${ctx.jobDir}/slide-*.png" -filter_complex "${vf}" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p "${ctx.outputPath}"`;

      const enc = spawn("bash", ["-lc", cmd]);
      enc.stdout.on("data", d => log(d.toString()));
      enc.stderr.on("data", d => log(d.toString()));

      await new Promise((resolve) => enc.on("close", resolve));

      const cpuSeconds = Math.round((Date.now() - start) / 1000);
      if (!fs.existsSync(ctx.outputPath)) throw new Error("ffmpeg failed to produce output");

      db.prepare(`UPDATE jobs SET status='done', finishedAt=datetime('now'), cpuSeconds=?, outputPath=? WHERE id=?`)
        .run(cpuSeconds, ctx.outputPath, id);
      log("JOB DONE");
    } catch (err) {
      const cpuSeconds = Math.round((Date.now() - start) / 1000);
      db.prepare(`UPDATE jobs SET status='failed', finishedAt=datetime('now'), cpuSeconds=? WHERE id=?`)
        .run(cpuSeconds, id);
      log("FAILED: " + (err && err.message ? err.message : String(err)));
    }
  })();
}
