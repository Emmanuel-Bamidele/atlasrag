//
//  db.js
//  AtlasRAG
//
//  Created by Emmanuel Bamidele on 2/11/26.
//

// db.js
// Postgres helper functions for storing chunk text persistently.

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

// Pool manages a set of DB connections (better than one connection)
const pool = new Pool({
  host: process.env.PGHOST,
  port: parseInt(process.env.PGPORT || "5432", 10),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD
});

// Save a chunk row
async function saveChunk({ chunkId, docId, idx, text }) {
  await pool.query(
    `INSERT INTO chunks(chunk_id, doc_id, idx, text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (chunk_id) DO UPDATE
     SET doc_id = EXCLUDED.doc_id,
         idx    = EXCLUDED.idx,
         text   = EXCLUDED.text`,
    [chunkId, docId, idx, text]
  );
}

// Get many chunks by ids (returns a Map)
async function getChunksByIds(ids) {
  if (!ids || ids.length === 0) return new Map();

  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     WHERE chunk_id = ANY($1)`,
    [ids]
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.chunk_id, row);
  }
  return map;
}

// Delete all chunks for a docId
async function deleteDoc(docId) {
  await pool.query(`DELETE FROM chunks WHERE doc_id = $1`, [docId]);
}

// List documents for a tenant (distinct doc_id with chunk counts)
async function listDocsByTenant(tenantId) {
  const prefix = `${tenantId}::`;
  const res = await pool.query(
    `SELECT doc_id, COUNT(*)::int AS chunks
     FROM chunks
     WHERE LEFT(doc_id, $2) = $1
     GROUP BY doc_id
     ORDER BY doc_id`,
    [prefix, prefix.length]
  );
  return res.rows;
}

// Ensure tenant exists
async function ensureTenant(tenantId, name) {
  const cleanId = String(tenantId || "").trim();
  if (!cleanId) return;
  await pool.query(
    `INSERT INTO tenants(tenant_id, name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [cleanId, name || null]
  );
}

// Fetch user by username
async function getUserByUsername(username) {
  const res = await pool.query(
    `SELECT id, username, password_hash, tenant_id, roles, disabled, sso_only, auth_provider, auth_subject, email, full_name,
            failed_attempts, lock_until, last_login
     FROM users
     WHERE username = $1`,
    [username]
  );
  return res.rows[0] || null;
}

// Create a user (expects hashed password)
async function createUser({ username, passwordHash, tenantId, roles }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, sso_only)
     VALUES ($1, $2, $3, $4, FALSE)
     RETURNING id, username, tenant_id, roles, disabled`,
    [username, passwordHash, tenantId, roles || []]
  );
  return res.rows[0];
}

async function upsertSsoUser({ provider, subject, tenantId, email, fullName, passwordHash }) {
  await ensureTenant(tenantId);
  const username = `${provider}:${subject}`;

  const res = await pool.query(
    `INSERT INTO users(username, password_hash, tenant_id, roles, sso_only, auth_provider, auth_subject, email, full_name)
     VALUES ($1, $2, $3, $4, TRUE, $5, $6, $7, $8)
     ON CONFLICT (auth_provider, auth_subject)
     DO UPDATE SET
       tenant_id = EXCLUDED.tenant_id,
       email = EXCLUDED.email,
       full_name = EXCLUDED.full_name
     RETURNING id, username, tenant_id, roles, disabled, sso_only`,
    [username, passwordHash, tenantId, [], provider, subject, email || null, fullName || null]
  );
  return res.rows[0];
}

async function recordFailedLogin(username, maxAttempts, lockMinutes) {
  const safeMax = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5;
  const safeMinutes = Number.isFinite(lockMinutes) && lockMinutes > 0 ? lockMinutes : 15;

  const res = await pool.query(
    `UPDATE users
     SET failed_attempts = failed_attempts + 1,
         lock_until = CASE
           WHEN failed_attempts + 1 >= $2 THEN NOW() + ($3 || ' minutes')::interval
           ELSE lock_until
         END
     WHERE username = $1
     RETURNING failed_attempts, lock_until`,
    [username, safeMax, String(safeMinutes)]
  );
  return res.rows[0] || null;
}

async function recordSuccessfulLogin(userId) {
  await pool.query(
    `UPDATE users
     SET failed_attempts = 0,
         lock_until = NULL,
         last_login = NOW()
     WHERE id = $1`,
    [userId]
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runMigrations() {
  if (process.env.MIGRATIONS_AUTO === "0") return;

  const attempts = parseInt(process.env.MIGRATIONS_ATTEMPTS || "15", 10);
  const delayMs = parseInt(process.env.MIGRATIONS_DELAY_MS || "2000", 10);

  for (let i = 1; i <= attempts; i += 1) {
    try {
      await pool.query("SELECT 1");
      break;
    } catch (err) {
      if (i === attempts) throw err;
      await sleep(delayMs);
    }
  }

  const sqlPath = path.join(__dirname, "schema.sql");
  const sql = fs.readFileSync(sqlPath, "utf8");
  await pool.query(sql);
}

module.exports = {
  saveChunk,
  getChunksByIds,
  deleteDoc,
  listDocsByTenant,
  ensureTenant,
  getUserByUsername,
  createUser,
  upsertSsoUser,
  recordFailedLogin,
  recordSuccessfulLogin,
  runMigrations
};
