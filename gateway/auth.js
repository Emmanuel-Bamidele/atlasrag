// auth.js
// Production auth helpers: validate user credentials from Postgres and issue JWTs.

const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const { getUserByUsername } = require("./db");

const DEFAULT_AUTH_MODE = "sso_plus_password";
const AUTH_MODES = new Set(["sso_only", "sso_plus_password", "password_only"]);

function parseAuthMode(value) {
  const clean = String(value || "").trim().toLowerCase();
  if (!clean) return null;
  if (AUTH_MODES.has(clean)) return clean;
  return null;
}

function normalizeAuthMode(value) {
  return parseAuthMode(value) || DEFAULT_AUTH_MODE;
}

function isPasswordAllowed(authMode) {
  return normalizeAuthMode(authMode) !== "sso_only";
}

function isSsoAllowed(authMode) {
  return normalizeAuthMode(authMode) !== "password_only";
}

async function verifyCredentials(username, password) {
  const user = await getUserByUsername(username);
  if (!user) {
    return { ok: false, reason: "invalid" };
  }
  if (user.disabled) {
    return { ok: false, reason: "disabled" };
  }
  const tenantAuthMode = normalizeAuthMode(user.tenant_auth_mode);
  if (!isPasswordAllowed(tenantAuthMode)) {
    return { ok: false, reason: "sso_only" };
  }
  if (user.sso_only) {
    return { ok: false, reason: "sso_only" };
  }

  const now = new Date();
  if (user.lock_until && new Date(user.lock_until) > now) {
    return { ok: false, reason: "locked", lockUntil: user.lock_until };
  }

  if (!user.password_hash) {
    return { ok: false, reason: "invalid" };
  }

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) {
    return { ok: false, reason: "invalid", user };
  }

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      tenant: user.tenant_id,
      roles: user.roles || []
    }
  };
}

function buildSignOptions() {
  const opts = {};
  const expiresIn = process.env.JWT_EXPIRES_IN || "7d";
  if (expiresIn) opts.expiresIn = expiresIn;
  if (process.env.JWT_ISSUER) opts.issuer = process.env.JWT_ISSUER;
  if (process.env.JWT_AUDIENCE) opts.audience = process.env.JWT_AUDIENCE;
  return opts;
}

function issueToken(user) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET not set on server");
  }

  const payload = {
    sub: user.username,
    tenant: user.tenant
  };
  if (user.roles) payload.roles = user.roles;

  return jwt.sign(payload, secret, buildSignOptions());
}

module.exports = {
  verifyCredentials,
  issueToken,
  parseAuthMode,
  normalizeAuthMode,
  isPasswordAllowed,
  isSsoAllowed
};
