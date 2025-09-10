// lib/wikiFetch.js
const { getConfig } = require("../lib/config");
const { getOAuthToken } = require("../lib/oauth");

/**
 * Returns a short extract string for the given topic, or null.
 * Order:
 *   1) OAuth-backed provider (if cfg.wiki.apiBase + tokenUrl + secrets.wikiOAuth exist)
 *   2) Public Wikipedia REST summary (lang-aware, with User-Agent contact)
 */
async function fetchWikiSummary(topic) {
  if (!topic) return null;

  const cfg = getConfig();
  const lang = (cfg.wiki?.lang || "en").toLowerCase();
  const maxChars = Number(cfg.wiki?.maxChars || 1200);
  const encTitle = encodeURIComponent(String(topic).trim());

  // ---- (A) OAuth-backed provider (optional) ----
  // NOTE: Adjust the endpoint path/params below to match your provider’s API.
  const apiBase = cfg.wiki?.apiBase; // e.g., https://api.example.com
  if (apiBase && cfg.wiki?.tokenUrl && cfg.secrets?.wikiOAuth) {
    const token = await getOAuthToken(); // may be null if misconfigured
    if (token) {
      const url = `${apiBase.replace(/\/+$/, "")}/wiki/summary?title=${encTitle}&lang=${lang}`;
      try {
        const res = await fetch(url, {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
        });
        if (res.ok) {
          const j = await res.json();
          const text = (j.extract || j.summary || j.description || "").trim();
          if (text) {
            return text.length > maxChars ? text.slice(0, maxChars - 3) + "..." : text;
          }
        } else {
          const t = await res.text().catch(() => "");
          console.warn("[wiki-oauth] non-200:", res.status, t);
        }
      } catch (e) {
        console.warn("[wiki-oauth] fetch failed:", e?.message || e);
      }
      // Fall through to Wikipedia on any failure.
    }
  }

  // ---- (B) Public Wikipedia fallback ----
  try {
    const base = `https://${lang}.wikipedia.org`;
    const url = `${base}/api/rest_v1/page/summary/${encTitle}`;
    const uaContact =
      cfg.secrets?.wikiUserAgentContact ||
      process.env.WIKI_USER_AGENT_CONTACT ||
      "noreply@example.com";

    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": `Noteflix/1.0 (${uaContact})`,
      },
    });
    if (!res.ok) return null;

    const json = await res.json();
    const text = (json.extract || json.description || "").trim();
    return text
      ? text.length > maxChars
        ? text.slice(0, maxChars - 3) + "..."
        : text
      : null;
  } catch {
    return null;
  }
}

module.exports = { fetchWikiSummary };
