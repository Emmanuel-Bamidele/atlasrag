-- schema.sql
-- Stores chunk text so it survives restarts.

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id TEXT PRIMARY KEY,     -- e.g. "doc1#0"
  doc_id   TEXT NOT NULL,        -- e.g. "doc1"
  idx      INT  NOT NULL,        -- chunk index
  text     TEXT NOT NULL         -- original chunk text
);

CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks(doc_id);

