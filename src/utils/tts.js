// utils/tts.js
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function sh(cmd) {
  return spawnSync("bash", ["-lc", cmd], { encoding: "utf8" });
}

function hasCmd(name) {
  const r = sh(`command -v ${name} || which ${name} || true`);
  return r.status === 0 && r.stdout.trim().length > 0;
}

const PIPER_BIN = process.env.PIPER_BIN || "piper";

/**
 * scriptLines: array of strings...
 */
async function synthesizePodcast(scriptLines, outPath, isDuet, voices = {}) {
  if (!hasCmd(PIPER_BIN)) {
    throw new Error(`${PIPER_BIN} not found. Install Piper TTS and/or set PIPER_BIN`);
  }
  const { voiceA, voiceB } = voices;
  if (!voiceA) throw new Error("voices.voiceA is required (path to .onnx)");
  if (isDuet && !voiceB) throw new Error("voices.voiceB is required (path to .onnx)");

  const tmpDir = path.join(path.dirname(outPath), "piper_tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  const parts = [];
  for (let i = 0; i < scriptLines.length; i++) {
    const line = scriptLines[i].trim();
    if (!line) continue;

    const which = isDuet ? (i % 2 === 0 ? "A" : "B") : "A";
    const model = which === "A" ? voices.voiceA : (voices.voiceB || voices.voiceA);

    const txt = path.join(tmpDir, `seg-${String(i+1).padStart(3,"0")}.txt`);
    const wav = path.join(tmpDir, `seg-${String(i+1).padStart(3,"0")}.wav`);
    fs.writeFileSync(txt, line + "\n", "utf8");

    const cmd = `${PIPER_BIN} --model "${model}" --input_file "${txt}" --output_file "${wav}" --sentence_silence 0.15`;
    const r = sh(cmd);
    if (r.status !== 0 || !fs.existsSync(wav)) {
      throw new Error(`piper failed for segment ${i+1}: ${r.stderr || r.stdout}`);
    }
    parts.push(wav);

    const pad = path.join(tmpDir, `sil-${String(i+1).padStart(3,"0")}.wav`);
    sh(`ffmpeg -y -f lavfi -i anullsrc=r=44100:cl=mono -t 0.20 "${pad}" >/dev/null 2>&1`);
    parts.push(pad);
  }

  const concatList = path.join(tmpDir, "concat.txt");
  fs.writeFileSync(concatList, parts.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");

  const r2 = sh(`ffmpeg -y -f concat -safe 0 -i "${concatList}" -ar 44100 -ac 1 -c:a pcm_s16le "${outPath}"`);
  if (r2.status !== 0 || !fs.existsSync(outPath)) {
    throw new Error(`ffmpeg concat failed: ${r2.stderr || r2.stdout}`);
  }
  return outPath;
}

module.exports = { synthesizePodcast };
