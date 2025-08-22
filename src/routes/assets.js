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

// UPDATED: pagination + filtering + optional sorting
r.get("/", (req, res) => {
  const user = req.user;
  const q = req.query || {};

  const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 20));
  const offset = Math.max(0, parseInt(q.offset, 10) || 0);

  const type = typeof q.type === "string" && q.type.trim() ? q.type.trim().toLowerCase() : null;
  const createdAfter = q.createdAfter?.trim() || null;
  const createdBefore = q.createdBefore?.trim() || null;
  const search = q.q?.trim() || null;

  const allowedSort = { rowid: "rowid", createdAt: "createdAt", type: "type", id: "id" };
  const sortKey = allowedSort[q.sort] || "createdAt";
  const orderDir = (q.order || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

  const where = ["owner = @owner"];
  const params = { owner: user?.sub || "unknown" };
  if (type) { where.push("type = @type"); params.type = type; }
  if (createdAfter) { where.push("datetime(createdAt) >= datetime(@createdAfter)"); params.createdAfter = createdAfter; }
  if (createdBefore) { where.push("datetime(createdAt) <= datetime(@createdBefore)"); params.createdBefore = createdBefore; }
  if (search) { where.push("meta LIKE @search"); params.search = `%${search}%`; }

  const whereSql = where.join(" AND ");
  const countRow = db.prepare(`SELECT COUNT(*) as cnt FROM assets WHERE ${whereSql}`).get(params);
  const total = countRow?.cnt || 0;
  const totalPages = Math.ceil(total / limit);

  params.limit = limit;
  params.offset = offset;

  const rows = db.prepare(
    `SELECT * FROM assets
     WHERE ${whereSql}
     ORDER BY ${sortKey} ${orderDir}
     LIMIT @limit OFFSET @offset`
  ).all(params);

  // headers for clients that expect them
  res.setHeader("X-Total-Count", String(total));

  res.json({
    totalItems: total,
    page: Math.floor(offset / limit) + 1,
    pageSize: limit,
    totalPages,
    items: rows
  });
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
