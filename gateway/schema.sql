-- schema.sql
-- Stores chunk text so it survives restarts.

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,     -- e.g. "doc1#0"
  doc_id   TEXT NOT NULL,        -- e.g. "doc1"
  idx      INT  NOT NULL,        -- chunk index
  text     TEXT NOT NULL         -- original chunk text
);

CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id);

-- Tenants and users (production auth)
CREATE TABLE IF NOT EXISTS tenants (
  tenant_id TEXT PRIMARY KEY,
  name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  disabled BOOLEAN DEFAULT FALSE,
  sso_only BOOLEAN DEFAULT FALSE,
  auth_provider TEXT,
  auth_subject TEXT,
  email TEXT,
  full_name TEXT,
  failed_attempts INT DEFAULT 0,
  lock_until TIMESTAMPTZ,
  last_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_tenant_id_idx ON users(tenant_id);

-- Memory items, links, and jobs
CREATE TABLE IF NOT EXISTS memory_items (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  collection TEXT NOT NULL,
  item_type TEXT NOT NULL,
  external_id TEXT,
  principal_id TEXT,
  visibility TEXT DEFAULT 'tenant',
  acl_principals TEXT[],
  title TEXT,
  source_type TEXT,
  source_url TEXT,
  metadata JSONB,
  parent_id TEXT REFERENCES memory_items(id) ON DELETE CASCADE,
  namespace_id TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_items_tenant_collection_idx ON memory_items(tenant_id, collection);
CREATE INDEX IF NOT EXISTS memory_items_parent_idx ON memory_items(parent_id);
CREATE INDEX IF NOT EXISTS memory_items_expires_idx ON memory_items(tenant_id, expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS memory_items_artifact_unique_idx ON memory_items(tenant_id, collection, item_type, external_id);

CREATE TABLE IF NOT EXISTS memory_links (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  from_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  to_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
  relation TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_links_tenant_idx ON memory_links(tenant_id);
CREATE INDEX IF NOT EXISTS memory_links_from_idx ON memory_links(from_item_id);
CREATE INDEX IF NOT EXISTS memory_links_to_idx ON memory_links(to_item_id);

CREATE TABLE IF NOT EXISTS memory_jobs (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  input JSONB,
  output JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_jobs_tenant_idx ON memory_jobs(tenant_id);

-- Idempotency keys (hard guarantees for writes)
CREATE TABLE IF NOT EXISTS idempotency_keys (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress',
  response_status INT,
  response_body JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, endpoint, idem_key)
);

CREATE INDEX IF NOT EXISTS idempotency_keys_tenant_idx ON idempotency_keys(tenant_id);

-- Service tokens (API keys) for server-to-server integrations
CREATE TABLE IF NOT EXISTS service_tokens (
  id SERIAL PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  key_hash TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_tokens_tenant_idx ON service_tokens(tenant_id);
CREATE INDEX IF NOT EXISTS service_tokens_principal_idx ON service_tokens(tenant_id, principal_id);

-- Tenant usage counters (billing-ready)
CREATE TABLE IF NOT EXISTS tenant_usage (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  embedding_tokens BIGINT DEFAULT 0,
  embedding_requests BIGINT DEFAULT 0,
  generation_input_tokens BIGINT DEFAULT 0,
  generation_output_tokens BIGINT DEFAULT 0,
  generation_total_tokens BIGINT DEFAULT 0,
  generation_requests BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_usage_rollups (
  tenant_id TEXT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  bucket_kind TEXT NOT NULL,
  bucket_start TIMESTAMPTZ NOT NULL,
  embedding_tokens BIGINT DEFAULT 0,
  embedding_requests BIGINT DEFAULT 0,
  generation_input_tokens BIGINT DEFAULT 0,
  generation_output_tokens BIGINT DEFAULT 0,
  generation_total_tokens BIGINT DEFAULT 0,
  generation_requests BIGINT DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (tenant_id, bucket_kind, bucket_start)
);

CREATE INDEX IF NOT EXISTS tenant_usage_rollups_idx
  ON tenant_usage_rollups(tenant_id, bucket_kind, bucket_start);

-- Idempotent migrations for existing databases
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS failed_attempts INT DEFAULT 0;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS lock_until TIMESTAMPTZ;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS sso_only BOOLEAN DEFAULT FALSE;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS auth_provider TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS auth_subject TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS full_name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_auth_provider_subject_idx ON users(auth_provider, auth_subject);
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS principal_id TEXT;
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS visibility TEXT DEFAULT 'tenant';
ALTER TABLE IF EXISTS memory_items ADD COLUMN IF NOT EXISTS acl_principals TEXT[];
UPDATE memory_items SET visibility = 'tenant' WHERE visibility IS NULL;

-- Indexes added after migrations so columns always exist
CREATE INDEX IF NOT EXISTS memory_items_principal_idx ON memory_items(tenant_id, principal_id);
CREATE INDEX IF NOT EXISTS memory_items_visibility_idx ON memory_items(tenant_id, visibility);
CREATE INDEX IF NOT EXISTS memory_items_acl_idx ON memory_items USING GIN (acl_principals);
