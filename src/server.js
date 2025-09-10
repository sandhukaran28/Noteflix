// server.js
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const cookieParser = require("cookie-parser");

const assets = require("./routes/assets");
const jobs = require("./routes/jobs");
const { auth } = require("./middleware/auth"); // Cognito verifier middleware
const { loadConfig, getConfig } = require("./lib/config"); // <-- add this
const { fetchWikiSummary } = require("./utils/wiki");

(async () => {
  // 1) Load config from SSM/Secrets once at boot
  const cfg = await loadConfig();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  // 2) CORS using config (use SSM param webOriginCsv if you add it later)
  const originsCsv = cfg.webOriginCsv || process.env.WEB_ORIGIN || "";
  const originList = originsCsv.split(",").map(s => s.trim()).filter(Boolean);

  app.use(
    cors({
      origin: originList.length ? originList : true, // allow all in dev
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
    })
  );

  // 3) Ensure data dir exists
  const DATA_ROOT = process.env.DATA_ROOT || "./data";
  fs.mkdirSync(DATA_ROOT, { recursive: true });

  // 4) Public config for frontend (safe values only)
  app.get("/config/public", (_req, res) => {
    const { cognito, apiBasePath } = getConfig();
    res.json({
      cognitoUserPoolId: cognito.userPoolId,
      cognitoClientId: cognito.clientId,
      apiBasePath,
    });
  });

  // 5) API routes (you already prefixed with /api/v1 in your codebase)
  app.use("/api/v1", require("./routes/session"));

  // No local /login — frontend authenticates with Cognito Hosted UI
  app.get("/api/v1/me", auth(true), (req, res) => res.json({ user: req.user }));

  app.use("/api/v1/assets", auth(true), assets);
  app.use("/api/v1/jobs", auth(true), jobs);

  app.get("/healthz", (_, res) => res.json({ ok: true }));

  const PORT = Number(process.env.PORT || 8080);
  app.listen(PORT, () => console.log(`NoteFlix Server on :${PORT}`));
})();
