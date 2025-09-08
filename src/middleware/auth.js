// backend/src/middleware/auth.js
require("dotenv").config();
const { CognitoJwtVerifier } = require("aws-jwt-verify");

const idVerifier = CognitoJwtVerifier.create({
  userPoolId: process.env.COGNITO_USER_POOL_ID,
  tokenUse: "id",                         // <-- expect ID tokens
  clientId: process.env.COGNITO_CLIENT_ID,
});

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
      const payload = await idVerifier.verify(token);

      req.user = {
        sub: payload.sub,
        username: payload["cognito:username"] || payload.username,
        email: payload.email || null,                     // present on ID tokens
        groups: payload["cognito:groups"] || [],
        scope: payload.scope || "",                      // usually not on ID tokens
      };
      next();
    } catch (e) {
      console.log("jwt verify failed:", e?.message || e);
      if (required) return res.status(401).json({ error: "unauthorized" });
      req.user = null; next();
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    const groups = req.user?.groups || [];
    if (!groups.includes(role)) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

module.exports = { auth, requireRole };
