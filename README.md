# AtlasRAG

AtlasRAG is a self-hosted memory and retrieval platform for AI agents. It combines a C++ vector store, a Node.js gateway, and Postgres-backed metadata/auth/jobs so teams can ingest documents, search them, ask grounded questions, and manage long-term memory with tenant-aware controls.

Current public scope: single-node self-hosted deployment. You run it in your own environment and bring your own model provider credentials.

## Main Surfaces

- `gateway/`: Node.js/Express gateway, auth, APIs, public docs UI, and background jobs.
- `atlasrag/`: C++ vector server used for embedding storage and similarity search.
- `sdk/node/`: small Node SDK for API consumers.
- `docs/`: setup, deployment, and agent integration guides.
- `scripts/install.sh` and `scripts/install.ps1`: CLI installer entrypoints for local setup.
- `docker-compose.yml`: local/self-hosted stack.
- `docker-compose.external-postgres.yml`: self-hosted stack that uses your existing Postgres.
- `docker-compose.prod.yml`: production-oriented stack with proxy/TLS wiring.

## Architecture

- C++ vector core for fast vector operations.
- Node gateway for auth, API routing, RAG answer generation, memory workflows, and docs.
- Postgres for persistent metadata, auth records, jobs, tenant settings, and memory state.
- Optional OpenAI-backed embeddings/answer generation with fallbacks when unavailable.

## Recommended Integration Model

- Human admins use username/password or SSO to manage the instance.
- Apps, backends, workers, and agents should use a service token.
- If you want AtlasRAG to keep its own Postgres/auth/runtime but use your own OpenAI key, send `X-OpenAI-API-Key` on supported sync requests.
- If you already have your own application auth, keep it there and let your backend call AtlasRAG server-to-server.
- AtlasRAG can run against your existing Postgres by wiring `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` into the gateway runtime environment or a custom Compose file.

## Developer And Agent Decision Matrix

If you are not sure which path to use, choose based on the kind of deployment and ownership model you want.

| Usage mode | Best when | Read first |
| --- | --- | --- |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working AtlasRAG instance | [Self-hosting guide](docs/self-hosting.md) |
| Fork and self-deploy with your own Postgres and OpenAI key | You already have database/secrets infrastructure and want AtlasRAG inside your environment | [Bring your own Postgres](docs/bring-your-own-postgres.md) |
| Use a shared AtlasRAG deployment | AtlasRAG already has its own Postgres/auth/runtime and your app or agent just needs to call it | [Apps, backends, and agents](docs/agents.md) |
| Use a shared AtlasRAG deployment with your own OpenAI key | AtlasRAG keeps the shared Postgres/auth/runtime, but each request should use your provider key | [Shared AtlasRAG, your OpenAI key](docs/agents.md#shared-openai-key) |
| Keep your own product auth and place AtlasRAG behind your backend | End users should not log into AtlasRAG directly | [Backend-as-caller](docs/agents.md#backend-as-caller) |
| Use AtlasRAG mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [Human JWT](docs/agents.md#human-jwt) |

## Quickstart

### Prerequisites

- Docker with the Compose plugin
- Node.js 18+ if you want to use the AtlasRAG CLI
- Git if you want the installer to clone or refresh the repo for you
- An OpenAI API key for normal retrieval/answer quality

`OPENAI_API_KEY` is strongly recommended. The server can fall back in some paths, but quality will be lower.

### AtlasRAG CLI (recommended)

AtlasRAG ships with a CLI for onboarding, stack operations, and basic API usage.

Install from a local checkout:

```bash
./scripts/install.sh
```

Install from a one-line remote command:

```bash
curl -fsSL https://raw.githubusercontent.com/Emmanuel-Bamidele/atlasrag/main/scripts/install.sh | bash
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Or the one-line remote version:

```powershell
irm https://raw.githubusercontent.com/Emmanuel-Bamidele/atlasrag/main/scripts/install.ps1 | iex
```

Then run the onboarding wizard:

```bash
atlasrag onboard
```

The wizard prompts for:

- admin username
- admin password
- OpenAI API key
- tenant id
- optional external Postgres values if you choose the BYO Postgres path

During onboarding, the CLI also:

- writes the local env file
- starts the Docker stack
- runs the bootstrap helper for you
- creates the first admin and the first service token
- saves the base URL and service token in `~/.atlasrag/config.json`

If you are using AtlasRAG from this same computer through the CLI, you do not need to copy the token anywhere. Later CLI commands use the saved service token automatically.

After onboarding, you can run:

```bash
atlasrag status
atlasrag write --doc-id welcome --collection local-demo --text "AtlasRAG stores memory for agents."
atlasrag search --q "memory for agents" --collection local-demo --k 5
atlasrag ask --question "What does AtlasRAG store?" --collection local-demo
atlasrag logs
atlasrag doctor
```

You can also ingest a whole folder of acceptable text files. If you omit `--collection`, the folder name becomes the collection name:

```bash
atlasrag write --folder ./customer-support
atlasrag search --q "refund policy" --collection customer-support --k 5
```

If you are wiring your own app, backend, worker, or agent on the same machine, export the saved values into your runtime env:

```bash
export ATLASRAG_BASE_URL="http://localhost:3000"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
```

The token is shown during onboarding. If you need to inspect it again locally, run:

```bash
atlasrag config show --show-secrets
```

Do not commit those values to git.

If AtlasRAG is already deployed online behind nginx or another public proxy, use the CLI as a remote client instead of onboarding locally:

```bash
export ATLASRAG_BASE_URL="https://YOUR_DOMAIN"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
atlasrag write --doc-id cli-test --collection cli-smoke --text "AtlasRAG CLI remote test."
atlasrag search --q "remote test" --collection cli-smoke --k 3
atlasrag ask --question "What does the CLI test document say?" --collection cli-smoke
```

In that remote path, Docker is not required on the client machine. `atlasrag onboard` is for local self-hosting; `write`, `search`, and `ask` are the main commands for testing a live deployment.

Use the CLI when you want the fastest path from install to a working local deployment. Use the manual Docker steps below if you want to see and control each setup step explicitly.

### 1. Configure Environment (manual path)

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

### 3. Bootstrap The First Admin And Service Token

Recommended path for developers and agents:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

That command ensures the admin user exists, creates a fresh service token, and prints the `ATLASRAG_BASE_URL` / `ATLASRAG_API_KEY` values your app or agent can use directly.

If you run the gateway directly from source instead of Docker:

```bash
cd gateway
npm run bootstrap:instance -- \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

Export the printed values:

```bash
export ATLASRAG_BASE_URL="http://localhost:3000"
export ATLASRAG_API_KEY="<paste service token here>"
```

### 3b. Optional Third Mode: Your OpenAI Key, Shared AtlasRAG Deployment

If you are using an AtlasRAG deployment that already has its own Postgres and auth, but you want requests to use your OpenAI key instead of the server default, send:

```bash
-H "X-OpenAI-API-Key: ${OPENAI_API_KEY}"
```

This is request-scoped. It does not create a tenant-level provider setting or store your OpenAI key in Postgres.

Supported sync request paths:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

Current limitation:

- `POST /v1/memory/reflect` and `POST /v1/memory/compact` reject `X-OpenAI-API-Key` because those jobs continue asynchronously after the request ends.

If you only want a human admin login and do not want a service token yet, use the older bootstrap command instead:

```bash
docker compose exec gateway node scripts/create_user.js \
  --username admin \
  --password change_me \
  --tenant default \
  --role admin
```

### 4. Index A Document From Your App Or Agent

Use the service token for normal machine-to-machine traffic:

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: demo-doc-1' \
  -d '{
    "docId":"welcome",
    "text":"AtlasRAG stores memory for agents and returns grounded answers with citations."
  }'
```

### 5. Ask A Question From Your App Or Agent

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H 'content-type: application/json' \
  -d '{
    "question":"What does AtlasRAG store?",
    "k":3,
    "policy":"amvl"
  }'
```

### 6. Optional: Log In As A Human Admin

```bash
curl -sS http://localhost:3000/v1/login \
  -H 'content-type: application/json' \
  -d '{"username":"admin","password":"change_me"}'
```

Copy the JWT from `data.token` in the response and export it:

```bash
export TOKEN='<paste token here>'
```

Use JWTs for the browser UI, admin setup, or cases where a human is signing in interactively. For apps and agents, prefer the service token flow above.

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

## Bring Your Own Postgres And Env

AtlasRAG does not require a bundled Postgres container in production. If your stack already has Postgres and secret management, point the gateway at your existing values:

- `PGHOST`
- `PGPORT`
- `PGDATABASE`
- `PGUSER`
- `PGPASSWORD`
- `OPENAI_API_KEY`
- `JWT_SECRET`
- `COOKIE_SECRET`

The stock `docker-compose.yml` is optimized for the bundled `postgres` service. If you want external Postgres, use the official `docker-compose.external-postgres.yml` path below or your own runtime wiring for the gateway.

AtlasRAG includes an official external-Postgres path:

```bash
cp .env.external-postgres.example .env.external-postgres
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres up -d --build
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres exec gateway \
  node scripts/bootstrap_instance.js --username admin --password change_me --tenant default --service-token-name app-bootstrap
```

Then run the bootstrap helper once to create the first admin and service token. After that, your backend or agent can call AtlasRAG with `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY` without repeated human login.

## Production Notes

The production compose file is available at `docker-compose.prod.yml` with example settings in `.env.prod.example`.

Before using it for any real deployment:

- set a real public domain and email
- use strong secrets
- review proxy and TLS settings
- set `STUNNEL_CERTS_DIR` to a server-only directory outside the repository
- replace any sample or development certificate material with your own

The production compose file now supports an external cert directory for the internal `stunnel` hop. If `STUNNEL_CERTS_DIR` is unset, it falls back to `./deploy/certs` for backward compatibility with existing deployments.

## SDK And Guides

- Node SDK: [`sdk/node/README.md`](sdk/node/README.md)
- Guides index: [`docs/README.md`](docs/README.md)

## Project Docs

- Self-hosting guide: [`docs/self-hosting.md`](docs/self-hosting.md)
- Bring your own Postgres: [`docs/bring-your-own-postgres.md`](docs/bring-your-own-postgres.md)
- Agent integration guide: [`docs/agents.md`](docs/agents.md)
- External Postgres env template: [`.env.external-postgres.example`](.env.external-postgres.example)
- Contributing: [`CONTRIBUTING.md`](CONTRIBUTING.md)
- Security reporting: [`SECURITY.md`](SECURITY.md)
- Support expectations: [`SUPPORT.md`](SUPPORT.md)
- Stunnel cert layout: [`deploy/stunnel/README.md`](deploy/stunnel/README.md)

## Current Scope

AtlasRAG is currently documented for self-hosted use. It is not presented here as a managed hosted service.
