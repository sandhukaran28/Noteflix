// server-local.js - Local development server without AWS dependencies
const express = require("express");
const fs = require("fs");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 8080;

// Middleware
app.use(cookieParser());
app.use(express.json());
app.use(cors({
  origin: true, // Allow all origins in development
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
}));

// Ensure data directory exists
const DATA_ROOT = process.env.DATA_ROOT || "./data";
fs.mkdirSync(DATA_ROOT, { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, "assets"), { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, "outputs"), { recursive: true });
fs.mkdirSync(path.join(DATA_ROOT, "tmp"), { recursive: true });

// Mock configuration for local development
const mockConfig = {
  awsRegion: process.env.AWS_REGION || "ap-southeast-2",
  apiBasePath: process.env.API_BASE_PATH || "/api/v1",
  cognito: {
    userPoolId: process.env.COGNITO_USER_POOL_ID || "local-dev-pool",
    clientId: process.env.COGNITO_CLIENT_ID || "local-dev-client",
  },
  s3: {
    bucket: process.env.S3_BUCKET || "local-dev-bucket",
    prefix: process.env.S3_PREFIX || "noteflix/outputs",
  },
  ddb: {
    table: process.env.DDB_TABLE || "local-dev-table",
  },
  qut: {
    username: process.env.QUT_USERNAME || "n11845619@qut.edu.au",
  },
  wiki: {
    enabled: process.env.WIKI_ENABLED === "true" || false,
    lang: process.env.WIKI_LANG || "en",
    maxChars: parseInt(process.env.WIKI_MAX_CHARS) || 1200,
    cacheTtlSeconds: parseInt(process.env.WIKI_CACHE_TTL) || 2592000,
    apiBase: process.env.WIKI_API_BASE || "https://en.wikipedia.org/w/api.php",
    tokenUrl: process.env.WIKI_TOKEN_URL || "",
  },
  secrets: {},
};

// Mock config loader
global.getConfig = () => mockConfig;

// Public config endpoint
app.get("/config/public", (_req, res) => {
  res.json({
    cognitoUserPoolId: mockConfig.cognito.userPoolId,
    cognitoClientId: mockConfig.cognito.clientId,
    apiBasePath: mockConfig.apiBasePath,
  });
});

// Mock authentication middleware
const mockAuth = (required = false) => (req, res, next) => {
  if (required) {
    // For local development, create a mock user
    req.user = {
      email: "n11845619@qut.edu.au",
      "cognito:username": "n11845619",
      "custom:qut_username": "n11845619@qut.edu.au",
    };
  }
  next();
};

// Mock routes for local development
app.get("/api/v1/me", mockAuth(true), (req, res) => {
  res.json({ user: req.user });
});

// Mock assets endpoint
app.get("/api/v1/assets", mockAuth(true), (req, res) => {
  res.json({
    assets: [],
    totalItems: 0,
    totalPages: 0,
    currentPage: 1,
    itemsPerPage: 10,
  });
});

// Mock jobs endpoint
app.get("/api/v1/jobs", mockAuth(true), (req, res) => {
  res.json({
    jobs: [],
    totalItems: 0,
    totalPages: 0,
    currentPage: 1,
    itemsPerPage: 10,
  });
});

// Health check
app.get("/healthz", (req, res) => {
  res.json({ 
    ok: true, 
    timestamp: new Date().toISOString(),
    environment: "local-development"
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    message: "Noteflix API - Local Development Server",
    version: "1.0.0",
    environment: "local-development",
    endpoints: {
      health: "/healthz",
      config: "/config/public",
      me: "/api/v1/me",
      assets: "/api/v1/assets",
      jobs: "/api/v1/jobs",
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Noteflix API Server running on port ${PORT}`);
  console.log(`📋 Environment: Local Development`);
  console.log(`🔗 Health check: http://localhost:${PORT}/healthz`);
  console.log(`📖 API docs: http://localhost:${PORT}/`);
  console.log(`📁 Data directory: ${path.resolve(DATA_ROOT)}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down server...');
  process.exit(0);
});
