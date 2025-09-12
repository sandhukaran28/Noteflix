// lib/cache.js
"use strict";

/**
 * Production: Redis/ElastiCache (set REDIS_URL or REDIS_HOST/PORT)
 * Dev fallback: in-process Map with TTL.
 */
const Redis = require("ioredis");

const hasUrl = !!process.env.REDIS_URL;
const hasHost = !!process.env.REDIS_HOST;
const useRedis = hasUrl || hasHost;

let redis = null;
if (useRedis) {
  redis = hasUrl
    ? new Redis(
        process.env.REDIS_URL,
        process.env.REDIS_TLS === "1" ? { tls: {} } : {}
      )
    : new Redis({
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT || 6379),
        ...(process.env.REDIS_TLS === "1" ? { tls: {} } : {}),
      });
  redis.on("error", (e) => console.warn("[cache] Redis error:", e.message));
}

const mem = new Map(); // key -> { val: any, exp: number|null }
const now = () => Math.floor(Date.now() / 1000);

function memGetRaw(k) {
  const e = mem.get(k);
  if (!e) return null;
  if (e.exp && e.exp <= now()) {
    mem.delete(k);
    return null;
  }
  return e.val;
}
function memSetRaw(k, v, ttlSec) {
  mem.set(k, { val: v, exp: ttlSec ? now() + ttlSec : null });
}
function memDel(k) {
  mem.delete(k);
}

const NS = (k) => `nf:${k}`;

// --------- JSON helpers ---------
async function getJSON(key) {
  const K = NS(key);
  if (redis) {
    const v = await redis.get(K);
    return v ? JSON.parse(v) : null;
  }
  const v = memGetRaw(K);
  return v ?? null;
}

async function setJSON(key, value, ttlSec = 120) {
  const K = NS(key);
  if (redis) {
    if (ttlSec)
      return void (await redis.set(K, JSON.stringify(value), "EX", ttlSec));
    return void (await redis.set(K, JSON.stringify(value)));
  }
  memSetRaw(K, value, ttlSec);
}

async function del(key) {
  const K = NS(key);
  if (redis) await redis.del(K);
  else memDel(K);
}

// --------- versioned busting (no TTL) ---------
async function getVersion(bucket, user) {
  const K = NS(`ver:${bucket}:${user}`);
  if (redis) {
    let v = await redis.get(K);
    if (!v) {
      await redis.set(K, "1");
      return 1;
    }
    return Number(v) || 1;
  }
  let v = memGetRaw(K);
  if (!v) {
    memSetRaw(K, 1, null);
    return 1;
  }
  return Number(v) || 1;
}

async function bumpVersion(bucket, user) {
  const K = NS(`ver:${bucket}:${user}`);
  if (redis) return await redis.incr(K);
  let v = Number(memGetRaw(K) || 1) + 1;
  memSetRaw(K, v, null);
  return v;
}

// --------- stable key for query objects ---------
function stableKeyFromObject(obj) {
  const keys = Object.keys(obj || {}).sort();
  const parts = [];
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${Array.isArray(v) ? v.join(",") : String(v)}`);
  }
  return parts.join("&");
}

module.exports = {
  // JSON cache
  getJSON,
  setJSON,
  del,

  // versions
  getVersion,
  bumpVersion,

  // utils
  stableKeyFromObject,
};
