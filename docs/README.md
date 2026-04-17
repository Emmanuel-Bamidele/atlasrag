# SupaVector Guides

This directory is the detailed documentation set for teams using SupaVector in hosted, self-hosted, and enterprise setups.

## Beginner Routes

Use the shortest route that matches what you are actually doing:

- I want the hosted service and a token fast: open [`hosted.md`](hosted.md).
- I want to run SupaVector myself: open [`self-hosting.md`](self-hosting.md).
- I already have a running deployment and just need to call it from code: open [`agents.md`](agents.md).
- I am not sure which mode I am in yet: open [`setup-modes.md`](setup-modes.md).
- I am in Python and only need a client: run `python3 -m pip install supavector`, then read [`agents.md`](agents.md) or [`hosted.md`](hosted.md).

## Decision Matrix

If you are not sure which guide to open first, use this table.

| Usage mode | Best when | Read first |
| --- | --- | --- |
| Not sure which setup path matches your situation | You need to understand what is self-hosted, what is shared, and where the first token comes from before you start | [`setup-modes.md`](setup-modes.md) |
| **Use SupaVector as a hosted service** | **You do not want to run any infrastructure — sign up, get a token, and call the API** | [**`hosted.md`**](hosted.md) |
| Enterprise rollout across hosted or self-hosted SupaVector | You need SSO, tenant admin controls, role mapping, and billing boundaries explained together | [`enterprise.md`](enterprise.md) |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working SupaVector instance | [`self-hosting.md`](self-hosting.md) |
| Fork and self-deploy with your own Postgres and provider keys | You already have database/secrets infrastructure and want SupaVector inside your environment | [`bring-your-own-postgres.md`](bring-your-own-postgres.md) |
| Use a shared SupaVector deployment | SupaVector already has its own Postgres/auth/runtime and your app or agent just needs to call it | [`agents.md`](agents.md) |
| Use a shared SupaVector deployment with your own provider key | SupaVector keeps the shared Postgres/auth/runtime, but each request should use your provider key | [`agents.md#shared-provider-key`](agents.md#shared-provider-key) |
| Keep your own product auth and place SupaVector behind your backend | End users should not log into SupaVector directly | [`agents.md#backend-as-caller`](agents.md#backend-as-caller) |
| Use SupaVector mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [`agents.md#human-jwt`](agents.md#human-jwt) |
| Compare hosted, OSS, and Agent Memory cost patterns | You want to understand where cost comes from and why retrieval-first and memory-backed flows are usually cheaper than traditional prompt stuffing | [`cost.md`](cost.md) |

## Reading Order

1. [`setup-modes.md`](setup-modes.md)
   Use this if you are not sure which setup mode you need yet.
2. [`hosted.md`](hosted.md)
   Use this if you are using the SupaVector hosted service — no Docker or Postgres required.
3. [`enterprise.md`](enterprise.md)
   Use this if you are planning enterprise access, SSO, or hosted-vs-self-hosted enterprise rollout.
4. [`self-hosting.md`](self-hosting.md)
   Use this if you want the fastest path from clone to working local or single-node deployment.
5. [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
   Use this if you already have Postgres, secret management, and your own deployment conventions.
6. [`agents.md`](agents.md)
   Use this if you are integrating SupaVector into an app backend, worker, or AI agent runtime.
7. [`cost.md`](cost.md)
   Use this if you want a cost-oriented comparison of hosted, OSS, Agent Memory, and traditional DIY approaches.

Short version:

- Human admins log in with username/password or SSO.
- Enterprise teams that need tenant-scoped SSO and rollout guidance should read [`enterprise.md`](enterprise.md).
- Cost and affordability analysis lives in [`cost.md`](cost.md).
- Apps, backends, workers, and agents should use a service token.
- Bootstrap once, then store `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY` in your runtime environment.
- `/v1/docs` stays text-first by default. Direct callers can opt into code-aware chunking per document by sending `"sourceType":"code"` with actual source code payloads.
- Optional third mode: keep using the shared SupaVector deployment, but send your own `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` on supported sync requests.
- If you already have your own auth layer, keep it there and let your backend call SupaVector server-to-server.

Related repo docs:

- SupaVector CLI install and onboard flow: [`../README.md`](../README.md)
- Hybrid retrieval design note: [`hybrid-retrieval.md`](hybrid-retrieval.md)
- Retrieval correctness design note: [`retrieval-correctness.md`](retrieval-correctness.md)
- Contributor starter backlog: [`good-first-issues.md`](good-first-issues.md)
- Setup mode guide: [`setup-modes.md`](setup-modes.md)
- Root quickstart: [`../README.md`](../README.md)
- External Postgres Compose file: [`../docker-compose.external-postgres.yml`](../docker-compose.external-postgres.yml)
- External Postgres env template: [`../.env.external-postgres.example`](../.env.external-postgres.example)
- Node SDK: [`../sdk/node/README.md`](../sdk/node/README.md)
- Python SDK: [`../sdk/python/README.md`](../sdk/python/README.md)
- Production cert layout: [`../deploy/stunnel/README.md`](../deploy/stunnel/README.md)
- Security reporting: [`../SECURITY.md`](../SECURITY.md)
