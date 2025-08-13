const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";

const USERS = [
  { username: process.env.ADMIN_USER || "admin", password: process.env.ADMIN_PASS || "admin123", role: "admin" },
  { username: process.env.STUDENT_USER || "student", password: process.env.STUDENT_PASS || "student123", role: "student" }
];

function login(req, res) {
  const { username, password } = req.body || {};
  const u = USERS.find(x => x.username === username && x.password === password);
  if (!u) return res.status(401).json({ error: "invalid credentials" });
  const token = jwt.sign({ sub: u.username, role: u.role }, JWT_SECRET, { expiresIn: "12h" });
  res.json({ token });
}

function auth(required = true) {
  return (req, res, next) => {
    const hdr = req.headers.authorization || "";
    const token = hdr.startsWith("Bearer ") ? hdr.slice(7) : "";
    try {
      const payload = token ? jwt.verify(token, JWT_SECRET) : null;
      req.user = payload;
      if (required && !payload) return res.status(401).json({ error: "unauthorized" });
      next();
    } catch {
      if (required) return res.status(401).json({ error: "unauthorized" });
      next();
    }
  };
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) return res.status(403).json({ error: "forbidden" });
    next();
  };
}

module.exports = { login, auth, requireRole };
