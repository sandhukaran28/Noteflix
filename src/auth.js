const { Router } = require("express");
const { auth } = require("../middleware/auth");
const r = Router();

r.get("/me", auth(true), (req, res) => res.json({ user: req.user }));

module.exports = r;
