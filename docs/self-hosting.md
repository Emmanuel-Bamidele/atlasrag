# AtlasRAG Self-Hosting Guide

This guide is for teams who want to fork or clone AtlasRAG and run it themselves without relying on a hosted AtlasRAG service.

## Scope

Current public scope is:

- single-node self-hosted deployment
- Docker Compose friendly
- bring your own OpenAI key
- Postgres-backed metadata and auth
- service-token-first runtime usage for apps and agents

This guide does not assume Kubernetes, managed control planes, or automatic multi-instance provisioning.

If you already have your own Postgres and do not want to run the bundled database container, use:

- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
- [`../docker-compose.external-postgres.yml`](../docker-compose.external-postgres.yml)
- [`../.env.external-postgres.example`](../.env.external-postgres.example)

## What You Are Running

AtlasRAG has three core runtime pieces:

- `gateway/`
  Node.js API layer, auth, docs UI, jobs, and RAG orchestration
- `atlasrag/`
  the vector store used for embedding storage and retrieval
- Postgres
  persistent state for users, tenants, tokens, jobs, chunks, and memory metadata

In local Compose, the repo starts all of these for you.

## Recommended Auth Model

Use AtlasRAG like this:

- humans use username/password or SSO for admin actions and the browser UI
- apps, backends, workers, and agents use a service token
- if a caller wants AtlasRAG to use its own OpenAI key while still using this AtlasRAG deployment, it can send `X-OpenAI-API-Key` on supported sync requests

That means your normal machine runtime should keep:

```bash
ATLASRAG_BASE_URL=http://localhost:3000
ATLASRAG_API_KEY=...
```

You should not design your runtime around repeated human login calls.

## Prerequisites

Before you start, have:

- Docker with the Compose plugin
- an OpenAI API key for normal embedding and answer quality
- a machine that can run Docker containers and persist volumes

Recommended baseline:

- 4 CPU cores
- 8 GB RAM
- persistent disk for Postgres and vector WAL data

## Quickstart Path

### 1. Clone Or Fork The Repo

```bash
git clone <your-fork-or-repo-url>
cd atlasrag
```

### 2. Create The Local Env File

```bash
cp .env.example .env
```

Edit at least these values:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `COOKIE_SECRET`
- `OPENAI_API_KEY`

Useful optional values:

- `PUBLIC_BASE_URL`
- `OPENAPI_BASE_URL`
- `GATEWAY_HOST_PORT`
- `POSTGRES_HOST_PORT`

### 3. Start The Stack

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

If you want the external-Postgres path instead, do not use the stock Compose file above. Use:

```bash
cp .env.external-postgres.example .env.external-postgres
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres up -d --build
```

### 4. Bootstrap The First Admin And Service Token

This is the recommended first-run step:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

What this does:

- ensures the tenant exists
- creates or updates the local admin user
- creates a fresh service token
- prints the runtime values your app or agent should store

Save the printed token immediately. The API does not show it again later.

### 5. Export Runtime Env For Your App Or Agent

```bash
export ATLASRAG_BASE_URL="http://localhost:3000"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
```

### 6. Index A Document

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "Idempotency-Key: demo-doc-1" \
  -H "Content-Type: application/json" \
  -d '{
    "docId":"welcome",
    "collection":"default",
    "text":"AtlasRAG stores memory for agents and returns grounded answers with citations."
  }'
```

### 7. Ask A Question

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"What does AtlasRAG store?",
    "k":3,
    "policy":"amvl"
  }'
```

### 8. Ask A Strict True/False Question

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/boolean_ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"Does AtlasRAG store memory for agents?",
    "k":3,
    "policy":"amvl"
  }'
```

This returns only `true`, `false`, or `invalid`. Use it when the caller needs a grounded binary answer instead of a freeform response, and inspect `supportingChunks` when the caller needs the exact evidence text.

### 9. Optional: Bring Your Own OpenAI Key To A Shared AtlasRAG Deployment

If you are using an AtlasRAG instance that already has its own Postgres and auth, but you want your requests to use your own OpenAI key, add:

```bash
-H "X-OpenAI-API-Key: ${OPENAI_API_KEY}"
```

This works on supported sync request paths such as:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/boolean_ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

It is intentionally request-scoped. AtlasRAG does not persist that key for the tenant.

Current limitation:

- `POST /v1/memory/reflect`
- `POST /v1/memory/compact`

Those endpoints continue work asynchronously after the request ends, so they reject `X-OpenAI-API-Key` today.

## What Bootstrap Solves

Fork users often get stuck on first credentials. The bootstrap script exists so they do not need to:

- inspect the database manually
- hand-write SQL
- log in first just to create the first token

Bootstrap is intentionally optional and non-invasive. It does not change runtime behavior unless you invoke it.

If you only want a human admin user and do not want a service token yet, you can still use:

```bash
docker compose exec gateway node scripts/create_user.js \
  --username admin \
  --password change_me \
  --tenant default \
  --role admin
```

## Local URLs

Once the stack is running, the main local URLs are:

- app and UI: `http://localhost:3000/`
- health: `http://localhost:3000/health`
- API docs: `http://localhost:3000/docs`
- public OpenAPI schema: `http://localhost:3000/openapi.public.json`
- MCP endpoint: `http://localhost:3000/mcp`
- LLM discovery file: `http://localhost:3000/llms.txt`

## Daily Operations

### Stop The Stack

```bash
docker compose down
```

### Restart The Stack

```bash
docker compose up -d
```

### View Logs

```bash
docker compose logs -f gateway
docker compose logs -f postgres
docker compose logs -f redis
```

### Reset Local Volumes

Use this only when you want to wipe local state:

```bash
docker compose down -v
```

This removes:

- Postgres data
- vector store WAL / persisted vector data

## Upgrade Flow

For a self-hosted upgrade:

1. update the installed checkout with `atlasrag update`, or pull the new repo version manually
2. review changes to `.env.example`, `docker-compose.yml`, and `README.md`
3. confirm your secrets and runtime env are still correct
4. redeploy with:

```bash
docker compose up -d --build
```

5. verify health
6. run a smoke test: login or service token auth, one ingest, one ask

## Backups

AtlasRAG state lives in two places:

- Postgres
- vector store data volume

For serious self-hosting, back up both.

Recommended backup approach:

- Postgres logical dump or managed database backup
- filesystem or volume backup for vector data

Minimum rule:

- do not rely on container recreation alone
- do not treat Docker volumes as a backup strategy

## Security Checklist

Before exposing a public instance:

- replace all placeholder secrets
- keep `OPENAI_API_KEY`, `JWT_SECRET`, `COOKIE_SECRET`, and DB credentials outside version control
- never expose service tokens to browsers unless that is explicitly your design
- use service tokens for server-to-server traffic
- keep admin tokens scoped and rotated
- review `ALLOW_PRINCIPAL_OVERRIDE` before enabling it
- in production, externalize `stunnel` certs using `STUNNEL_CERTS_DIR`
- use real TLS and a real public base URL

## Production Notes

The stock `docker-compose.prod.yml` exists for production-style deployments, but it is still meant to be operated by the self-hosting team.

Important production details:

- `STUNNEL_CERTS_DIR` should point to a server-only path outside the repo
- `COOKIE_SECURE` should be enabled behind HTTPS
- `PUBLIC_BASE_URL` and `OPENAPI_BASE_URL` should match your external hostname
- strong secrets are mandatory

For more detail on internal TLS cert layout, see:

- [`../deploy/stunnel/README.md`](../deploy/stunnel/README.md)

## Troubleshooting

### Health Check Fails

Check:

- `docker compose ps`
- `docker compose logs gateway`
- `docker compose logs postgres`
- `docker compose logs redis`

Most common causes:

- invalid or missing env values
- Postgres not ready yet
- gateway container failed to boot

### Login Works But Agent Calls Fail

Usually one of:

- wrong `ATLASRAG_API_KEY`
- token expired or revoked
- using JWT where the runtime expects a service token
- missing `Idempotency-Key` on write endpoints

### Answers Are Weak Or Generic

Check:

- `OPENAI_API_KEY` is valid
- documents were actually indexed
- your query is hitting the right `collection`
- you are using the intended `policy` (`amvl`, `ttl`, or `lru`)

### UI Changes Do Not Appear

If you serve the UI from Docker, rebuild the gateway image:

```bash
docker compose up -d --build gateway
```

Then hard-refresh the browser.

## Next Guides

After this guide, use:

- [`bring-your-own-postgres.md`](bring-your-own-postgres.md) if you already have Postgres and secret management
- [`agents.md`](agents.md) if you are wiring AtlasRAG into an app backend or AI runtime
