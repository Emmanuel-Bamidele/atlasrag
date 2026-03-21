# AtlasRAG Guides

This directory is the detailed documentation set for teams that fork or self-host AtlasRAG.

## Decision Matrix

If you are not sure which guide to open first, use this table.

| Usage mode | Best when | Read first |
| --- | --- | --- |
| Not sure which setup path matches your situation | You need to understand what is self-hosted, what is shared, and where the first token comes from before you start | [`setup-modes.md`](setup-modes.md) |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working AtlasRAG instance | [`self-hosting.md`](self-hosting.md) |
| Fork and self-deploy with your own Postgres and provider keys | You already have database/secrets infrastructure and want AtlasRAG inside your environment | [`bring-your-own-postgres.md`](bring-your-own-postgres.md) |
| Use a shared AtlasRAG deployment | AtlasRAG already has its own Postgres/auth/runtime and your app or agent just needs to call it | [`agents.md`](agents.md) |
| Use a shared AtlasRAG deployment with your own provider key | AtlasRAG keeps the shared Postgres/auth/runtime, but each request should use your provider key | [`agents.md#shared-provider-key`](agents.md#shared-provider-key) |
| Keep your own product auth and place AtlasRAG behind your backend | End users should not log into AtlasRAG directly | [`agents.md#backend-as-caller`](agents.md#backend-as-caller) |
| Use AtlasRAG mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [`agents.md#human-jwt`](agents.md#human-jwt) |

## Reading Order

1. [`setup-modes.md`](setup-modes.md)
   Use this if you are not sure which setup mode you need yet.
2. [`self-hosting.md`](self-hosting.md)
   Use this if you want the fastest path from clone to working local or single-node deployment.
3. [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
   Use this if you already have Postgres, secret management, and your own deployment conventions.
4. [`agents.md`](agents.md)
   Use this if you are integrating AtlasRAG into an app backend, worker, or AI agent runtime.

Short version:

- Human admins log in with username/password or SSO.
- Apps, backends, workers, and agents should use a service token.
- Bootstrap once, then store `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY` in your runtime environment.
- Optional third mode: keep using the shared AtlasRAG deployment, but send your own `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` on supported sync requests.
- If you already have your own auth layer, keep it there and let your backend call AtlasRAG server-to-server.

Related repo docs:

- AtlasRAG CLI install and onboard flow: [`../README.md`](../README.md)
- Setup mode guide: [`setup-modes.md`](setup-modes.md)
- Root quickstart: [`../README.md`](../README.md)
- External Postgres Compose file: [`../docker-compose.external-postgres.yml`](../docker-compose.external-postgres.yml)
- External Postgres env template: [`../.env.external-postgres.example`](../.env.external-postgres.example)
- Node SDK: [`../sdk/node/README.md`](../sdk/node/README.md)
- Production cert layout: [`../deploy/stunnel/README.md`](../deploy/stunnel/README.md)
- Security reporting: [`../SECURITY.md`](../SECURITY.md)
