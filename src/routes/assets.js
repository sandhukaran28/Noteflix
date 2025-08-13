const { Router } = require("express");
const multer = require("multer");
const { db } = require("../db");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const ASSETS_DIR = path.join(DATA_ROOT, "assets");
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });
const r = Router();

r.post("/", upload.single("file"), (req, res) => {
  const user = req.user;
  if (!req.file) return res.status(400).json({ error: "file required" });

  const id = uuid();
  const ext = path.extname(req.file.originalname) || "";
  const dstDir = path.join(ASSETS_DIR, id);
  const dst = path.join(dstDir, `original${ext}`);
  fs.mkdirSync(dstDir, { recursive: true });
  fs.renameSync(req.file.path, dst);

  const type = ext.toLowerCase().includes(".pdf") ? "pdf" : "image";
  db.prepare(`INSERT INTO assets(id, owner, type, path, meta, createdAt)
              VALUES(?, ?, ?, ?, ?, datetime('now'))`)
    .run(id, user?.sub || "unknown", type, dst, JSON.stringify({ originalName: req.file.originalname }));

  res.json({ id, type, path: dst });
});

r.get("/", (req, res) => {
  const user = req.user;
  const rows = db.prepare(`SELECT * FROM assets WHERE owner = ? ORDER BY createdAt DESC LIMIT 50`).all(user?.sub || "unknown");
  res.json(rows);
});

r.get("/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  res.json(row);
});

r.delete("/:id", (req, res) => {
  const row = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });
  db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
  try { fs.rmSync(path.dirname(row.path), { recursive: true, force: true }); } catch {}
  res.json({ ok: true });
});

module.exports = r;
