// src/routes/assets.js
"use strict";

const { Router } = require("express");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");

const {
  DDB_PK_NAME,
  sks,
  putItem,
  getItem,
  deleteItem,
  queryByPrefix,
  qutUsernameFromReqUser,
} = require("../ddb");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const ASSETS_DIR = path.join(DATA_ROOT, "assets");
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });
const r = Router();

r.post("/", upload.single("file"), async (req, res) => {
  try {
    const user = req.user;
    if (!req.file) return res.status(400).json({ error: "file required" });

    const qutUser = qutUsernameFromReqUser(user);
    const id = uuid();
    const ext = path.extname(req.file.originalname) || "";
    const dstDir = path.join(ASSETS_DIR, id);
    const dst = path.join(dstDir, `original${ext}`);
    fs.mkdirSync(dstDir, { recursive: true });
    fs.renameSync(req.file.path, dst);

    const type = ext.toLowerCase().includes(".pdf") ? "pdf" : "image";
    const now = new Date().toISOString();

    const item = {
      [DDB_PK_NAME]: qutUser,
      sk: sks.asset(id),
      entity: "asset",
      id,
      owner: user?.sub || "unknown",
      type,
      path: dst,
      meta: { originalName: req.file.originalname },
      createdAt: now,
    };
    await putItem(item);

    res.json({ id, type, path: dst });
  } catch (e) {
    console.error("assets POST failed:", e);
    res.status(500).json({ error: "upload failed" });
  }
});

// GET /assets — pagination & filtering kept similar to old API
r.get("/", async (req, res) => {
  try {
    const user = req.user;
    const qutUser = qutUsernameFromReqUser(user);
    const q = req.query || {};

    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 20));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    const type = typeof q.type === "string" && q.type.trim() ? q.type.trim().toLowerCase() : null;
    const createdAfter = q.createdAfter?.trim() || null;
    const createdBefore = q.createdBefore?.trim() || null;
    const search = q.q?.trim() || null;

    // Load all ASSET# for this user (bounded by a cap) and filter/sort in-memory
    let items = await queryByPrefix(qutUser, "ASSET#");

    // Filter
    items = items.filter((it) => it.entity === "asset");
    if (type) items = items.filter((it) => String(it.type).toLowerCase() === type);
    if (createdAfter) items = items.filter((it) => (it.createdAt || "") >= createdAfter);
    if (createdBefore) items = items.filter((it) => (it.createdAt || "") <= createdBefore);
    if (search) {
      const s = search.toLowerCase();
      items = items.filter((it) => {
        const meta = it.meta ? JSON.stringify(it.meta).toLowerCase() : "";
        return meta.includes(s) || (it.id || "").toLowerCase().includes(s);
      });
    }

    // Sort (default by createdAt desc to mirror previous)
    const allowedSort = { rowid: "sk", createdAt: "createdAt", type: "type", id: "id" };
    const sortKey = allowedSort[req.query.sort] || "createdAt";
    const orderDir = (req.query.order || "desc").toLowerCase() === "asc" ? "asc" : "desc";
    items.sort((a, b) => {
      const av = a[sortKey] ?? "";
      const bv = b[sortKey] ?? "";
      if (av < bv) return orderDir === "asc" ? -1 : 1;
      if (av > bv) return orderDir === "asc" ? 1 : -1;
      return 0;
    });

    const total = items.length;
    const totalPages = Math.ceil(total / limit);
    const paged = items.slice(offset, offset + limit);

    // header + old response shape
    res.setHeader("X-Total-Count", String(total));
    res.json({
      totalItems: total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages,
      items: paged,
    });
  } catch (e) {
    console.error("assets LIST failed:", e);
    res.status(500).json({ error: "list failed" });
  }
});

r.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    const qutUser = qutUsernameFromReqUser(user);
    const id = req.params.id;
    const item = await getItem(qutUser, sks.asset(id));
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: "read failed" });
  }
});

r.delete("/:id", async (req, res) => {
  try {
    const user = req.user;
    const qutUser = qutUsernameFromReqUser(user);
    const id = req.params.id;

    const item = await getItem(qutUser, sks.asset(id));
    if (!item) return res.status(404).json({ error: "not found" });

    await deleteItem(qutUser, sks.asset(id));
    try { fs.rmSync(path.dirname(item.path), { recursive: true, force: true }); } catch {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "delete failed" });
  }
});

module.exports = r;
