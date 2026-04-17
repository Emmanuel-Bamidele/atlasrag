# SupaVector With Your Own Postgres

This guide is for teams that already have:

- an existing Postgres server or managed Postgres service
- their own secret management
- their own deployment conventions

This is the right path if you do not want SupaVector to own your database lifecycle.

If you are not yet sure whether you should self-host SupaVector with your own Postgres versus use an existing shared deployment, start with [`setup-modes.md`](setup-modes.md) first.

If this deployment also needs enterprise SSO, tenant access controls, or hosted-vs-self-hosted rollout guidance, read [`enterprise.md`](enterprise.md) after this guide.

## Important Current Behavior

The stock `docker-compose.yml` and `docker-compose.prod.yml` are optimized for the bundled `postgres` service in this repo.

That means:

- the gateway container is wired to `PGHOST=postgres` in the stock Compose files
- the bundled Postgres container is the default local path
- dropping `PGHOST` into `.env` alone does not automatically switch the stock Compose deployment to your external database

If you want external Postgres, use one of these approaches:

1. use the official `docker-compose.external-postgres.yml`
2. run SupaVector in your own container/orchestrator setup
3. maintain your own runtime wiring around the gateway and vector service

This guide now uses the first approach because it is the cleanest built-in path for fork users.

## Recommended Database Layout

Use:

- a separate database for SupaVector, if possible
- a dedicated Postgres user for SupaVector
- credentials managed outside Git

This is better than sharing the same database/schema with an unrelated application because SupaVector relies on its own tables, indexes, and migration/bootstrap flow.

## Postgres Features SupaVector Uses

SupaVector expects standard Postgres behavior including:

- `ON CONFLICT`
- `JSONB`
- array columns
- full-text search via `to_tsvector` and `websearch_to_tsquery` for the lexical side of hybrid retrieval

You do not need a separate vector extension for SupaVector's current architecture because vector storage is handled by the bundled vector service, not by Postgres. Postgres provides the lexical retrieval half of the default hybrid search path.

Phase 2 retrieval correctness also leans on Postgres for pre-retrieval filtering and freshness-aware ordering. The bundled schema now adds source-type, document-type, created-at, and freshness expression indexes so namespace, tag, document-type, source-type, and time-window filtering stay practical on external Postgres deployments too.

## Minimum Runtime Env

At minimum, the gateway needs:

```bash
PGHOST=db.example.internal
PGPORT=5432
PGDATABASE=supavector
PGUSER=supavector
PGPASSWORD=change_me

OPENAI_API_KEY=...
JWT_SECRET=...
COOKIE_SECRET=...
PUBLIC_BASE_URL=https://supavector.example.com
OPENAPI_BASE_URL=https://supavector.example.com
COOKIE_SECURE=1
```

You will usually also want:

```bash
MIGRATIONS_AUTO=1
MIGRATIONS_ATTEMPTS=15
MIGRATIONS_DELAY_MS=2000
```

## Recommended Compose Layout

If you want Docker Compose but not the bundled Postgres container, use the official external-Postgres Compose file that runs:

- `redis`
- `gateway`

and points the gateway at your external Postgres.

Files:

- [`../docker-compose.external-postgres.yml`](../docker-compose.external-postgres.yml)
- [`../.env.external-postgres.example`](../.env.external-postgres.example)

Recommended setup:

```bash
cp .env.external-postgres.example .env.external-postgres
```

Edit:

- `PGHOST`
- `PGPORT`
- `PGDATABASE`
- `PGUSER`
- `PGPASSWORD`
- `OPENAI_API_KEY`
- `JWT_SECRET`
- `COOKIE_SECRET`

Then start it:

```bash
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres up -d --build
```

Health check:

```bash
curl -sS http://localhost:3000/health
```

## Schema Bootstrap And Migrations

You have two bootstrap layers:

- gateway startup migration/bootstrap behavior
- the standalone `bootstrap_instance.js` helper

Recommended sequence:

1. start `redis` and `gateway`
2. let the gateway run with `MIGRATIONS_AUTO=1`
3. run the bootstrap helper once to create the first admin and service token

Bootstrap command:

```bash
docker compose -f docker-compose.external-postgres.yml --env-file .env.external-postgres \
  exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name app-bootstrap
```

## Secret Management

If you already have a secret manager, use it.

Typical mapping:

- `PGPASSWORD` from your database secret
- one or more model-provider secrets such as `OPENAI_API_KEY`, `GEMINI_API_KEY`, or `ANTHROPIC_API_KEY`
- `JWT_SECRET` and `COOKIE_SECRET` from your application secret store
- service tokens stored with the same care as any other internal API key

Avoid:

- committing `.env` files
- embedding secrets into images
- printing long-lived tokens into public CI logs

## App Auth Versus SupaVector Auth

If your product already has its own user auth, do not force every end user to authenticate directly to SupaVector.

Recommended pattern:

1. your app authenticates its own users
2. your backend calls SupaVector with a service token
3. your backend passes `principalId` and `privileges` only when you intentionally enable server-side principal override

For most teams, SupaVector should be an internal service inside the app stack, not a second end-user identity provider.

## Principal Override

If you need backend-enforced per-user visibility without direct SupaVector user login:

- set `ALLOW_PRINCIPAL_OVERRIDE=1`
- use an admin service token
- send `principalId` and optionally `privileges` in the request body

Use this carefully. It shifts trust to your backend, which becomes the caller of record.

## Operational Recommendations

For a serious BYO Postgres deployment:

- use a dedicated database or at least a dedicated SupaVector database user
- enable your normal database backups
- monitor Postgres health and storage growth
- treat service token rotation like any internal API credential rotation
- run a small smoke test after upgrades

Minimum smoke test:

- health check
- bootstrap or login
- index one document
- ask one question

## Common Mistakes

### Assuming `.env` Overrides The Stock Compose Database Wiring

It does not. The stock Compose files set the gateway's `PGHOST`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` for the bundled Postgres path.

Use the official external-Postgres Compose file or your own runtime wiring if you want external Postgres.

### Reusing A Shared App Database Without Isolation

You may get away with it, but it is harder to operate cleanly.

Prefer:

- separate database
- separate DB user
- explicit ownership of SupaVector tables

### Forgetting The Vector Service

Postgres is not the only runtime component. SupaVector still needs the bundled vector service unless you replace that layer yourself.

## Recommended Next Step

After your gateway is pointed at your own Postgres and the service is healthy, continue with:

- [`agents.md`](agents.md) for runtime integration patterns
- [`self-hosting.md`](self-hosting.md) for general operational guidance
