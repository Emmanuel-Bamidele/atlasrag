# AtlasRAG For Apps, Backends, And Agents

This guide is for developers building:

- AI agents
- app backends
- worker processes
- internal tools
- CI or automation that talks to AtlasRAG

The goal is simple: make AtlasRAG feel like a service your runtime can depend on, not a manual UI-only tool.

## Decision Matrix

Use this if you need to choose the right usage mode quickly.

| Usage mode | Best when | Read next |
| --- | --- | --- |
| Fork and self-deploy with the bundled stack | You want the fastest path from clone to a working AtlasRAG instance | [`self-hosting.md`](self-hosting.md) |
| Fork and self-deploy with your own Postgres and OpenAI key | You already have database/secrets infrastructure and want AtlasRAG inside your environment | [`bring-your-own-postgres.md`](bring-your-own-postgres.md) |
| Use a shared AtlasRAG deployment | AtlasRAG already has its own Postgres/auth/runtime and your app or agent just needs to call it | [Direct service token](#direct-service-token) |
| Use a shared AtlasRAG deployment with your own OpenAI key | AtlasRAG keeps the shared Postgres/auth/runtime, but each request should use your provider key | [Shared AtlasRAG, your OpenAI key](#shared-openai-key) |
| Keep your own product auth and place AtlasRAG behind your backend | End users should not log into AtlasRAG directly | [Backend-as-caller](#backend-as-caller) |
| Use AtlasRAG mainly as a human admin or browser UI | You are managing tenant settings, keys, or interactive sessions | [Human JWT](#human-jwt) |

## Recommended Runtime Model

Use AtlasRAG like this:

1. a human admin bootstraps the instance once
2. AtlasRAG issues a service token
3. your app, backend, worker, or agent stores that token
4. runtime code calls AtlasRAG with `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`

Optional variant:

5. if the runtime wants AtlasRAG to use its own OpenAI key, it also sends `X-OpenAI-API-Key` on supported sync requests

Human login is still useful for:

- browser sessions
- admin setup
- tenant settings
- minting additional service tokens

It is not the preferred runtime path for autonomous agents.

## Minimum Runtime Env

For most runtimes, this is enough:

```bash
ATLASRAG_BASE_URL=http://localhost:3000
ATLASRAG_API_KEY=YOUR_SERVICE_TOKEN
```

Optional app-level defaults you may also keep:

```bash
ATLASRAG_COLLECTION=default
ATLASRAG_AGENT_ID=agent:planner
```

## CLI Against A Live Deployment

If AtlasRAG is already online and you want to test it from your own machine with the CLI:

```bash
export ATLASRAG_BASE_URL="https://YOUR_DOMAIN"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
atlasrag write --doc-id cli-test --collection cli-smoke --text "AtlasRAG CLI remote test."
atlasrag search --q "remote test" --collection cli-smoke --k 3
atlasrag ask --question "What does the CLI test document say?" --collection cli-smoke
```

Important distinction:

- `atlasrag onboard` is for local self-hosted setup
- `atlasrag write`, `atlasrag search`, and `atlasrag ask` are the normal commands for testing or using an already deployed AtlasRAG service
- Docker is not required on the client machine for this remote path

## Bootstrap Once

If the instance has not been bootstrapped yet:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name agent-runtime
```

Store the printed service token in your runtime secret store.

## What An Agent Can Do Today

With a valid service token, an agent can:

- index documents
- search retrieved chunks
- ask grounded questions
- write memories
- recall memories
- trigger reflection jobs
- poll job status
- send feedback and task outcome signals

What an agent cannot do from nothing:

- self-bootstrap from only an OpenAI key
- create the first AtlasRAG credential anonymously
- create the first service token without an existing admin path

That is by design. AtlasRAG still needs one operator-controlled bootstrap step.

## Auth Choices

<a id="direct-service-token"></a>
### 1. Direct Service Token

Best when:

- one internal agent or backend talks directly to AtlasRAG
- you control the runtime environment

Send:

```http
X-API-Key: YOUR_SERVICE_TOKEN
```

This is the default recommendation.

<a id="human-jwt"></a>
### 2. Human JWT

Best when:

- a human is using the UI
- an admin is configuring the tenant
- you need a temporary interactive session

Send:

```http
Authorization: Bearer YOUR_JWT
```

<a id="backend-as-caller"></a>
### 3. Backend-As-Caller

Best when:

- your product already has its own end-user auth
- you do not want every user or agent to log into AtlasRAG separately

Pattern:

1. end user authenticates to your app
2. your backend calls AtlasRAG with a service token
3. your backend decides which user or privileges should be represented

This is usually the cleanest product architecture.

<a id="shared-openai-key"></a>
### 4. Shared AtlasRAG, Your OpenAI Key

Best when:

- AtlasRAG is already deployed and keeps its own Postgres/auth state
- you want a request to use your OpenAI key instead of the server default
- you do not need AtlasRAG to persist your provider key server-side

Pattern:

1. authenticate with a service token or JWT as usual
2. also send `X-OpenAI-API-Key: YOUR_OPENAI_KEY`
3. AtlasRAG uses that key for supported sync embedding/answer requests

Supported today:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `GET /v1/search`
- `POST /v1/ask`
- `POST /v1/memory/write`
- `POST /v1/memory/recall`

Current limitation:

- `POST /v1/memory/reflect`
- `POST /v1/memory/compact`

Those two endpoints reject `X-OpenAI-API-Key` because the work continues asynchronously after the original request ends.

## Service Token Lifecycle

Treat the AtlasRAG service token like any internal API credential.

Recommended practices:

- store it in a secret manager
- keep it out of browser code
- rotate it on your own schedule
- mint separate tokens for separate runtimes when useful
- revoke tokens you no longer need

A common split is:

- one token for production app traffic
- one token for CI
- one token for internal admin tooling

## Core Runtime Calls

### Health

```bash
curl -sS "${ATLASRAG_BASE_URL}/health"
```

### Index A Document

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Idempotency-Key: idx-001" \
  -H "Content-Type: application/json" \
  -d '{
    "docId":"welcome",
    "collection":"default",
    "text":"AtlasRAG stores memory for agents."
  }'
```

### Search

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/search?q=memory&k=5&collection=default&policy=amvl" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}"
```

### Ask

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question":"What does AtlasRAG store?",
    "k":5,
    "policy":"amvl",
    "answerLength":"medium"
  }'
```

### Memory Write

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/memory/write" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Idempotency-Key: mem-001" \
  -H "Content-Type: application/json" \
  -d '{
    "text":"Customer prefers email updates on Fridays.",
    "type":"semantic",
    "collection":"default",
    "policy":"amvl",
    "agentId":"agent:support",
    "tags":["customer","preference"],
    "importanceHint":0.7,
    "pinned":false
  }'
```

### Memory Recall

```bash
curl -sS "${ATLASRAG_BASE_URL}/v1/memory/recall" \
  -H "X-API-Key: ${ATLASRAG_API_KEY}" \
  -H "X-OpenAI-API-Key: ${OPENAI_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "query":"email preference",
    "collection":"default",
    "policy":"amvl",
    "agentId":"agent:support",
    "types":["semantic"],
    "k":5
  }'
```

## Idempotency Rules

These write endpoints require an `Idempotency-Key`:

- `POST /v1/docs`
- `POST /v1/docs/url`
- `POST /v1/memory/write`
- `POST /v1/memory/reflect`

Do not reuse the same idempotency key for different payloads.

Good practice:

- generate one unique key per logical write
- keep retries on the same key if the payload is identical

## Choosing A Retrieval Or Memory Policy

AtlasRAG supports three policies:

- `amvl`
- `ttl`
- `lru`

### `amvl`

Use when:

- you want the platform's main value-based memory behavior
- you want retrieval and lifecycle decisions tuned for longer-term usefulness
- you are using AtlasRAG as intended

This is the default and the recommended starting point.

### `ttl`

Use when:

- you want time-based expiration behavior
- your data has a known freshness window
- simple age-based lifecycle is enough

### `lru`

Use when:

- you want recency-of-use behavior
- you are comparing against a more traditional cache-like memory policy

## Direct Agent Versus Backend Proxy

### Let The Agent Call AtlasRAG Directly

Good when:

- the runtime is fully internal
- the environment is trusted
- the token can be stored securely

### Let Your Backend Call AtlasRAG

Good when:

- your application already has end-user auth
- you need more control over visibility
- you want one place to enforce policy and rate limits

This is the better default for most customer-facing products.

## Visibility Without AtlasRAG End-User Login

If your app has its own user auth and you still want per-user visibility:

- enable `ALLOW_PRINCIPAL_OVERRIDE=1`
- use an admin service token from your backend
- send `principalId` and optionally `privileges`

This lets your backend remain the caller of record while AtlasRAG enforces tenant, ACL, and visibility rules.

Do not expose an admin service token to the browser.

## Example Runtime Pattern In Node

```js
const BASE = process.env.ATLASRAG_BASE_URL;
const API_KEY = process.env.ATLASRAG_API_KEY;

async function atlasrag(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": API_KEY,
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const data = await res.json();
  if (!res.ok) throw new Error(JSON.stringify(data));
  return data;
}

await atlasrag("/v1/docs", {
  method: "POST",
  headers: { "Idempotency-Key": "idx-001" },
  body: {
    docId: "welcome",
    collection: "default",
    text: "AtlasRAG stores memory for agents."
  }
});

const answer = await atlasrag("/v1/ask", {
  method: "POST",
  body: {
    question: "What does AtlasRAG store?",
    k: 5,
    policy: "amvl"
  }
});

console.log(answer.data.answer);
```

## When To Use The Node SDK

If you do not want to hand-roll fetch calls, use:

- [`../sdk/node/README.md`](../sdk/node/README.md)

The SDK already understands:

- JWT or API key auth
- idempotency headers
- search, ask, docs, memory, and jobs endpoints

## Security Notes For Agent Teams

- prefer service tokens over stored human passwords
- keep tokens in server-side secrets, not client-side bundles
- mint different tokens for different runtimes if blast radius matters
- revoke tokens when an environment is retired
- audit any use of `ALLOW_PRINCIPAL_OVERRIDE`

## What To Build Around AtlasRAG

AtlasRAG is a good fit when your agent stack needs:

- document ingestion
- grounded retrieval
- reusable memory writes
- explicit memory policies
- tenant-aware visibility rules

It should usually sit behind or beside your orchestrator, not replace your orchestrator.

## Recommended Next Step

After you have a working service token:

1. wire `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY` into your runtime
2. add one ingest smoke test
3. add one ask smoke test
4. decide whether your app will call AtlasRAG directly or through your backend

For infrastructure setup details, go back to:

- [`self-hosting.md`](self-hosting.md)
- [`bring-your-own-postgres.md`](bring-your-own-postgres.md)
