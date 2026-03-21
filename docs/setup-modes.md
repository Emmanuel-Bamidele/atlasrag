# AtlasRAG Setup Modes

This guide answers one question first: what are you actually setting up?

Most AtlasRAG confusion comes from mixing two different things:

- who runs the AtlasRAG server
- where the first machine credential comes from

Pick one setup mode and follow that mode all the way through.

## Start Here

Use this guide to classify the setup before you touch Docker, env files, or service tokens.

| Mode | You run AtlasRAG yourself? | You edit AtlasRAG server env files? | You run Docker/Compose? | Where the first service token comes from |
| --- | --- | --- | --- | --- |
| Self-host: bundled stack | Yes | Yes, `.env` | Yes | Your own bootstrap step |
| Self-host: BYO Postgres | Yes | Yes, `.env.external-postgres` or equivalent runtime env | Yes | Your own bootstrap step |
| Use an existing AtlasRAG deployment | No | No | No on the client machine | Existing AtlasRAG admin path |
| Existing deployment + your provider key | No | No | No on the client machine | Same shared-deployment token path |
| Backend-as-caller | Maybe, but only on the server side | Only on the backend / AtlasRAG server side | Only where AtlasRAG runs | Same token path as the deployment you use |
| Human admin | Maybe, if you self-host | Only where AtlasRAG runs | Only where AtlasRAG runs | Human login first, then mint machine tokens |

## Self-Host: Bundled Stack

Choose this when:

- you want the fastest path from clone to a working AtlasRAG instance
- you do not already have a Postgres deployment you want AtlasRAG to use
- you are comfortable running AtlasRAG with the bundled Compose stack

What you are setting up:

- your own AtlasRAG server
- the bundled AtlasRAG Postgres container
- your own first admin and first service token

What you are not setting up:

- a shared AtlasRAG deployment run by someone else
- a client-only integration with an already running AtlasRAG service
- your own external Postgres server for AtlasRAG

What you edit:

- `.env`

What you run:

```bash
cp .env.example .env
docker compose up -d --build
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

What you save for later:

```bash
ATLASRAG_BASE_URL=http://localhost:3000
ATLASRAG_API_KEY=YOUR_SERVICE_TOKEN
```

Read next:

- [`self-hosting.md`](self-hosting.md)

## Self-Host: Bring Your Own Postgres

Choose this when:

- you want to self-host AtlasRAG
- you already have a Postgres server, secret management, backups, or infra standards you want to keep
- you do not want the bundled AtlasRAG Postgres container as the source of truth

What you are setting up:

- your own AtlasRAG server
- your own Postgres database for AtlasRAG
- your own first admin and first service token

What you are not setting up:

- the bundled AtlasRAG Postgres container as your real database
- a shared AtlasRAG deployment run by another admin

What you edit:

- `.env.external-postgres`

What you run:

```bash
cp .env.external-postgres.example .env.external-postgres
docker compose -f docker-compose.external-postgres.yml \
  --env-file .env.external-postgres up -d --build
docker compose -f docker-compose.external-postgres.yml \
  --env-file .env.external-postgres exec gateway \
  node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

What you save for later:

```bash
ATLASRAG_BASE_URL=http://localhost:3000
ATLASRAG_API_KEY=YOUR_SERVICE_TOKEN
```

Important boundary:

- this is still self-hosted AtlasRAG
- using your own Postgres does not make it a shared AtlasRAG platform deployment

Read next:

- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)

## Use An Existing AtlasRAG Deployment

Choose this when:

- AtlasRAG is already running somewhere else
- you only need to call the API
- you do not need to operate AtlasRAG itself

What you are setting up:

- your app, backend, worker, or agent runtime to call an existing AtlasRAG service

What you are not setting up:

- the AtlasRAG server
- Docker, Compose, or Postgres on your client machine
- the first AtlasRAG service token from scratch unless you are also the admin

What you need:

- `ATLASRAG_BASE_URL`
- `ATLASRAG_API_KEY`

What you run:

```bash
export ATLASRAG_BASE_URL="https://atlasrag.example.com"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
curl -fsS "${ATLASRAG_BASE_URL}/v1/health"
```

Where the token comes from:

- an existing AtlasRAG admin gives it to you
- or you are that admin and create it through the UI or `POST /v1/admin/service-tokens`

Important boundary:

- do not run local onboarding on a machine that is only consuming a shared deployment

Read next:

- [`agents.md`](agents.md)

## Existing Deployment + Your Provider Key

Choose this when:

- AtlasRAG already exists and keeps its own Postgres/auth/runtime
- you want a request to use your own provider key instead of the server default
- you still want AtlasRAG to use the same shared deployment and service token

What changes in this mode:

- you still use the same `ATLASRAG_BASE_URL`
- you still use the same AtlasRAG service token
- you add `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` on supported sync requests
- `ask` and `boolean_ask` may also set `provider` and `model` in the JSON body

What does not change:

- AtlasRAG still owns the shared deployment and its database
- your provider key is not automatically stored as the server default
- the service token still comes from the shared deployment admin path

Important boundary:

- embedding provider selection remains instance-wide today
- request-scoped provider-key headers do not change the deployment’s embedding provider itself
- `memory/reflect` and `memory/compact` reject request-scoped provider headers because those jobs continue asynchronously

Read next:

- [`agents.md#shared-provider-key`](agents.md#shared-provider-key)

## Backend-As-Caller

Choose this when:

- your product already has its own user auth
- browsers and end users should not hold AtlasRAG machine credentials
- your backend should be the only system that talks directly to AtlasRAG

What you are setting up:

- your backend as the AtlasRAG caller of record
- server-side storage for AtlasRAG base URL, service token, and optional provider keys

What you are not setting up:

- AtlasRAG service tokens in browser code
- a different AtlasRAG credential model than the standard service-token path

Pattern:

1. the end user authenticates to your app
2. your backend decides what AtlasRAG action is allowed
3. your backend calls AtlasRAG with a service token
4. your backend returns the result

Read next:

- [`agents.md#backend-as-caller`](agents.md#backend-as-caller)

## Human Admin

Choose this when:

- a real person is configuring AtlasRAG
- you need interactive login for the UI
- you are creating tenant settings, SSO config, or service tokens for machines

What this mode is for:

- sign in as a human admin
- use the browser UI
- create machine tokens for apps, backends, and agents

What this mode is not for:

- long-running app or agent runtime auth
- replacing the normal service-token path for automation

Read next:

- [`agents.md#human-jwt`](agents.md#human-jwt)

## Common Rules

- Service tokens are deployment-scoped. A token minted by one AtlasRAG deployment does not authenticate against another deployment.
- For apps, backends, workers, and agents, the normal runtime inputs are `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`.
- Username/password is mainly for bootstrap and human admin login.
- Bundled Postgres and external Postgres are both still self-hosted AtlasRAG.
- Shared deployment users normally do not edit AtlasRAG server env files or Compose files on the client machine.

## Common Mistakes

- Running `atlasrag onboard` on a laptop that is only consuming an already running shared deployment.
- Assuming `--external-postgres` means “AtlasRAG-hosted platform” instead of “your self-hosted AtlasRAG uses your own Postgres”.
- Copying a service token from one AtlasRAG deployment and expecting it to work against another deployment.
- Storing long-lived admin or service tokens in browser code when your backend could hold them instead.
- Expecting request-scoped provider headers to permanently reconfigure the server’s default provider settings.

## If You Are Still Unsure

Use this rule:

- If you are cloning the repo and running Docker yourself, you are in a self-hosted mode.
- If somebody already gave you `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`, you are in a shared-deployment mode.
- If your backend is the only thing that should know the AtlasRAG token, choose backend-as-caller.
- If a human is signing in to manage AtlasRAG, use the human-admin path.

Then follow the linked guide for that mode all the way through before mixing in another setup pattern.
