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
const crypto = require("crypto");
const { getServiceTokenByHash, recordServiceTokenUse } = require("./db");

function buildMeta() {
  return {
    tenantId: null,
    collection: null,
    timestamp: new Date().toISOString()
  };
}

function sendAuthError(res, status, message, req) {
  const path = req?.path || "";
  if (path.startsWith("/v1")) {
    return res.status(status).json({
      ok: false,
      error: { message, code: "AUTH_ERROR" },
      meta: buildMeta()
    });
  }
  return res.status(status).json({ error: message, tenantId: null, collection: null });
}

function buildVerifyOptions() {
  const opts = { algorithms: ["HS256"] };
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return opts;
}

function hashApiKey(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function extractApiKey(req) {
  const headerKey = req.header("x-api-key");
  if (headerKey) return String(headerKey).trim();

  const auth = req.header("authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (scheme && scheme.toLowerCase() === "apikey" && token) {
    return String(token).trim();
  }
  return null;
}

async function tryApiKeyAuth(req, res) {
  const apiKey = extractApiKey(req);
  if (!apiKey) return { handled: false, ok: false };

  const keyHash = hashApiKey(apiKey);
  let record = null;
  try {
    record = await getServiceTokenByHash(keyHash);
  } catch (err) {
    sendAuthError(res, 500, "Auth lookup failed", req);
    return { handled: true, ok: false };
  }

  if (!record) {
    sendAuthError(res, 401, "Invalid API key", req);
    return { handled: true, ok: false };
  }

  if (record.revoked_at) {
    sendAuthError(res, 401, "API key revoked", req);
    return { handled: true, ok: false };
  }

  if (record.expires_at && new Date(record.expires_at) <= new Date()) {
    sendAuthError(res, 401, "API key expired", req);
    return { handled: true, ok: false };
  }

  try {
    await recordServiceTokenUse(record.id);
  } catch (err) {
    sendAuthError(res, 500, "Auth lookup failed", req);
    return { handled: true, ok: false };
  }
  req.user = {
    sub: record.principal_id,
    principal_id: record.principal_id,
    tenant: record.tenant_id,
    roles: record.roles || [],
    auth: "api_key",
    token_id: record.id
  };
  return { handled: true, ok: true };
}

// Require Bearer JWT or API key for protected routes
async function requireJwt(req, res, next) {
  const apiKeyResult = await tryApiKeyAuth(req, res);
  if (apiKeyResult.handled) {
    if (apiKeyResult.ok) {
      return next();
    }
    return;
  }

  const secret = process.env.JWT_SECRET;

  // If no JWT_SECRET set, we refuse (safer than accidentally public)
  if (!secret) {
    return sendAuthError(res, 500, "JWT_SECRET not set on server", req);
  }

  const auth = req.header("authorization") || "";
  const [scheme, token] = auth.split(" ");
  if (scheme !== "Bearer" || !token) {
    return sendAuthError(res, 401, "Missing or invalid auth header (Authorization: Bearer <jwt> or X-API-Key)", req);
  }

  try {
    const payload = jwt.verify(token, secret, buildVerifyOptions());
    req.user = payload;
    next();
  } catch (err) {
    return sendAuthError(res, 401, "Invalid token", req);
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
