//
//  security.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// security.js
// JWT auth + rate limiting (simple production protections)

const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");

function buildVerifyOptions() {
  const opts = { algorithms: ["HS256"] };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return opts;
}

// Require Bearer JWT for protected routes
function requireJwt(req, res, next) {
  const secret = process.env.JWT_SECRET;

  // If no JWT_SECRET set, we refuse (safer than accidentally public)
  if (!secret) {
    return res.status(500).json({ error: "JWT_SECRET not set on server" });
  }

  const auth = req.header("authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Missing or invalid Authorization header" });
  }

  try {
    const payload = jwt.verify(token, secret, buildVerifyOptions());
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// Rate limiter: max requests per window per IP
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,             // 60 requests/min per IP
  standardHeaders: true,
  legacyHeaders: false
});

const loginWindowMs = parseInt(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || "60000", 10);
const loginMax = parseInt(process.env.LOGIN_RATE_LIMIT_MAX || "10", 10);
const loginLimiter = rateLimit({
  windowMs: Number.isFinite(loginWindowMs) && loginWindowMs > 0 ? loginWindowMs : 60000,
  max: Number.isFinite(loginMax) && loginMax > 0 ? loginMax : 10,
  standardHeaders: true,
  legacyHeaders: false
});

module.exports = { requireJwt, limiter, loginLimiter };
