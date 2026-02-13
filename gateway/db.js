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
const crypto = require("crypto");

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

// Get all chunks for a doc (ordered)
async function getChunksByDocId(docId) {
  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     WHERE doc_id = $1
     ORDER BY idx ASC`,
    [docId]
  );
  return res.rows;
}

// Delete all chunks for a docId
async function deleteDoc(docId) {
  await pool.query(`DELETE FROM chunks WHERE doc_id = $1`, [docId]);
}

async function countChunks() {
  const res = await pool.query(`SELECT COUNT(*)::bigint AS count FROM chunks`);
  return Number(res.rows[0]?.count || 0);
}

async function listChunksAfter({ afterId, limit }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? limit : 500;
  if (afterId) {
    const res = await pool.query(
      `SELECT chunk_id, doc_id, idx, text
       FROM chunks
       WHERE chunk_id > $1
       ORDER BY chunk_id
       LIMIT $2`,
      [afterId, cleanLimit]
    );
    return res.rows;
  }

  const res = await pool.query(
    `SELECT chunk_id, doc_id, idx, text
     FROM chunks
     ORDER BY chunk_id
     LIMIT $1`,
    [cleanLimit]
  );
  return res.rows;
}

// Create or update an artifact memory item for a document
async function upsertMemoryArtifact({ tenantId, collection, externalId, namespaceId, title, sourceType, sourceUrl, metadata, expiresAt, principalId, visibility, acl }) {
  return upsertMemoryItem({
    tenantId,
    collection,
    itemType: "artifact",
    externalId,
    namespaceId,
    title,
    sourceType,
    sourceUrl,
    metadata,
    expiresAt,
    principalId,
    visibility,
    acl
  });
}

async function upsertMemoryItem({ tenantId, collection, itemType, externalId, namespaceId, title, sourceType, sourceUrl, metadata, createdAt, expiresAt, itemId, principalId, visibility, acl }) {
  await ensureTenant(tenantId);
  if (!itemType) {
    throw new Error("itemType is required");
  }

  const id = itemId || namespaceId || crypto.randomUUID();
  const cleanVisibility = visibility || "tenant";
  const aclList = Array.isArray(acl) && acl.length ? acl : null;
  const payload = [
    id,
    tenantId,
    collection,
    itemType,
    externalId || null,
    principalId || null,
    cleanVisibility,
    aclList,
    title || null,
    sourceType || null,
    sourceUrl || null,
    metadata ? JSON.stringify(metadata) : null,
    namespaceId || id,
    expiresAt ? new Date(expiresAt) : null
  ];

  let sql = `INSERT INTO memory_items(
      id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals,
      title, source_type, source_url, metadata, namespace_id, expires_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (tenant_id, collection, item_type, external_id)
    DO UPDATE SET
      principal_id = EXCLUDED.principal_id,
      visibility = EXCLUDED.visibility,
      acl_principals = EXCLUDED.acl_principals,
      title = EXCLUDED.title,
      source_type = EXCLUDED.source_type,
      source_url = EXCLUDED.source_url,
      metadata = EXCLUDED.metadata,
      expires_at = EXCLUDED.expires_at
    RETURNING id, namespace_id, created_at, expires_at, item_type, external_id, principal_id, visibility, acl_principals,
              title, source_type, source_url, metadata, tenant_id, collection`;

  if (createdAt) {
    payload.push(new Date(createdAt));
    sql = `INSERT INTO memory_items(
        id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals,
        title, source_type, source_url, metadata, namespace_id, expires_at, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      ON CONFLICT (tenant_id, collection, item_type, external_id)
      DO UPDATE SET
        principal_id = EXCLUDED.principal_id,
        visibility = EXCLUDED.visibility,
        acl_principals = EXCLUDED.acl_principals,
        title = EXCLUDED.title,
        source_type = EXCLUDED.source_type,
        source_url = EXCLUDED.source_url,
        metadata = EXCLUDED.metadata,
        expires_at = EXCLUDED.expires_at
      RETURNING id, namespace_id, created_at, expires_at, item_type, external_id, principal_id, visibility, acl_principals,
                title, source_type, source_url, metadata, tenant_id, collection`;
  }

  const res = await pool.query(sql, payload);
  return res.rows[0] || { id, namespace_id: namespaceId || id };
}

async function getMemoryItemsByNamespaceIds({ namespaceIds, types, since, until, excludeExpired, principalId, privileges }) {
  if (!namespaceIds || namespaceIds.length === 0) return new Map();

  const clauses = ["namespace_id = ANY($1)"];
  const params = [namespaceIds];
  const aclPrincipals = new Set();
  if (Array.isArray(privileges)) {
    for (const item of privileges) {
      const clean = String(item || "").trim();
      if (clean) aclPrincipals.add(clean);
    }
  }
  if (principalId) {
    aclPrincipals.add(principalId);
  }

  if (types && types.length) {
    params.push(types);
    clauses.push(`item_type = ANY($${params.length})`);
  }
  if (since) {
    params.push(since);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    clauses.push(`created_at <= $${params.length}`);
  }
  if (excludeExpired) {
    clauses.push(`(expires_at IS NULL OR expires_at > NOW())`);
  }
  if (principalId || aclPrincipals.size > 0) {
    const visibilityClauses = [
      "visibility IS NULL",
      "visibility = 'tenant'"
    ];
    if (principalId) {
      params.push(principalId);
      const idx = params.length;
      visibilityClauses.push(`(visibility = 'private' AND principal_id = $${idx})`);
    }
    if (aclPrincipals.size > 0) {
      params.push(Array.from(aclPrincipals));
      const idx = params.length;
      visibilityClauses.push(`(visibility = 'acl' AND (principal_id = ANY($${idx}) OR COALESCE(acl_principals, ARRAY[]::TEXT[]) && $${idx}))`);
    }
    clauses.push(`(${visibilityClauses.join(" OR ")})`);
  }

  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title,
            source_type, source_url, metadata, parent_id, created_at, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}`,
    params
  );

  const map = new Map();
  for (const row of res.rows) {
    map.set(row.namespace_id, row);
  }
  return map;
}

async function getMemoryItemById(id, tenantId, principalId) {
  const clauses = ["id = $1"];
  const params = [id];

  if (tenantId) {
    params.push(tenantId);
    clauses.push(`tenant_id = $${params.length}`);
  }
  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title,
            source_type, source_url, metadata, parent_id, created_at, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}`,
    params
  );
  return res.rows[0] || null;
}

async function deleteMemoryItemById(id) {
  await pool.query(`DELETE FROM memory_items WHERE id = $1`, [id]);
}

async function getArtifactByExternalId(tenantId, collection, externalId, principalId) {
  const clauses = ["tenant_id = $1", "collection = $2", "item_type = 'artifact'", "external_id = $3"];
  const params = [tenantId, collection, externalId];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title,
            source_type, source_url, metadata, parent_id, created_at, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     LIMIT 1`,
    params
  );
  return res.rows[0] || null;
}

async function listExpiredMemoryItems({ tenantId, collection, before, limit, principalId }) {
  const clauses = [
    "tenant_id = $1",
    "collection = $2",
    "expires_at IS NOT NULL",
    "expires_at <= $3"
  ];
  const params = [tenantId, collection, before];

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY expires_at ASC
     LIMIT $${params.length}`,
    params
  );
  return res.rows;
}

async function listMemoryItemsForCompaction({ tenantId, collection, types, since, until, limit, principalId }) {
  const clauses = ["tenant_id = $1", "collection = $2"];
  const params = [tenantId, collection];

  if (types && types.length) {
    params.push(types);
    clauses.push(`item_type = ANY($${params.length})`);
  }
  if (since) {
    params.push(since);
    clauses.push(`created_at >= $${params.length}`);
  }
  if (until) {
    params.push(until);
    clauses.push(`created_at <= $${params.length}`);
  }

  clauses.push(`(expires_at IS NULL OR expires_at > NOW())`);

  if (principalId) {
    params.push(principalId);
    clauses.push(`(
      visibility IS NULL
      OR visibility = 'tenant'
      OR (visibility = 'private' AND principal_id = $${params.length})
      OR (visibility = 'acl' AND (principal_id = $${params.length} OR $${params.length} = ANY(COALESCE(acl_principals, ARRAY[]::TEXT[]))))
    )`);
  }

  params.push(limit);
  const res = await pool.query(
    `SELECT id, namespace_id, tenant_id, collection, item_type, external_id, principal_id, visibility, acl_principals, title,
            source_type, source_url, metadata, parent_id, created_at, expires_at
     FROM memory_items
     WHERE ${clauses.join(" AND ")}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params
  );

  return res.rows;
}

async function createMemoryLink({ tenantId, fromItemId, toItemId, relation, metadata }) {
  const res = await pool.query(
    `INSERT INTO memory_links(tenant_id, from_item_id, to_item_id, relation, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, tenant_id, from_item_id, to_item_id, relation, metadata, created_at`,
    [tenantId, fromItemId, toItemId, relation, metadata ? JSON.stringify(metadata) : null]
  );
  return res.rows[0];
}

async function createMemoryJob({ tenantId, jobType, status, input }) {
  const res = await pool.query(
    `INSERT INTO memory_jobs(tenant_id, job_type, status, input)
     VALUES ($1, $2, $3, $4)
     RETURNING id, tenant_id, job_type, status, input, output, error, created_at, updated_at`,
    [tenantId, jobType, status, input ? JSON.stringify(input) : null]
  );
  return res.rows[0];
}

async function updateMemoryJob({ id, status, output, error }) {
  const res = await pool.query(
    `UPDATE memory_jobs
     SET status = COALESCE($2, status),
         output = COALESCE($3, output),
         error = COALESCE($4, error),
         updated_at = NOW()
     WHERE id = $1
     RETURNING id, tenant_id, job_type, status, input, output, error, created_at, updated_at`,
    [id, status || null, output ? JSON.stringify(output) : null, error || null]
  );
  return res.rows[0] || null;
}

async function getMemoryJobById(id, tenantId) {
  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, created_at, updated_at
     FROM memory_jobs
     WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)`,
    [id, tenantId || null]
  );
  return res.rows[0] || null;
}

async function getIdempotencyKey({ tenantId, endpoint, idempotencyKey }) {
  const res = await pool.query(
    `SELECT tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at
     FROM idempotency_keys
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3`,
    [tenantId, endpoint, idempotencyKey]
  );
  return res.rows[0] || null;
}

async function beginIdempotencyKey({ tenantId, endpoint, idempotencyKey, requestHash }) {
  await ensureTenant(tenantId);
  const insert = await pool.query(
    `INSERT INTO idempotency_keys(tenant_id, endpoint, idem_key, request_hash, status)
     VALUES ($1, $2, $3, $4, 'in_progress')
     ON CONFLICT (tenant_id, endpoint, idem_key) DO NOTHING
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey, requestHash]
  );

  if (insert.rows[0]) {
    return { inserted: true, record: insert.rows[0] };
  }

  const record = await getIdempotencyKey({ tenantId, endpoint, idempotencyKey });
  return { inserted: false, record };
}

async function touchIdempotencyKey({ tenantId, endpoint, idempotencyKey }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
     SET updated_at = NOW(), status = 'in_progress'
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey]
  );
  return res.rows[0] || null;
}

async function completeIdempotencyKey({ tenantId, endpoint, idempotencyKey, responseStatus, responseBody }) {
  const res = await pool.query(
    `UPDATE idempotency_keys
     SET status = 'completed',
         response_status = $4,
         response_body = $5,
         updated_at = NOW()
     WHERE tenant_id = $1 AND endpoint = $2 AND idem_key = $3
     RETURNING tenant_id, endpoint, idem_key, request_hash, status, response_status, response_body, created_at, updated_at`,
    [tenantId, endpoint, idempotencyKey, responseStatus, responseBody ? JSON.stringify(responseBody) : null]
  );
  return res.rows[0] || null;
}

async function createServiceToken({ tenantId, name, principalId, roles, keyHash, expiresAt }) {
  await ensureTenant(tenantId);
  const res = await pool.query(
    `INSERT INTO service_tokens(tenant_id, name, principal_id, roles, key_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
    [tenantId, name, principalId, roles || [], keyHash, expiresAt ? new Date(expiresAt) : null]
  );
  return res.rows[0];
}

async function listServiceTokens(tenantId) {
  const res = await pool.query(
    `SELECT id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at
     FROM service_tokens
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId]
  );
  return res.rows;
}

async function getServiceTokenByHash(keyHash) {
  const res = await pool.query(
    `SELECT id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at
     FROM service_tokens
     WHERE key_hash = $1
     LIMIT 1`,
    [keyHash]
  );
  return res.rows[0] || null;
}

async function recordServiceTokenUse(id) {
  await pool.query(
    `UPDATE service_tokens
     SET last_used_at = NOW()
     WHERE id = $1`,
    [id]
  );
}

async function revokeServiceToken(id, tenantId) {
  const res = await pool.query(
    `UPDATE service_tokens
     SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2
     RETURNING id, tenant_id, name, principal_id, roles, last_used_at, expires_at, revoked_at, created_at`,
    [id, tenantId]
  );
  return res.rows[0] || null;
}

async function deleteMemoryItemsByCollection(tenantId, collection) {
  const res = await pool.query(
    `DELETE FROM memory_items
     WHERE tenant_id = $1 AND collection = $2`,
    [tenantId, collection]
  );
  return res.rowCount || 0;
}

async function listMemoryJobs({ tenantId, limit, status, jobType }) {
  const cleanLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 200) : 20;
  let statusClause = "$2::text IS NULL OR status = $2";
  let statusParam = status || null;

  if (Array.isArray(status)) {
    const filtered = status.map(s => String(s || "").trim()).filter(Boolean);
    if (filtered.length === 0) {
      statusParam = null;
    } else if (filtered.length === 1) {
      statusClause = "status = $2";
      statusParam = filtered[0];
    } else {
      statusClause = "status = ANY($2)";
      statusParam = filtered;
    }
  }

  const res = await pool.query(
    `SELECT id, tenant_id, job_type, status, input, output, error, created_at, updated_at
     FROM memory_jobs
     WHERE tenant_id = $1
       AND (${statusClause})
       AND ($3::text IS NULL OR job_type = $3)
     ORDER BY created_at DESC
     LIMIT $4`,
    [tenantId, statusParam, jobType || null, cleanLimit]
  );
  return res.rows;
}

// List documents for a tenant (distinct doc_id with chunk counts)
async function listDocsByTenant(tenantId, principalId, privileges) {
  const prefix = `${tenantId}::`;
  if (!principalId && (!Array.isArray(privileges) || privileges.length === 0)) {
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

  const params = [prefix, prefix.length, tenantId];
  const aclPrincipals = new Set();
  if (Array.isArray(privileges)) {
    for (const item of privileges) {
      const clean = String(item || "").trim();
      if (clean) aclPrincipals.add(clean);
    }
  }
  if (principalId) {
    aclPrincipals.add(principalId);
  }
  const visibilityClauses = [
    "m.visibility IS NULL",
    "m.visibility = 'tenant'"
  ];
  if (principalId) {
    params.push(principalId);
    const idx = params.length;
    visibilityClauses.push(`(m.visibility = 'private' AND m.principal_id = $${idx})`);
  }
  if (aclPrincipals.size > 0) {
    params.push(Array.from(aclPrincipals));
    const idx = params.length;
    visibilityClauses.push(`(m.visibility = 'acl' AND (m.principal_id = ANY($${idx}) OR COALESCE(m.acl_principals, ARRAY[]::TEXT[]) && $${idx}))`);
  }
  const res = await pool.query(
    `SELECT c.doc_id, COUNT(*)::int AS chunks
     FROM chunks c
     JOIN memory_items m ON m.namespace_id = c.doc_id AND m.item_type = 'artifact'
     WHERE LEFT(c.doc_id, $2) = $1
       AND m.tenant_id = $3
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
       AND (${visibilityClauses.join(" OR ")})
     GROUP BY c.doc_id
     ORDER BY c.doc_id`,
    params
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

async function recordTenantUsage({
  tenantId,
  embeddingTokens = 0,
  embeddingRequests = 0,
  generationInputTokens = 0,
  generationOutputTokens = 0,
  generationTotalTokens = 0,
  generationRequests = 0
}) {
  await ensureTenant(tenantId);
  const payload = [
    tenantId,
    Number(embeddingTokens || 0),
    Number(embeddingRequests || 0),
    Number(generationInputTokens || 0),
    Number(generationOutputTokens || 0),
    Number(generationTotalTokens || 0),
    Number(generationRequests || 0)
  ];

  await pool.query(
    `INSERT INTO tenant_usage(
        tenant_id,
        embedding_tokens,
        embedding_requests,
        generation_input_tokens,
        generation_output_tokens,
        generation_total_tokens,
        generation_requests
      )
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (tenant_id) DO UPDATE SET
       embedding_tokens = tenant_usage.embedding_tokens + EXCLUDED.embedding_tokens,
       embedding_requests = tenant_usage.embedding_requests + EXCLUDED.embedding_requests,
       generation_input_tokens = tenant_usage.generation_input_tokens + EXCLUDED.generation_input_tokens,
       generation_output_tokens = tenant_usage.generation_output_tokens + EXCLUDED.generation_output_tokens,
       generation_total_tokens = tenant_usage.generation_total_tokens + EXCLUDED.generation_total_tokens,
       generation_requests = tenant_usage.generation_requests + EXCLUDED.generation_requests,
       updated_at = NOW()`,
    payload
  );

  const rollupSql = `INSERT INTO tenant_usage_rollups(
        tenant_id,
        bucket_kind,
        bucket_start,
        embedding_tokens,
        embedding_requests,
        generation_input_tokens,
        generation_output_tokens,
        generation_total_tokens,
        generation_requests
      )
      VALUES ($1, $2, date_trunc($3, NOW()), $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id, bucket_kind, bucket_start) DO UPDATE SET
        embedding_tokens = tenant_usage_rollups.embedding_tokens + EXCLUDED.embedding_tokens,
        embedding_requests = tenant_usage_rollups.embedding_requests + EXCLUDED.embedding_requests,
        generation_input_tokens = tenant_usage_rollups.generation_input_tokens + EXCLUDED.generation_input_tokens,
        generation_output_tokens = tenant_usage_rollups.generation_output_tokens + EXCLUDED.generation_output_tokens,
        generation_total_tokens = tenant_usage_rollups.generation_total_tokens + EXCLUDED.generation_total_tokens,
        generation_requests = tenant_usage_rollups.generation_requests + EXCLUDED.generation_requests,
        updated_at = NOW()`;

  await pool.query(rollupSql, [tenantId, "hour", "hour", ...payload.slice(1)]);
  await pool.query(rollupSql, [tenantId, "day", "day", ...payload.slice(1)]);
}

async function getTenantUsage(tenantId) {
  const res = await pool.query(
    `SELECT embedding_tokens,
            embedding_requests,
            generation_input_tokens,
            generation_output_tokens,
            generation_total_tokens,
            generation_requests,
            updated_at
     FROM tenant_usage
     WHERE tenant_id = $1`,
    [tenantId]
  );
  if (!res.rows.length) {
    return {
      embedding_tokens: 0,
      embedding_requests: 0,
      generation_input_tokens: 0,
      generation_output_tokens: 0,
      generation_total_tokens: 0,
      generation_requests: 0,
      updated_at: null
    };
  }
  return res.rows[0];
}

async function getTenantUsageWindow(tenantId, window) {
  const win = String(window || "all").toLowerCase();
  if (win === "all") {
    return getTenantUsage(tenantId);
  }

  let kind = null;
  let interval = null;
  if (win === "24h" || win === "24hr" || win === "1d") {
    kind = "hour";
    interval = "24 hours";
  } else if (win === "7d" || win === "7day" || win === "7days") {
    kind = "day";
    interval = "7 days";
  } else {
    return getTenantUsage(tenantId);
  }

  const res = await pool.query(
    `SELECT COALESCE(SUM(embedding_tokens), 0)::bigint AS embedding_tokens,
            COALESCE(SUM(embedding_requests), 0)::bigint AS embedding_requests,
            COALESCE(SUM(generation_input_tokens), 0)::bigint AS generation_input_tokens,
            COALESCE(SUM(generation_output_tokens), 0)::bigint AS generation_output_tokens,
            COALESCE(SUM(generation_total_tokens), 0)::bigint AS generation_total_tokens,
            COALESCE(SUM(generation_requests), 0)::bigint AS generation_requests
     FROM tenant_usage_rollups
     WHERE tenant_id = $1
       AND bucket_kind = $2
       AND bucket_start >= NOW() - INTERVAL '${interval}'`,
    [tenantId, kind]
  );
  return res.rows[0] || {
    embedding_tokens: 0,
    embedding_requests: 0,
    generation_input_tokens: 0,
    generation_output_tokens: 0,
    generation_total_tokens: 0,
    generation_requests: 0
  };
}

async function getTenantStorageStats(tenantId) {
  const pattern = `${tenantId}::%`;
  const res = await pool.query(
    `SELECT COUNT(*)::bigint AS chunks,
            COALESCE(SUM(LENGTH(text)), 0)::bigint AS bytes
     FROM chunks
     WHERE doc_id LIKE $1`,
    [pattern]
  );
  return res.rows[0] || { chunks: 0, bytes: 0 };
}

async function getTenantItemStats(tenantId) {
  const res = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE item_type = 'artifact')::bigint AS documents,
            COUNT(*)::bigint AS memory_items,
            COUNT(DISTINCT collection)::bigint AS collections
     FROM memory_items
     WHERE tenant_id = $1`,
    [tenantId]
  );
  return res.rows[0] || { documents: 0, memory_items: 0, collections: 0 };
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
  getChunksByDocId,
  deleteDoc,
  countChunks,
  listChunksAfter,
  listDocsByTenant,
  upsertMemoryArtifact,
  upsertMemoryItem,
  getMemoryItemsByNamespaceIds,
  getMemoryItemById,
  deleteMemoryItemById,
  getArtifactByExternalId,
  listExpiredMemoryItems,
  listMemoryItemsForCompaction,
  createMemoryLink,
  createMemoryJob,
  updateMemoryJob,
  getMemoryJobById,
  ensureTenant,
  getUserByUsername,
  createUser,
  upsertSsoUser,
  recordFailedLogin,
  recordSuccessfulLogin,
  recordTenantUsage,
  getTenantUsage,
  getTenantUsageWindow,
  getTenantStorageStats,
  getTenantItemStats,
  getIdempotencyKey,
  beginIdempotencyKey,
  touchIdempotencyKey,
  completeIdempotencyKey,
  createServiceToken,
  listServiceTokens,
  getServiceTokenByHash,
  recordServiceTokenUse,
  revokeServiceToken,
  deleteMemoryItemsByCollection,
  listMemoryJobs,
  runMigrations
};
