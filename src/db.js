const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");

const DATA_ROOT = process.env.DATA_ROOT || "./data";
const DB_PATH = path.join(DATA_ROOT, "sqlite", "noteflix.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS assets(
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    type TEXT NOT NULL,
    path TEXT NOT NULL,
    meta TEXT,
    createdAt TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS jobs(
    id TEXT PRIMARY KEY,
    assetId TEXT NOT NULL,
    owner TEXT NOT NULL,
    params TEXT NOT NULL,
    status TEXT NOT NULL,
    startedAt TEXT,
    finishedAt TEXT,
    cpuSeconds INTEGER DEFAULT 0,
    outputPath TEXT,
    logsPath TEXT
  );
  CREATE TABLE IF NOT EXISTS chapters(
    id TEXT PRIMARY KEY,
    jobId TEXT NOT NULL,
    startSec REAL NOT NULL,
    endSec REAL NOT NULL,
    title TEXT NOT NULL
  );
`);

module.exports = { db };
