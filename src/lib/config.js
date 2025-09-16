// lib/config.js
const { SSMClient, GetParameterCommand, GetParametersCommand } = require("@aws-sdk/client-ssm");
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { getWikiOAuth } = require("./wikiauth");

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const STAGE = process.env.STAGE || "prod";
const BASE = `/n11845619/noteflix/${STAGE}`; // no trailing slash

const ssm = new SSMClient({ region: REGION });
const sm  = new SecretsManagerClient({ region: REGION });

let cached = null;

async function getParameter(name, withDecryption = true) {
  const out = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: withDecryption }));
  return out?.Parameter?.Value ?? "";
}

async function getParameters(names, withDecryption = true) {
  // SSM GetParameters max 10 names per call
  const chunks = [];
  for (let i = 0; i < names.length; i += 10) chunks.push(names.slice(i, i + 10));
  const results = {};
  for (const chunk of chunks) {
    const out = await ssm.send(new GetParametersCommand({ Names: chunk, WithDecryption: withDecryption }));
    (out.Parameters || []).forEach(p => { results[p.Name] = p.Value; });
    // Note: out.InvalidParameters could be logged if needed
  }
  return results;
}

function asBool(v, fallback = false) {
  if (v === undefined || v === null) return fallback;
  const s = String(v).trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function asNum(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

async function loadConfig() {
  if (cached) return cached;

  // Declare the exact parameter names we need
  const names = [
    // core
    `${BASE}/aws/region`,
    `${BASE}/api/basePath`,
    `${BASE}/cognito/userPoolId`,
    `${BASE}/cognito/clientId`,
    `${BASE}/s3/bucket`,
    `${BASE}/s3/prefix`,
    `${BASE}/ddb/table`,
    `${BASE}/qut/username`,

    // wiki feature
    `${BASE}/wiki/enabled`,
    `${BASE}/wiki/lang`,
    `${BASE}/wiki/maxChars`,
    `${BASE}/wiki/cacheTtlSeconds`,
    `${BASE}/wiki/apiBase`,
    `${BASE}/wiki/oauth/tokenUrl`,
  ];

  let params = {};
  try {
    params = await getParameters(names, true);
  } catch (e) {
    console.warn("[config] GetParameters failed; falling back to envs. Reason:", e?.name || e?.__type || e?.message || e);
  }

  // Optional secret (example kept from your file)
  const secrets = {};
  try {
    const sec = await sm.send(
      new GetSecretValueCommand({ SecretId: `n11845619/noteflix/${STAGE}/thirdparty/serviceX` })
    );
    if (sec.SecretString) secrets.serviceX = JSON.parse(sec.SecretString);
  } catch { /* optional */ }

  // Wiki OAuth (from Secrets Manager via helper; falls back to SSM SecureString inside helper if you set it that way)
  try {
    const wikiOAuth = await getWikiOAuth(); // { clientId, clientSecret } or null
    if (wikiOAuth) secrets.wikiOAuth = wikiOAuth;
  } catch { /* optional */ }

  // Map to config object with sensible env fallbacks
  const awsRegion = params[`${BASE}/aws/region`] || process.env.AWS_REGION || REGION;

  cached = {
    awsRegion,
    apiBasePath: params[`${BASE}/api/basePath`] || process.env.API_BASE_PATH || "/api/v1",
    cognito: {
      userPoolId: params[`${BASE}/cognito/userPoolId`] || process.env.COGNITO_USER_POOL_ID || "",
      clientId:   params[`${BASE}/cognito/clientId`]   || process.env.COGNITO_CLIENT_ID || "",
    },
    s3: {
      bucket: params[`${BASE}/s3/bucket`] || process.env.S3_BUCKET || "",
      prefix: params[`${BASE}/s3/prefix`] || process.env.S3_PREFIX || "",
    },
    ddb: {
      table: params[`${BASE}/ddb/table`] || process.env.DDB_TABLE || "",
    },
    qut: {
      username: params[`${BASE}/qut/username`] || process.env.QUT_USERNAME || "",
    },
    wiki: {
      enabled: asBool(params[`${BASE}/wiki/enabled`] ?? process.env.WIKI_ENABLED, false),
      lang: params[`${BASE}/wiki/lang`] || process.env.WIKI_LANG || "en",
      maxChars: asNum(params[`${BASE}/wiki/maxChars`] ?? process.env.WIKI_MAX_CHARS, 1200),
      cacheTtlSeconds: asNum(params[`${BASE}/wiki/cacheTtlSeconds`] ?? process.env.WIKI_CACHE_TTL, 2592000),
      apiBase: params[`${BASE}/wiki/apiBase`] || process.env.WIKI_API_BASE || "",
      tokenUrl: params[`${BASE}/wiki/oauth/tokenUrl`] || process.env.WIKI_TOKEN_URL || "",
    },
    secrets,
  };

  console.log("userpoolid", params[`${BASE}/cognito/userPoolId`] || process.env.COGNITO_USER_POOL_ID || "", cached.cognito.userPoolId);

  return cached;
}

function getConfig() {
  if (!cached) throw new Error("Config not loaded yet. Call loadConfig() first.");
  return cached;
}

module.exports = { loadConfig, getConfig };
