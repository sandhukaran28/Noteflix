const express = require("express");
const fs = require("fs");
const assets = require("./routes/assets");
const jobs = require("./routes/jobs");
const { auth, login } = require("./auth");

const app = express();
app.use(express.json());

const DATA_ROOT = process.env.DATA_ROOT || "./data";
fs.mkdirSync(DATA_ROOT, { recursive: true });

app.post("/api/v1/auth/login", login);
app.get("/api/v1/me", auth(), (req, res) => res.json({ user: req.user }));

app.use("/api/v1/assets", auth(), assets);
app.use("/api/v1/jobs", auth(), jobs);

app.get("/healthz", (_, res) => res.json({ ok: true }));

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, () => console.log(`NoteFlix API on :${PORT}`));
