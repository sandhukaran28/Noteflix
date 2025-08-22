// Try to get a short extract for a topic from Wikipedia REST API.
async function fetchWikiSummary(topic) {
  if (!topic) return null;
  const title = encodeURIComponent(topic.trim());
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}`;
  try {
    const res = await fetch(url, { headers: { "accept": "application/json" } });
    if (!res.ok) return null;
    const json = await res.json();
    // prefer extract; fallback to description
    return json.extract || json.description || null;
  } catch {
    return null;
  }
}

module.exports = { fetchWikiSummary };
