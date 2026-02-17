// scripts/ensure_user.js
// Idempotently create or update a local password user for CI/e2e runs.

const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

function readArg(flag) {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return "";
  return process.argv[idx + 1] || "";
}

function parseRoles(raw) {
  const allowed = new Set(["admin", "indexer", "reader"]);
  const list = Array.isArray(raw) ? raw : String(raw || "").split(",");
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const clean = String(value || "").trim().toLowerCase();
    if (!clean || !allowed.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

async function main() {
  const username = readArg("--username") || process.env.USERNAME || process.env.E2E_USERNAME || "";
  const password = readArg("--password") || process.env.PASSWORD || process.env.E2E_PASSWORD || "";
  const tenant = readArg("--tenant") || process.env.TENANT || process.env.E2E_TENANT || username;
  const rolesRaw = readArg("--roles") || process.env.ROLES || process.env.ROLE || process.env.E2E_ROLES || "admin";
  const roles = parseRoles(rolesRaw);

  if (!username || !password || !tenant) {
    console.error("Usage: node scripts/ensure_user.js --username USER --password PASS --tenant TENANT [--roles admin,indexer,reader]");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const pool = new Pool({
    host: process.env.PGHOST,
    port: parseInt(process.env.PGPORT || "5432", 10),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD
  });

  try {
    await pool.query("BEGIN");
    await pool.query(
      `INSERT INTO tenants(tenant_id, name)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenant, null]
    );

    const existing = await pool.query(
      `SELECT id FROM users WHERE username = $1`,
      [username]
    );

    if (existing.rows.length > 0) {
      await pool.query(
        `UPDATE users
         SET password_hash = $2,
             tenant_id = $3,
             roles = $4,
             disabled = FALSE,
             sso_only = FALSE,
             failed_attempts = 0,
             lock_until = NULL
         WHERE username = $1`,
        [username, passwordHash, tenant, roles]
      );
      console.log(`Updated user: ${username} tenant: ${tenant} roles: ${roles.join(",") || "(none)"}`);
    } else {
      await pool.query(
        `INSERT INTO users(username, password_hash, tenant_id, roles, disabled, sso_only)
         VALUES ($1, $2, $3, $4, FALSE, FALSE)`,
        [username, passwordHash, tenant, roles]
      );
      console.log(`Created user: ${username} tenant: ${tenant} roles: ${roles.join(",") || "(none)"}`);
    }

    await pool.query("COMMIT");
  } catch (err) {
    try {
      await pool.query("ROLLBACK");
    } catch {
      // Ignore rollback failure and keep original error.
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
