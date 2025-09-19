// backend/src/middleware/auth.js
const { CognitoJwtVerifier } = require("aws-jwt-verify");
const { getConfig } = require("../lib/config");

let idVerifier; // cached singleton

function assertString(name, val) {
  if (typeof val !== "string" || !val.trim()) {
    throw new Error(`${name} is missing/empty`);
  }
}

function getVerifier() {
  if (!idVerifier) {
    const cfg = getConfig(); // must be loaded at server startup
    const userPoolId = cfg?.cognito?.userPoolId || process.env.COGNITO_USER_POOL_ID;
    const clientId   = cfg?.cognito?.clientId   || process.env.COGNITO_CLIENT_ID;

    // HARD ASSERTS so we fail loudly + clearly (instead of ".match" crash)
    assertString("COGNITO_USER_POOL_ID", userPoolId);
    assertString("COGNITO_CLIENT_ID", clientId);

    console.log("[auth] Using Cognito pool:", userPoolId, "clientId:", clientId);
    idVerifier = CognitoJwtVerifier.create({
      userPoolId,
      clientId,
      tokenUse: "id",
    });
  }
  return idVerifier;
}

function auth(required = true) {
  return async (req, res, next) => {
    const hdr = req.headers.authorization || "";
    let token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    if (!token && req.cookies?.nf_id) token = req.cookies.nf_id;

    if (!token) {
      if (required) return res.status(401).json({ error: "unauthorized" });
      req.user = null; return next();
    }

    try {
      const payload = await getVerifier().verify(token);
      req.user = {
        sub: payload.sub,
        username: payload["cognito:username"] || payload.username,
        email: payload.email || null,
        groups: payload["cognito:groups"] || [],
        scope: payload.scope || "",
      };
      next();
    } catch (e) {
      console.error("jwt verify failed:", e?.message || e);
      if (required) return res.status(401).json({ error: "unauthorized" });
      req.user = null; next();
    }
  };
}

function requireGroup(groupName) {
  return (req, res, next) => {
    const groups = req.user?.groups || [];
    if (!groups.includes(groupName)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

function isAdmin(req) {
  const groups = req.user?.groups || [];
  const adminGroup = process.env.COGNITO_ADMIN_GROUP || "Admin";
  return groups.includes(adminGroup);
}

module.exports = { auth, requireGroup, isAdmin };
