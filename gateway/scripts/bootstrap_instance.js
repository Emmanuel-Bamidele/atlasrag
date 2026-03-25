#!/usr/bin/env node
// Bootstrap a SupaVector instance by ensuring a local admin user and minting a service token.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

function printUsage() {
  console.log(`Usage: node scripts/bootstrap_instance.js [options]

Options:
  --username USER                 Admin username (default: admin)
  --password PASS                 Admin password (default: generated)
  --tenant TENANT                 Tenant id (default: username)
  --roles LIST                    Admin roles csv (default: admin,indexer,reader)
  --service-token-name NAME       Service token display name (default: <tenant>-bootstrap)
  --service-principal-id ID       Service token principal id (default: <username>)
  --service-token-roles LIST      Service token roles csv (default: admin,indexer,reader)
  --expires-at ISO_TIMESTAMP      Optional service token expiry
  --base-url URL                  Printed base URL (default: PUBLIC_BASE_URL, OPENAPI_BASE_URL, or http://localhost:3000)
  --skip-migrations               Skip schema bootstrap
  --json                          Print JSON output
  --help                          Show this help

Required environment for DB access:
  PGHOST, PGDATABASE, PGUSER, and usually PGPASSWORD
`);
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] || "").trim();
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !String(next).startsWith("--")) {
      values[key] = String(next);
      i += 1;
    } else {
      flags.add(key);
    }
  }
  return { values, flags };
}

function readValue(parsed, key, fallback = "") {
  const value = parsed.values[key];
  if (value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function hasFlag(parsed, key) {
  return parsed.flags.has(key);
}

function parseRoles(raw, fallbackRaw) {
  const source = String(raw || fallbackRaw || "").trim();
  const allowed = new Set(["admin", "indexer", "reader"]);
  const out = [];
  const seen = new Set();
  for (const value of source.split(",")) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean || !allowed.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function randomSecret(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

function resolveBaseUrl(parsed) {
  const explicit = readValue(parsed, "base-url");
  if (explicit) return explicit.replace(/\/+$/, "");
  const envBase = String(process.env.PUBLIC_BASE_URL || process.env.OPENAPI_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  return "http://localhost:3000";
}

function buildPool() {
  const host = String(process.env.PGHOST || "").trim();
  const database = String(process.env.PGDATABASE || "").trim();
  const user = String(process.env.PGUSER || "").trim();
  if (!host || !database || !user) {
    throw new Error("PGHOST, PGDATABASE, and PGUSER must be set");
  }

  const pool = new Pool({
    host,
    port: parseInt(process.env.PGPORT || "5432", 10),
    database,
    user,
    password: process.env.PGPASSWORD
  });
  return pool;
}

async function runMigrations(pool) {
  const sqlPath = path.join(__dirname, "..", "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

async function ensureTenant(pool, tenantId, name) {
  await pool.query(
    `INSERT INTO tenants(tenant_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, name || null]
  );
}

async function upsertLocalUser(pool, { username, passwordHash, tenantId, roles }) {
  const existing = await pool.query(
    `SELECT id, username, tenant_id, roles
     FROM users
     WHERE username = $1`,
    [username]
  );

  if (existing.rows.length > 0) {
    const res = await pool.query(
      `UPDATE users
       SET password_hash = $2,
           tenant_id = $3,
           roles = $4,
           disabled = FALSE,
           sso_only = FALSE,
           failed_attempts = 0,
           lock_until = NULL
       WHERE username = $1
       RETURNING id, username, tenant_id, roles, disabled`,
      [username, passwordHash, tenantId, roles]
    );
    return { created: false, user: res.rows[0] || null };
  }

  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, disabled, sso_only)
     VALUES ($1, $2, $3, $4, FALSE, FALSE)
     RETURNING id, username, tenant_id, roles, disabled`,
    [username, passwordHash, tenantId, roles]
  );
  return { created: true, user: res.rows[0] || null };
}

async function createServiceToken(pool, { tenantId, name, principalId, roles, keyHash, expiresAt }) {
  const res = await pool.query(
    `INSERT INTO service_tokens(tenant_id, name, principal_id, roles, key_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
    [tenantId, name, principalId, roles || [], keyHash, expiresAt ? new Date(expiresAt) : null]
  );
  return res.rows[0] || null;
}

function formatOutput(result, asJson) {
  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("Bootstrap complete.");
  console.log("");
  console.log(`Base URL: ${result.baseUrl}`);
  console.log(`Tenant: ${result.tenant}`);
  console.log(`Admin user: ${result.admin.username} (${result.admin.action})`);
  console.log(`Admin password: ${result.admin.password}`);
  console.log(`Service token name: ${result.serviceToken.name}`);
  console.log(`Service token roles: ${result.serviceToken.roles.join(",")}`);
  if (result.serviceToken.expiresAt) {
    console.log(`Service token expires: ${result.serviceToken.expiresAt}`);
  }
  console.log("");
  console.log("Store this token now. It will not be shown again by the API.");
  console.log(`Service token: ${result.serviceToken.token}`);
  console.log("");
  console.log("Suggested app env:");
  console.log(`SUPAVECTOR_BASE_URL=${result.baseUrl}`);
  console.log(`SUPAVECTOR_API_KEY=${result.serviceToken.token}`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (hasFlag(parsed, "help")) {
    printUsage();
    return;
  }

  const username = readValue(parsed, "username", "admin").trim();
  const providedPassword = readValue(parsed, "password", "").trim();
  const password = providedPassword || `supav_admin_${randomSecret(18)}`;
  const tenant = readValue(parsed, "tenant", username).trim();
  const roles = parseRoles(readValue(parsed, "roles"), "admin,indexer,reader");
  const serviceTokenName = readValue(parsed, "service-token-name", `${tenant}-bootstrap`).trim();
  const servicePrincipalId = readValue(parsed, "service-principal-id", username).trim();
  const serviceTokenRoles = parseRoles(readValue(parsed, "service-token-roles"), "admin,indexer,reader");
  const expiresAt = readValue(parsed, "expires-at", "").trim();
  const skipMigrations = hasFlag(parsed, "skip-migrations");
  const asJson = hasFlag(parsed, "json");
  const baseUrl = resolveBaseUrl(parsed);

  if (!username || !tenant) {
    throw new Error("username and tenant are required");
  }
  if (!roles.length) {
    throw new Error("roles must include at least one of: admin, indexer, reader");
  }
  if (!serviceTokenName || !servicePrincipalId) {
    throw new Error("service token name and principal id are required");
  }
  if (!serviceTokenRoles.length) {
    throw new Error("service-token-roles must include at least one of: admin, indexer, reader");
  }
  if (expiresAt) {
    const dt = new Date(expiresAt);
    if (Number.isNaN(dt.getTime())) {
      throw new Error("expires-at must be a valid ISO timestamp");
    }
  }

  const pool = buildPool();
  try {
    if (!skipMigrations) {
      await runMigrations(pool);
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const rawToken = `supav_${randomSecret(24)}`;
    const keyHash = hashToken(rawToken);

    await pool.query("BEGIN");
    await ensureTenant(pool, tenant, null);
    const upserted = await upsertLocalUser(pool, {
      username,
      passwordHash,
      tenantId: tenant,
      roles
    });
    const tokenRecord = await createServiceToken(pool, {
      tenantId: tenant,
      name: serviceTokenName,
      principalId: servicePrincipalId,
      roles: serviceTokenRoles,
      keyHash,
      expiresAt: expiresAt || null
    });
    await pool.query("COMMIT");

    formatOutput({
      baseUrl,
      tenant,
      admin: {
        username,
        password,
        action: upserted.created ? "created" : "updated"
      },
      serviceToken: {
        id: tokenRecord?.id || null,
        name: serviceTokenName,
        principalId: servicePrincipalId,
        roles: serviceTokenRoles,
        expiresAt: tokenRecord?.expires_at || expiresAt || null,
        token: rawToken
      }
    }, asJson);
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch {
      // Ignore rollback failure and keep the original error.
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(String(err?.message || err));
  process.exit(1);
});
