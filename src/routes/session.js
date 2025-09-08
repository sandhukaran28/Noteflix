// src/routes/session.js
const r = require("express").Router();

r.post("/session", (req, res) => {
  const { idToken } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "missing token" });
  res.cookie("nf_id", idToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: false,        // set true when you use HTTPS
    path: "/",
    maxAge: 60 * 60 * 1000,
  });
  res.json({ ok: true });
});

r.post("/logout", (_req, res) => {
  res.clearCookie("nf_id", { path: "/" });
  res.json({ ok: true });
});

module.exports = r;
