// lib/oauth.js
const { getConfig } = require("./config");
let cachedToken = null;

function msFromNow(sec) { return Date.now() + Math.max(10, sec) * 1000; }

async function getOAuthToken() {
  const cfg = getConfig();
  const creds = cfg.secrets?.wikiOAuth;
  const tokenUrl = cfg.wiki?.tokenUrl;      // from SSM (if you’re using an OAuth provider)
  if (!creds || !tokenUrl) return null;

  if (cachedToken && cachedToken.expiresAt > Date.now() + 5000) return cachedToken.accessToken;

  const body = new URLSearchParams({ grant_type: "client_credentials" });
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Authorization": `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) return null;
  const json = await res.json();
  const accessToken = json.access_token || json.accessToken;
  const expiresIn = Number(json.expires_in || json.expiresIn || 3600);
  if (!accessToken) return null;

  cachedToken = { accessToken, expiresAt: msFromNow(expiresIn) };
  return accessToken;
}

module.exports = { getOAuthToken };
