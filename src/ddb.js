// ddb.js
"use strict";

// ---- DynamoDB (shared) ----
const { DynamoDBClient } = require("@aws-sdk/client-dynamodb");
const {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand, 
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  ScanCommand,
} = require("@aws-sdk/lib-dynamodb");

// Table & partition-key policy (CAB432)
const DDB_TABLE = process.env.DDB_TABLE || "n11845619-noteflix";
const DDB_PK_NAME = "qut-username";

const ddbClient = new DynamoDBClient({
  region: process.env.AWS_REGION || "ap-southeast-2",
  ...(process.env.DDB_LOCAL_ENDPOINT ? { endpoint: process.env.DDB_LOCAL_ENDPOINT } : {}),
});
const ddb = DynamoDBDocumentClient.from(ddbClient);

// Helper: derive the QUT username for the PK value
// src/lib/config.js must export getConfig()
const { getConfig } = require("./lib/config");

// Replace in ddb.js

function coerceQutEmail(raw) {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();

  // already a QUT email
  if (/@qut\.edu\.au$/.test(s)) return s;

  // short id like n1234567 or e12345678 -> add domain
  if (/^[a-z]\d{7,8}$/.test(s)) return `${s}@qut.edu.au`;

  return null; // not acceptable for CAB432 DDB PK
}

function qutUsernameFromReqUser(user) {
  // 1) Prefer request-scoped identity claims
  const candidates = [
    user?.email,                    // best if it's ...@qut.edu.au
    user?.["custom:qut_username"],  // if you collected it once for Gmail users
    user?.qut_username,
    user?.preferred_username,
    user?.username,
    user?.["cognito:username"],
  ].filter(Boolean);

  for (const c of candidates) {
    const coerced = coerceQutEmail(c);
    if (coerced) return coerced;
  }

  // 2) Default fallback: environment variable (DEV/marking convenience)
  if (process.env.QUT_USERNAME) {
    const dev = coerceQutEmail(process.env.QUT_USERNAME);
    if (dev) return dev;
  }

  // 3) No acceptable value -> block (CAB432 requires QUT email as PK)
  throw new Error(
    "QUT username required. Provide a @qut.edu.au email or a short ID like n1234567 " +
    "(set custom:qut_username or QUT_USERNAME env for dev)."
  );
}

// ---------- Generic single-table helpers (PK = username; SK = namespaced) ----------
const sks = {
  asset: (id) => `ASSET#${id}`,
  job:   (id) => `JOB#${id}`,
  chap:  (jobId, id) => `CHAP#${jobId}#${id}`,
};

async function putItem(item) {
  await ddb.send(new PutCommand({ TableName: DDB_TABLE, Item: item }));
}

async function getItem(pk, sk) {
  const out = await ddb.send(new GetCommand({
    TableName: DDB_TABLE,
    Key: { [DDB_PK_NAME]: pk, sk },
  }));
  return out.Item || null;
}

async function updateItem(pk, sk, expr, names, values) {
  await ddb.send(new UpdateCommand({
    TableName: DDB_TABLE,
    Key: { [DDB_PK_NAME]: pk, sk },
    UpdateExpression: expr,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  }));
}

async function deleteItem(pk, sk) {
  await ddb.send(new DeleteCommand({
    TableName: DDB_TABLE,
    Key: { [DDB_PK_NAME]: pk, sk },
  }));
}

/**
 * Query all items for a user with an SK prefix, supports full scan pagination.
 * We load up to `hardCap` items (default 5000) then paginate/sort in memory
 * to preserve your existing API response shape (totalItems, totalPages, etc.).
 */
async function queryByPrefix(pk, skPrefix, { hardCap = 5000 } = {}) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new QueryCommand({
      TableName: DDB_TABLE,
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#pk": DDB_PK_NAME, "#sk": "sk" },
      ExpressionAttributeValues: { ":pk": pk, ":p": skPrefix },
      ExclusiveStartKey,
    }));
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < hardCap);
  return items;
}

/**
 * Scan all items across users filtered by an SK prefix. Admin-only use case.
 * This is O(table) so keep hardCap conservative.
 */
async function scanBySkPrefix(skPrefix, { hardCap = 5000 } = {}) {
  let items = [];
  let ExclusiveStartKey;
  do {
    const res = await ddb.send(new ScanCommand({
      TableName: DDB_TABLE,
      FilterExpression: "begins_with(#sk, :p)",
      ExpressionAttributeNames: { "#sk": "sk" },
      ExpressionAttributeValues: { ":p": skPrefix },
      ExclusiveStartKey,
    }));
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < hardCap);
  return items;
}

// ---------- Audit events (unchanged API) ----------
async function putJobEvent(jobId, qutUsername, status, message = "") {
  if (!qutUsername) {
    console.warn("DDB putJobEvent skipped: missing qutUsername");
    return;
  }
  const now = new Date().toISOString();
  const item = {
    [DDB_PK_NAME]: qutUsername,
    sk: `JOB#${jobId}#EVENT#${now}#${status}`,
    jobId,
    status,
    message,
    createdAt: now,
    entity: "event",
  };
  try {
    await putItem(item);
  } catch (e) {
    console.warn("DDB putJobEvent failed:", e.message || e);
  }
}

async function getJobEvents(jobId, qutUsername) {
  if (!qutUsername) throw new Error("missing qutUsername");
  const res = await ddb.send(new QueryCommand({
    TableName: DDB_TABLE,
    KeyConditionExpression: "#pk = :u AND begins_with(#sk, :prefix)",
    ExpressionAttributeNames: { "#pk": DDB_PK_NAME, "#sk": "sk" },
    ExpressionAttributeValues: {
      ":u": qutUsername,
      ":prefix": `JOB#${jobId}#EVENT#`,
    },
  }));
  return res.Items || [];
}

module.exports = {
  // shared ddb
  ddb, DDB_TABLE, DDB_PK_NAME,
  sks,

  // generic helpers
  putItem, getItem, updateItem, deleteItem, queryByPrefix,
  scanBySkPrefix,

  // identity + audit
  qutUsernameFromReqUser,
  putJobEvent, getJobEvents,
};
