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
