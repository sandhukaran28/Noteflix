// src/routes/assets.js (S3 + DynamoDB; no local persistence)
"use strict";

const { Router } = require("express");
const multer = require("multer");
const { v4: uuid } = require("uuid");
const path = require("path");
const fs = require("fs");
const {
  getJSON, setJSON, getVersion, bumpVersion, stableKeyFromObject,
} = require("../lib/cache");
const {
  DDB_PK_NAME, sks, putItem, getItem, deleteItem, queryByPrefix, qutUsernameFromReqUser, scanBySkPrefix,
} = require("../ddb");
const { isAdmin, requireGroup } = require("../middleware/auth");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const upload = multer({ dest: path.join(DATA_ROOT, "tmp") });
const r = Router();

// --- S3 setup ---
const AWS_REGION = process.env.AWS_REGION || "ap-southeast-2";
const ASSETS_BUCKET = process.env.S3_BUCKET;                    // REQUIRED
const ASSETS_PREFIX = (process.env.ASSETS_PREFIX || "noteflix/assets").replace(/\/+$/,"");
// if (!ASSETS_BUCKET) throw new Error("ASSETS_BUCKET env is required");

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const s3 = new S3Client({ region: AWS_REGION });

function coerceAs(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (/@qut\.edu\.au$/.test(s)) return s;
  if (/^[a-z]\d{7,8}$/.test(s)) return `${s}@qut.edu.au`;
  return null;
}

// POST /assets — upload to S3, record pointer in DynamoDB
r.post("/", upload.single("file"), async (req, res) => {
  try {
    const user = req.user;
    if (!req.file) return res.status(400).json({ error: "file required" });

    let qutUser = qutUsernameFromReqUser(user);     // CAB432 PK value
    const asOverride = (req.query.as || req.body?.as || "").toString().trim();
    if (asOverride && isAdmin(req)) {
      const coerced = coerceAs(asOverride);
      if (coerced) qutUser = coerced;
    }
    const id = uuid();
    const ext = path.extname(req.file.originalname) || "";
    const key = `${ASSETS_PREFIX}/${id}/original${ext}`;
    const type = ext.toLowerCase().includes(".pdf") ? "pdf" : "image";
    const now = new Date().toISOString();

    // Upload the temp file to S3
    await s3.send(new PutObjectCommand({
      Bucket: ASSETS_BUCKET,
      Key: key,
      Body: fs.createReadStream(req.file.path),
      ContentType: req.file.mimetype || (type === "pdf" ? "application/pdf" : "application/octet-stream"),
      Metadata: { "original-name": req.file.originalname },
    }));
    // cleanup temp file
    try { fs.unlinkSync(req.file.path); } catch {}

    // Store metadata ONLY (no local path) in DynamoDB
    const item = {
      [DDB_PK_NAME]: qutUser,
      sk: sks.asset(id),
      entity: "asset",
      id,
      owner: user?.sub || "unknown",
      type,
      s3Bucket: ASSETS_BUCKET,
      s3Key: key,
      meta: { originalName: req.file.originalname },
      createdAt: now,
    };
    await putItem(item);
    await bumpVersion("assets", qutUser);

    res.json({ id, type, s3Bucket: ASSETS_BUCKET, s3Key: key, createdAt: now });
  } catch (e) {
    console.error("assets POST failed:", e);
    res.status(500).json({ error: "upload failed" });
  }
});

// GET /assets — same pagination/filtering, admin can view all with ?all=1
r.get("/", async (req, res) => {
  try {
    const user = req.user;
    let qutUser = qutUsernameFromReqUser(user);
    const q = req.query || {};

    if (q.as && isAdmin(req)) {
      const coerced = coerceAs(q.as);
      if (coerced) qutUser = coerced;
    }

    const limit = Math.max(1, Math.min(100, parseInt(q.limit, 10) || 20));
    const offset = Math.max(0, parseInt(q.offset, 10) || 0);

    const type = typeof q.type === "string" && q.type.trim() ? q.type.trim().toLowerCase() : null;
    const createdAfter = q.createdAfter?.trim() || null;
    const createdBefore = q.createdBefore?.trim() || null;
    const search = q.q?.trim() || null;

    const adminAll = isAdmin(req) && String(q.all || "").toLowerCase() === "1";
    const ver = await getVersion("assets", qutUser);
    const listKey = adminAll
      ? null
      : `assets:list:${qutUser}:v${ver}:${stableKeyFromObject({
          limit, offset, type, createdAfter, createdBefore, q: search, sort: q.sort, order: q.order,
        })}`;
    if (listKey) {
      const cached = await getJSON(listKey);
      if (cached) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("X-Total-Count", String(cached.totalItems ?? 0));
        return res.json(cached);
      }
    }

    let items = adminAll ? await scanBySkPrefix("ASSET#") : await queryByPrefix(qutUser, "ASSET#");
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

    res.setHeader("X-Total-Count", String(total));
    const payload = {
      totalItems: total,
      page: Math.floor(offset / limit) + 1,
      pageSize: limit,
      totalPages,
      items: paged,
    };
    if (listKey) await setJSON(listKey, payload, 120);
    res.setHeader("X-Cache", listKey ? "MISS" : "BYPASS");
    if (!listKey) res.setHeader("X-Admin-All", "1");
    res.json(payload);
  } catch (e) {
    console.error("assets LIST failed:", e);
    res.status(500).json({ error: "list failed" });
  }
});

r.get("/:id", async (req, res) => {
  try {
    const user = req.user;
    let qutUser = qutUsernameFromReqUser(user);
    const asOverride = (req.query.as || "").toString().trim();
    if (asOverride && isAdmin(req)) {
      const coerced = coerceAs(asOverride);
      if (coerced) qutUser = coerced;
    }
    const id = req.params.id;
    const ver = await getVersion("assets", qutUser);
    const key = `assets:detail:${qutUser}:v${ver}:${id}`;
    let item = await getJSON(key);
    if (!item) {
      item = await getItem(qutUser, sks.asset(id));
      if (item) await setJSON(key, item, 120);
    } else {
      res.setHeader("X-Cache", "HIT");
    }
    if (!item) return res.status(404).json({ error: "not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: "read failed" });
  }
});

r.delete("/:id", requireGroup(process.env.COGNITO_ADMIN_GROUP || "Admin"), async (req, res) => {
  try {
    const user = req.user;
    let qutUser = qutUsernameFromReqUser(user);
    const asOverride = (req.query.as || "").toString().trim();
    if (asOverride && isAdmin(req)) {
      const coerced = coerceAs(asOverride);
      if (coerced) qutUser = coerced;
    }
    const id = req.params.id;

    const item = await getItem(qutUser, sks.asset(id));
    if (!item) return res.status(404).json({ error: "not found" });

    // delete from S3 first (best-effort)
    try {
      if (item.s3Bucket && item.s3Key) {
        await s3.send(new DeleteObjectCommand({ Bucket: item.s3Bucket, Key: item.s3Key }));
      }
    } catch (_) {}

    // remove the DynamoDB record
    await deleteItem(qutUser, sks.asset(id));
    await bumpVersion("assets", qutUser);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "delete failed" });
  }
});

module.exports = r;
