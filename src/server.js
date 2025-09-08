// server.js
const express = require("express");
const fs = require("fs");
const cors = require("cors");

const assets = require("./routes/assets");
const jobs = require("./routes/jobs");
const { auth } = require("./middleware/auth"); // <-- Cognito verifier middleware

const app = express();
app.use(express.json());
app.use(
  cors({
    origin: (process.env.WEB_ORIGIN || "").split(",").filter(Boolean).length
      ? (process.env.WEB_ORIGIN || "").split(",").map(s => s.trim())
      : true, // allow all in dev; set WEB_ORIGIN in prod (comma-separated)
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

const DATA_ROOT = process.env.DATA_ROOT || "./data";
fs.mkdirSync(DATA_ROOT, { recursive: true });

// No local /login — frontend authenticates with Cognito Hosted UI
app.get("/api/v1/me", auth(true), (req, res) => res.json({ user: req.user }));

app.use("/api/v1/assets", auth(true), assets);
app.use("/api/v1/jobs", auth(true), jobs);

app.get("/healthz", (_, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`NoteFlix Server on :${PORT}`));
