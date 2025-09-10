// lib/wikiSecret.js
const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");

const REGION = process.env.AWS_REGION || "ap-southeast-2";
const sm  = new SecretsManagerClient({ region: REGION });
const ssm = new SSMClient({ region: REGION });

const SECRET_ID = "/n11845619/noteflix/prod/wiki";           // Secrets Manager
const SSM_FALLBACK = "/n11845619/noteflix/prod/wiki";        // SSM SecureString (optional fallback)

async function getWikiOAuth() {
  // Try Secrets Manager first

  try {
    const res = await sm.send(new GetSecretValueCommand({ SecretId: SECRET_ID }));
    const raw = res.SecretString ?? (res.SecretBinary && Buffer.from(res.SecretBinary, "base64").toString("utf8"));
    if (!raw) return null;
    const json = JSON.parse(raw);
    if (!json.clientId || !json.clientSecret) throw new Error("fields missing");
    return { clientId: json.clientId, clientSecret: json.clientSecret };
  } catch (e) {
    // fall through to SSM if you don't have SM permissions in your SSO role
    // console.warn("[secrets] SM fetch failed:", e.name || e.message);
  }

  // Optional: fallback to SSM SecureString if you stored it there instead
  try {
    const out = await ssm.send(new GetParameterCommand({ Name: SSM_FALLBACK, WithDecryption: true }));
    const json = JSON.parse(out.Parameter.Value);
    if (!json.clientId || !json.clientSecret) throw new Error("fields missing");
    return { clientId: json.clientId, clientSecret: json.clientSecret };
  } catch (e) {
    // console.warn("[secrets] SSM fallback failed:", e.name || e.message);
    return null;
  }
}

module.exports = { getWikiOAuth };
