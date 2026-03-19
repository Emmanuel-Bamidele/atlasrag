# AtlasRAG

AtlasRAG is a self-hosted memory and retrieval platform for AI agents. It combines a C++ vector store, a Node.js gateway, and Postgres-backed metadata/auth/jobs so teams can ingest documents, search them, ask grounded questions, and manage long-term memory with tenant-aware controls.

Current public scope: single-node self-hosted deployment. You run it in your own environment and bring your own model provider credentials.

## What Is In This Repo

- `mini_redis/`: C++ vector server used for embedding storage and similarity search.
- `gateway/`: Node.js/Express gateway, auth, APIs, public docs UI, and background jobs.
- `sdk/node/`: small Node SDK for API consumers.
- `experiments/`: experiment harness and telemetry analysis for AMV-L vs TTL vs LRU.
- `docker-compose.yml`: local/self-hosted stack.
- `docker-compose.prod.yml`: production-oriented stack with proxy/TLS wiring.

## Architecture

- C++ vector core for fast vector operations.
- Node gateway for auth, API routing, RAG answer generation, memory workflows, and docs.
- Postgres for persistent metadata, auth records, jobs, tenant settings, and memory state.
- Optional OpenAI-backed embeddings/answer generation with fallbacks when unavailable.

## Quickstart

### Prerequisites

- Docker with the Compose plugin
- An OpenAI API key for normal retrieval/answer quality

`OPENAI_API_KEY` is strongly recommended. The server can fall back in some paths, but quality will be lower.

### 1. Configure Environment

Copy the example env file and edit the small set of values you actually need:

```bash
cp .env.example .env
```

Update at least:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `COOKIE_SECRET`
- `OPENAI_API_KEY`

### 2. Start The Stack

```bash
docker compose up -d --build
```

Check health:

```bash
curl -sS http://localhost:3000/health
```

Expected response:

```json
{"ok":true}
```

### 3. Create The First Admin User

Run this inside the gateway container so it can use the configured database connection:

```bash
docker compose exec gateway node scripts/create_user.js \
  --username admin \
  --password change_me \
  --tenant default \
  --role admin
```

### 4. Log In

```bash
curl -sS http://localhost:3000/v1/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"change_me"}'
```

Copy the JWT from `data.token` in the response and export it:

```bash
export TOKEN='<paste token here>'
```

### 5. Index A Document

```bash
curl -sS http://localhost:3000/v1/docs \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-doc-1' \
  -d '{
    "docId":"welcome",
    "text":"AtlasRAG stores memory for agents and returns grounded answers with citations."
  }'
```

### 6. Ask A Question

```bash
curl -sS http://localhost:3000/v1/ask \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{
    "question":"What does AtlasRAG store?",
    "k":3
  }'
```

## Local Endpoints

After startup, these are the main local URLs:

- App and public UI: `http://localhost:3000/`
- Health: `http://localhost:3000/health`
- API docs UI: `http://localhost:3000/docs`
- Public OpenAPI spec: `http://localhost:3000/openapi.public.json`
- MCP endpoint: `http://localhost:3000/mcp`
- LLM discovery file: `http://localhost:3000/llms.txt`

## Common Operations

Stop the stack:

```bash
docker compose down
```

Reset local data volumes:

```bash
docker compose down -v
```

View logs:

```bash
docker compose logs -f gateway
docker compose logs -f postgres
docker compose logs -f redis
```

## Development

The Docker path is the default way to run the project. If you want to work on the gateway directly:

```bash
cd gateway
npm ci
npm run test:unit
```

With the stack running, you can also run:

```bash
npm run test:integration
npm run test:e2e
```

The main CI workflow is defined in `.github/workflows/gateway-ci.yml`.

## Production Notes

The production compose file is available at `docker-compose.prod.yml` with example settings in `.env.prod.example`.

Before using it for any real deployment:

- set a real public domain and email
- use strong secrets
- review proxy and TLS settings
- set `STUNNEL_CERTS_DIR` to a server-only directory outside the repository
- replace any sample or development certificate material with your own

The production compose file now supports an external cert directory for the internal `stunnel` hop. If `STUNNEL_CERTS_DIR` is unset, it falls back to `./deploy/certs` for backward compatibility with existing deployments.

## SDK And Experiments

- Node SDK: [`sdk/node/README.md`](sdk/node/README.md)
- Experiment suite: [`experiments/README.md`](experiments/README.md)

## Project Docs

- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: [`SECURITY.md`](SECURITY.md)
- Support expectations: [`SUPPORT.md`](SUPPORT.md)
- Stunnel cert layout: [`deploy/stunnel/README.md`](deploy/stunnel/README.md)

## Current Scope

AtlasRAG is currently documented for self-hosted use. It is not presented here as a managed hosted service.
