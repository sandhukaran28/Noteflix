// src/routes/jobs.js
"use strict";

const { Router } = require("express");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const { spawn, spawnSync } = require("child_process");
const { synthesizePodcast } = require("../utils/tts");
const { fetchWikiSummary } = require("../utils/wiki");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const {
  getJSON,
  setJSON,
  getVersion,
  bumpVersion,
  stableKeyFromObject,
} = require("../lib/cache");

const {
  DDB_PK_NAME,
  sks,
  putItem,
  getItem,
  updateItem,
  queryByPrefix,
  qutUsernameFromReqUser,
  putJobEvent,
  getJobEvents,
} = require("../ddb");

// -------------------- paths & dirs --------------------
const DATA_ROOT = process.env.DATA_ROOT || "./data";
const TMP_DIR = path.join(DATA_ROOT, "tmp");
const OUT_DIR = path.join(DATA_ROOT, "outputs");
const { pipeline } = require("stream/promises");
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-southeast-2" });
const S3_BUCKET = process.env.S3_BUCKET;
const S3_PREFIX = (process.env.S3_PREFIX || "noteflix/outputs").replace(
  /\/+$/,
  ""
);

const r = Router();

function s3KeyForJob(jobId) {
  return `${S3_PREFIX}/${jobId}/video.mp4`;
}

// -------------------- shell helpers --------------------
function sh(cmd, opts = {}) {
  return spawnSync("bash", ["-lc", cmd], { encoding: "utf8", ...opts });
}

function hasCmd(name) {
  const r = sh(`command -v ${name} || which ${name} || true`);
  return r.status === 0 && r.stdout.trim().length > 0;
}

async function downloadS3ToFile(bucket, key, toPath) {
  const resp = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key })
  );
  await pipeline(resp.Body, fs.createWriteStream(toPath));
}

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
    if (out.status === 0) return Math.ceil(parseFloat(out.stdout.trim()));
  } catch (e) {}
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

// -------------------- create job --------------------
r.post("/process", async (req, res) => {
  try {
    const user = req.user;
    const {
      assetId,
      style = "kenburns",
      duration = 90,
      dialogue = "solo",
      encodeProfile = "balanced",
    } = req.body || {};

    const qutUser = qutUsernameFromReqUser(user);

    // Load asset (from DDB)
    const asset = await getItem(qutUser, sks.asset(assetId));
    if (!asset) return res.status(400).json({ error: "invalid assetId" });

    const id = uuid();
    const jobDir = path.join(TMP_DIR, id);
    const logsPath = path.join(jobDir, "logs.txt");
    const outDir = path.join(OUT_DIR, id);
    const outputPath = path.join(outDir, "video.mp4");
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(outDir, { recursive: true });

    const now = new Date().toISOString();
    const jobItem = {
      [DDB_PK_NAME]: qutUser,
      sk: sks.job(id),
      entity: "job",
      id,
      assetId,
      owner: user?.sub || "unknown",
      params: { style, duration, dialogue, encodeProfile },
      status: "pending",
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      cpuSeconds: 0,
      outputPath: null,
      logsPath,
      s3Bucket: null,
      s3Key: null,
    };
    await putItem(jobItem);
    await bumpVersion("jobs", qutUser);

    // Audit: job created
    putJobEvent(id, qutUser, "pending", "Job created").catch(() => {});
    await bumpVersion("audit", qutUser);

    process.nextTick(() =>
      runJob(id, asset, {
        qutUser,
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
  } catch (e) {
    console.error("jobs POST /process failed:", e);
    res.status(500).json({ error: "failed to create job" });
  }
});

// -------------------- list + details --------------------
r.get("/", async (req, res) => {
  try {
    const user = req.user;
    const qutUser = qutUsernameFromReqUser(user);
    const q = req.query || {};

    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 20));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    const status =
      typeof q.status === "string" && q.status.trim() ? q.status.trim() : null;
    const assetId = q.assetId?.trim() || null;
    const startedAfter = q.startedAfter?.trim() || null;
    const finishedBefore = q.finishedBefore?.trim() || null;

    // ---- cache first
    const ver = await getVersion("jobs", qutUser);
    const listKey = `jobs:list:${qutUser}:v${ver}:${stableKeyFromObject({
      limit,
      offset,
      status,
      assetId,
      startedAfter,
      finishedBefore,
      sort: q.sort,
      order: q.order,
    })}`;
    const cached = await getJSON(listKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      res.setHeader("X-Total-Count", String(cached.totalItems ?? 0));
      return res.json(cached);
    }

    let items = await queryByPrefix(qutUser, "JOB#");
    items = items.filter((it) => it.entity === "job");

    // Filters
    if (status) items = items.filter((it) => it.status === status);
    if (assetId) items = items.filter((it) => it.assetId === assetId);
    if (startedAfter)
      items = items.filter((it) => (it.startedAt || "") >= startedAfter);
    if (finishedBefore)
      items = items.filter((it) => (it.finishedAt || "") <= finishedBefore);

    // Sorting (mirror old behavior)
    const allowedFields = ["rowid", "createdAt", "startedAt", "finishedAt"];
    let sortParam = (q.sort || "").toString().trim();
    let requestedField = sortParam || "createdAt";
    let dirFromSort = "";

    if (sortParam.includes(":")) {
      const [f, d] = sortParam.split(":");
      requestedField = (f || "").trim() || "createdAt";
      dirFromSort = (d || "").trim();
    }
    const orderDir =
      (dirFromSort || q.order || "desc").toLowerCase() === "asc"
        ? "asc"
        : "desc";

    let sortField = "createdAt";
    if (requestedField === "rowid") sortField = "sk";
    else if (allowedFields.includes(requestedField)) sortField = requestedField;

    items.sort((a, b) => {
      const av = a[sortField] ?? "";
      const bv = b[sortField] ?? "";
      if (av < bv) return orderDir === "asc" ? -1 : 1;
      if (av > bv) return orderDir === "asc" ? 1 : -1;
      return 0;
    });

    const total = items.length;
    const totalPages = Math.ceil(total / limit);
    const paged = items.slice(offset, offset + limit);

    const payload = {
      totalItems: total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages,
      items: paged,
    };

    await setJSON(listKey, payload, 60);
    res.setHeader("X-Total-Count", String(total));
    res.setHeader("X-Cache", "MISS");
    res.json(payload);
  } catch (e) {
    console.error("jobs LIST failed:", e);
    res.status(500).json({ error: "list failed" });
  }
});

r.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    const qutUser = qutUsernameFromReqUser(user);

    const ver = await getVersion("jobs", qutUser);
    const key = `jobs:detail:${qutUser}:v${ver}:${req.params.id}`;

    let row = await getJSON(key);
    if (!row) {
      row = await getItem(qutUser, sks.job(req.params.id));
      if (row) await setJSON(key, row, 60);
      res.setHeader("X-Cache", "MISS");
    } else {
      res.setHeader("X-Cache", "HIT");
    }

    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (e) {
    res.status(500).json({ error: "read failed" });
  }
});

// ---- audit (DynamoDB) ----
r.get("/:id/audit", async (req, res) => {
  try {
    const qutUser = qutUsernameFromReqUser(req.user);

    const ver = await getVersion("audit", qutUser);
    const key = `jobs:audit:${qutUser}:v${ver}:${req.params.id}`;

    let payload = await getJSON(key);
    if (!payload) {
      const items = await getJobEvents(req.params.id, qutUser);
      payload = { items };
      await setJSON(key, payload, 30);
      res.setHeader("X-Cache", "MISS");
    } else {
      res.setHeader("X-Cache", "HIT");
    }

    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: "audit read failed" });
  }
});

// -------------------- logs --------------------
r.get("/:id/logs", async (req, res) => {
  const qutUser = qutUsernameFromReqUser(req.user);
  const row = await getItem(qutUser, sks.job(req.params.id));
  if (!row || !row.logsPath)
    return res.status(404).json({ error: "not found" });
  if (!fs.existsSync(row.logsPath)) return res.status(200).send("");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  fs.createReadStream(row.logsPath).pipe(res);
});

// -------------------- output (Download) --------------------
r.get("/:id/output", async (req, res) => {
  const qutUser = qutUsernameFromReqUser(req.user);
  const row = await getItem(qutUser, sks.job(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });

  const bucket = row.s3Bucket || process.env.S3_BUCKET;
  const key = row.s3Key || s3KeyForJob(row.id);

  if (bucket && key) {
    try {
      const url = await getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ResponseContentDisposition: 'attachment; filename="video.mp4"',
        }),
        { expiresIn: 900 }
      );
      return res.redirect(302, url);
    } catch (e) {
      console.warn("S3 presign failed:", e.message);
      // fall back to local path
    }
  }

  if (!row.outputPath || !fs.existsSync(row.outputPath)) {
    return res.status(404).json({ error: "not found" });
  }
  const stat = fs.statSync(row.outputPath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Disposition", 'attachment; filename="video.mp4"');
  res.setHeader("Accept-Ranges", "bytes");

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) return res.status(416).end();
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (isNaN(start) || isNaN(end) || start > end || end >= stat.size)
      return res.status(416).end();
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(row.outputPath, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", String(stat.size));
    fs.createReadStream(row.outputPath).pipe(res);
  }
});

// -------------------- captions --------------------
r.get("/:id/captions", async (req, res) => {
  const qutUser = qutUsernameFromReqUser(req.user);
  const row = await getItem(qutUser, sks.job(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  const jobDir = row.logsPath ? path.dirname(row.logsPath) : null;
  if (!jobDir) return res.status(404).json({ error: "not found" });

  const vttPath = path.join(jobDir, "captions.vtt");
  if (!fs.existsSync(vttPath))
    return res.status(404).json({ error: "no captions" });

  res.setHeader("Content-Type", "text/vtt; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=captions.vtt");
  fs.createReadStream(vttPath).pipe(res);
});

// -------------------- script --------------------
r.get("/:id/script", async (req, res) => {
  const qutUser = qutUsernameFromReqUser(req.user);
  const row = await getItem(qutUser, sks.job(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  const jobDir = row.logsPath ? path.dirname(row.logsPath) : null;
  if (!jobDir) return res.status(404).json({ error: "not found" });

  const scriptPath = path.join(jobDir, "script.txt");
  if (!fs.existsSync(scriptPath))
    return res.status(404).json({ error: "no script" });

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=script.txt");
  fs.createReadStream(scriptPath).pipe(res);
});

// -------------------- metrics --------------------
r.get("/:id/metrics", async (req, res) => {
  const qutUser = qutUsernameFromReqUser(req.user);
  const row = await getItem(qutUser, sks.job(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  const jobDir = row.logsPath ? path.dirname(row.logsPath) : null;
  if (!jobDir) return res.status(404).json({ error: "not found" });

  const metricsPath = path.join(jobDir, "metrics.json");
  if (!fs.existsSync(metricsPath))
    return res.status(404).json({ error: "no metrics" });

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  fs.createReadStream(metricsPath).pipe(res);
});

module.exports = r;

// -------------------- worker --------------------
async function runJob(id, asset, ctx) {
  const log = (s) => fs.appendFileSync(ctx.logsPath, s + "\n");
  const start = Date.now();

  // mark running
  await updateItem(
    ctx.qutUser,
    sks.job(id),
    "SET #status = :s, #startedAt = :t",
    { "#status": "status", "#startedAt": "startedAt" },
    { ":s": "running", ":t": new Date().toISOString() }
  );
  await bumpVersion("jobs", ctx.qutUser);

  // Audit: running
  putJobEvent(id, ctx.qutUser, "running", "Processing started").catch(() => {});
  await bumpVersion("audit", ctx.qutUser);

  (async () => {
    try {
      // 1) PDF -> images (or copy single image)
      // 1) Materialize source file (from S3 or local legacy) → then PDF->images or copy image
      const jobDir = ctx.jobDir;
      fs.mkdirSync(jobDir, { recursive: true });

      // decide where to read from
      let sourcePath; // the local, materialized file we will use
      let isPdf;

      // Prefer S3 pointers (new stateless flow)
      if (asset.s3Bucket && asset.s3Key) {
        // infer extension/type
        const ext = path.extname(asset.s3Key || "").toLowerCase();
        isPdf = asset.type === "pdf" || ext === ".pdf";
        sourcePath = path.join(
          jobDir,
          "source" + (ext || (isPdf ? ".pdf" : ""))
        );

        // download to tmp
        await downloadS3ToFile(asset.s3Bucket, asset.s3Key, sourcePath);
      } else {
        // legacy/local path fallback (for old data)
        if (!asset.path)
          throw new Error("asset has no s3Key and no local path");
        sourcePath = asset.path;
        const ext = path.extname(sourcePath || "").toLowerCase();
        isPdf = asset.type === "pdf" || ext === ".pdf";
      }

      if (isPdf) {
        if (!hasCmd("pdftoppm"))
          throw new Error("pdftoppm not found (install poppler-utils)");
        const p1 = sh(`pdftoppm -png "${sourcePath}" "${jobDir}/slide"`);
        log(p1.stdout || "");
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("pdf->images failed");
      } else {
        const slide1 = path.join(jobDir, "slide-001.png");
        // If source is already a PNG/JPG, let ffmpeg read it as PNG—cp is fine
        const p1 = sh(`cp "${sourcePath}" "${slide1}"`);
        log(p1.stderr || "");
        if (p1.status !== 0) throw new Error("copy image failed");
      }

      // visibility for debugging
      const ls = sh(`ls -l "${jobDir}" | head -n 40`);
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
          const t1 = sh(`pdftotext "${sourcePath}" "${textPath}"`);

          log(t1.stderr || "");
          if (t1.status === 0 && fs.existsSync(textPath)) {
            notes = fs.readFileSync(textPath, "utf8");
          }
        }

        const wpm = 150;
        const targetSeconds = Math.max(
          30,
          Math.min(600, Number(ctx.duration || 90))
        );
        const targetWords = Math.round((wpm / 60) * targetSeconds);

        const duet = ctx.dialogue === "duet";
        const excerpt = (notes || "").trim().slice(0, 4000);

        let wiki = null;
        try {
          const orig = (() => {
            try {
              const meta = asset.meta || {};
              return (meta.originalName || "").replace(/\.[^.]+$/, "");
            } catch {
              return "";
            }
          })();
          if (excerpt.length < 120 && orig) {
            wiki = await fetchWikiSummary(orig);
          }
        } catch {}

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
- Keep it grounded in the NOTES content. If missing, you MAY use WIKI if provided.
- Do NOT include stage directions, timecodes, or markdown—just the spoken lines.

NOTES:
${excerpt || "(No extracted text available.)"}

${wiki ? `WIKI:\n${wiki}\n` : ""}`.trim();

        const base = process.env.OLLAMA_BASE || "http://localhost:11434";
        const model = process.env.OLLAMA_MODEL || "llama3";
        log(`Calling Ollama at ${base} with model ${model} ...`);
        try {
          // const resp = await callOllama(prompt, { base, model });
          // scriptText = resp;
          scriptText =
            "This video animates your uploaded slide. Add more pages for a richer episode.";
        } catch (e) {
          log("Ollama call failed: " + e.message);
          scriptText =
            "Welcome to NoteFlix. This is an automatically generated study summary. Please review your notes and key definitions.";
        }
      } else {
        scriptText =
          "This video animates your uploaded slide. Add more pages for a richer episode.";
      }

      const scriptPath = path.join(ctx.jobDir, "script.txt");
      fs.writeFileSync(scriptPath, scriptText, "utf8");

      // 3) TTS
      log("Cleaning script for TTS...");
      const cleaned = cleanForTTS(scriptText);

      let scriptLines;
      if (ctx.dialogue === "duet") {
        const labeled = cleaned
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean);
        const hasLabels = labeled.some((l) => /^alex:|^sam:/i.test(l));
        scriptLines = hasLabels
          ? labeled.map((l) => l.replace(/^(alex|sam):\s*/i, ""))
          : cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
      } else {
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
          voiceA:
            process.env.PIPER_VOICE_A || "/app/models/en_US-amy-medium.onnx",
          voiceB:
            process.env.PIPER_VOICE_B || "/app/models/en_US-ryan-high.onnx",
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

      // 5) encoding
      const slides = fs
        .readdirSync(ctx.jobDir)
        .filter((f) => /^slide-.*\.png$/i.test(f))
        .sort();
      const nSlides = Math.max(1, slides.length);

      let totalDuration = ctx.duration || 90;
      if (hasAudio) {
        const dur = getAudioDuration(narrationPath);
        if (dur && dur > 0) {
          totalDuration = dur;
          log(`Detected narration length: ${dur}s`);
        }
      }

      const profile = String(ctx.encodeProfile || "balanced").toLowerCase();
      const perSlideSec = Math.max(4, Math.round(totalDuration / nSlides));
      const baseFps = profile === "insane" ? 60 : profile === "heavy" ? 48 : 30;
      const dFrames = perSlideSec * baseFps;
      const fr = 1 / perSlideSec;

      const outW =
        profile === "insane" ? 3840 : profile === "heavy" ? 2560 : 1920;
      const outH =
        profile === "insane" ? 2160 : profile === "heavy" ? 1440 : 1080;

      const zoom = `zoompan=z='zoom+0.001':d=${dFrames}:s=${outW}x${outH}`;
      const baseFilters = [
        zoom,
        `scale=${outW}:${outH}:flags=lanczos`,
        `unsharp=5:5:0.5:5:5:0.5`,
        `eq=contrast=1.05:brightness=0.02:saturation=1.05`,
        `vignette=PI/6`,
      ];
      if (profile !== "balanced") {
        baseFilters.push(
          `minterpolate='mi_mode=mci:mc_mode=aobmc:vsbmc=1:fps=${baseFps}'`
        );
      }
      baseFilters.push(`format=yuv420p`);
      const vf = baseFilters.join(",");
      const af = hasAudio
        ? `-ar 48000 -af "loudnorm=I=-16:LRA=11:TP=-1.5"`
        : "";

      const preset =
        profile === "insane"
          ? "veryslow"
          : profile === "heavy"
          ? "slower"
          : "slow";
      const crf = profile === "insane" ? 16 : profile === "heavy" ? 18 : 20;

      if (profile !== "balanced") {
        const passlog = path.join(ctx.jobDir, "ffpass");
        const cmd1 = `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${
          ctx.jobDir
        }/slide-*.png" ${
          hasAudio ? `-i "${narrationPath}"` : ""
        } -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p -an -pass 1 -passlogfile "${passlog}" -f mp4 /dev/null`;
        log("ENC PASS1: " + cmd1);
        const enc1 = spawn("bash", ["-lc", cmd1]);
        enc1.stdout.on("data", (d) => log(d.toString()));
        enc1.stderr.on("data", (d) => log(d.toString()));
        await new Promise((resolve) => enc1.on("close", resolve));

        const cmd2 = `ffmpeg -y -threads 0 -framerate ${fr} -pattern_type glob -i "${
          ctx.jobDir
        }/slide-*.png" ${
          hasAudio ? `-i "${narrationPath}"` : ""
        } -filter_complex "${vf}" -c:v libx264 -preset ${preset} -crf ${crf} -pix_fmt yuv420p ${
          hasAudio ? `${af} -c:a aac -b:a 192k` : ""
        } -movflags +faststart -shortest -pass 2 -passlogfile "${passlog}" "${
          ctx.outputPath
        }"`;
        log("ENC PASS2: " + cmd2);
        const enc2 = spawn("bash", ["-lc", cmd2]);
        enc2.stdout.on("data", (d) => log(d.toString()));
        enc2.stderr.on("data", (d) => log(d.toString()));
        await new Promise((resolve) => enc2.on("close", resolve));
      } else {
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

      try {
        const outputStat = fs.statSync(ctx.outputPath);
        const metrics = {
          durationSeconds: totalDuration,
          slides: nSlides,
          fpsTarget: baseFps,
          resolution: { width: outW, height: outH },
          profile,
          hasAudio: !!hasAudio,
          audioSeconds: hasAudio ? getAudioDuration(narrationPath) : 0,
          cpuSeconds,
          outputBytes: outputStat?.size || 0,
        };
        fs.writeFileSync(
          path.join(ctx.jobDir, "metrics.json"),
          JSON.stringify(metrics, null, 2)
        );
      } catch (e) {
        log("WARN: failed to write metrics.json: " + e.message);
      }

      // Upload to S3 (if configured)
      let uploaded = false;
      let s3Key = null;
      if (S3_BUCKET) {
        try {
          s3Key = s3KeyForJob(id);
          log(`Uploading output to s3://${S3_BUCKET}/${s3Key} ...`);
          await s3.send(
            new PutObjectCommand({
              Bucket: S3_BUCKET,
              Key: s3Key,
              Body: fs.createReadStream(ctx.outputPath),
              ContentType: "video/mp4",
              ContentDisposition: 'attachment; filename="video.mp4"',
            })
          );
          uploaded = true;
          await updateItem(
            ctx.qutUser,
            sks.job(id),
            "SET #s3Bucket = :b, #s3Key = :k",
            { "#s3Bucket": "s3Bucket", "#s3Key": "s3Key" },
            { ":b": S3_BUCKET, ":k": s3Key }
          );
          log("S3 upload complete");
        } catch (e) {
          log("WARN: S3 upload failed: " + (e.message || String(e)));
        }
      }

      // Finalize
      await updateItem(
        ctx.qutUser,
        sks.job(id),
        "SET #status=:st, #finishedAt=:fin, #cpuSeconds=:cpu, #outputPath=:out",
        {
          "#status": "status",
          "#finishedAt": "finishedAt",
          "#cpuSeconds": "cpuSeconds",
          "#outputPath": "outputPath",
        },
        {
          ":st": "done",
          ":fin": new Date().toISOString(),
          ":cpu": Math.round((Date.now() - start) / 1000),
          ":out": ctx.outputPath,
        }
      );
      await bumpVersion("jobs", ctx.qutUser);

      // Audit: done
      putJobEvent(
        id,
        ctx.qutUser,
        "done",
        uploaded ? "Encoding complete (uploaded to S3)" : "Encoding complete"
      ).catch(() => {});
      await bumpVersion("audit", ctx.qutUser);

      log("JOB DONE" + (uploaded ? " (and uploaded to S3)" : ""));
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      await updateItem(
        ctx.qutUser,
        sks.job(id),
        "SET #status=:st, #finishedAt=:fin, #cpuSeconds=:cpu",
        {
          "#status": "status",
          "#finishedAt": "finishedAt",
          "#cpuSeconds": "cpuSeconds",
        },
        {
          ":st": "failed",
          ":fin": new Date().toISOString(),
          ":cpu": Math.round((Date.now() - start) / 1000),
        }
      );
      await bumpVersion("jobs", ctx.qutUser);
      putJobEvent(id, ctx.qutUser, "failed", msg).catch(() => {});
      await bumpVersion("audit", ctx.qutUser);
      log("FAILED: " + msg);
    }
  })();
}
