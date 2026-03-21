# AtlasRAG Node SDK

A small, dependency-free Node.js client for the AtlasRAG API.

## Install (local workspace)

```bash
cd sdk/node
npm install
```

## Bootstrap once (recommended)

Fastest local path:

```bash
atlasrag onboard
```

That creates the local env, starts Docker, bootstraps the first admin, and stores the service token for later CLI usage.

Manual path if you want to bootstrap the running gateway directly:

Create the first admin and a service token from the running AtlasRAG gateway:

```bash
docker compose exec gateway node scripts/bootstrap_instance.js \
  --username admin \
  --password change_me \
  --tenant default \
  --service-token-name node-sdk
```

Store the printed values in your environment:

```bash
export ATLASRAG_BASE_URL="http://localhost:3000"
export ATLASRAG_API_KEY="YOUR_SERVICE_TOKEN"
export OPENAI_API_KEY="YOUR_OPENAI_KEY"
```

## Quick start

```js
const { AtlasRAGClient } = require("@atlasrag/sdk");

const client = new AtlasRAGClient({
  baseUrl: process.env.ATLASRAG_BASE_URL || process.env.ATLASRAG_URL || "http://localhost:3000",
  apiKey: process.env.ATLASRAG_API_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY
});

async function main() {
  await client.indexText("welcome", "AtlasRAG stores memory for agents.", {
    collection: "default"
  });

  const answer = await client.ask("What does AtlasRAG store?", { k: 3 });
  console.log(answer.data.answer);

  const booleanAsk = await client.booleanAsk("Does AtlasRAG store memory for agents?", { k: 3 });
  console.log(booleanAsk.data.answer);
  console.log(booleanAsk.data.supportingChunks);
}

main().catch(console.error);
```

## Authentication

Use a JWT (Bearer) or a service token (API key). For apps, agents, workers, and backends, prefer a service token. If both are set, the SDK prefers the API key.

```js
const client = new AtlasRAGClient({
  baseUrl: process.env.ATLASRAG_BASE_URL || "http://localhost:3000",
  apiKey: process.env.ATLASRAG_API_KEY,
  openAiApiKey: process.env.OPENAI_API_KEY
});
```

If `openAiApiKey` is set, the SDK sends `X-OpenAI-API-Key` so AtlasRAG can use your OpenAI key while still using the shared AtlasRAG deployment and its Postgres/auth state.

Current limitation:

- request-scoped OpenAI key override works on sync requests such as docs, search, ask, boolean_ask, memory write, and memory recall
- `memoryReflect()` and `memoryCompact()` should keep using the server-side OpenAI key today because those flows continue asynchronously after the request ends

Human admin login is still available when you need a JWT for the UI or admin setup:

```js
await client.login(process.env.ATLASRAG_USER, process.env.ATLASRAG_PASS);
```

## Methods

- `health()`
- `login(username, password)`
- `stats()`
- `listDocs(params)`
- `indexText(docId, text, params)`
- `indexUrl(docId, url, params)`
- `deleteDoc(docId, params)`
- `search(query, params)`
- `ask(question, params)`
- `booleanAsk(question, params)`
- `boolean_ask(question, params)`
- `memoryWrite(data)`
- `memoryRecall(data)`
- `memoryReflect(data)`
- `memoryCleanup(data)`
- `memoryCompact(data)`
- `feedback(data)`
- `getTenantSettings()`
- `updateTenantSettings(data)`
- `getJob(id)`

## Tenant settings (admin)

Admins can manage tenant auth settings and tenant-level generation-model defaults via `/v1/admin/tenant`:

```js
// Read current tenant settings
const settings = await client.getTenantSettings();

// Update auth mode and tenant generation defaults
await client.updateTenantSettings({
  authMode: "sso_only",
  ssoProviders: ["google"],
  models: {
    answerModel: "gpt-4.1",
    booleanAskModel: null,
    reflectModel: "gpt-4o-mini",
    compactModel: null
  }
});
```

## Parameters

Most methods accept `collection` and `tenantId` in `params` or `data`.
If you set them on the client via `setCollection()` / `setTenant()`, they are sent automatically.
Write/index/reflect endpoints require `Idempotency-Key`. Pass `idempotencyKey` in params/data to have the SDK send it as a header.
Memory writes and reflect support access control via `visibility` (`tenant`, `private`, `acl`) and `acl` list (array of principal IDs). The principal is derived from the auth token subject; if you pass `principalId` it must match the token.
You can set a default principal on the client with `setPrincipal()`, but the server will validate it against the token.
Reflection jobs accept `docId`, `artifactId`, or `conversationId` as the source.
Memory writes accept `agentId`, `tags` (array of strings), `importanceHint`, `pinned`, and `policy` (`amvl`, `ttl`, or `lru`; defaults to `amvl`).
Ask and boolean_ask requests also accept `model` for a per-request generation override. Memory recall requests accept `policy` to choose retrieval mode per request.
Reflection and compaction requests accept `policy` for the memories they create.
Memory recall filters include `types`, `since`/`until`, `tags`, `agentId`, and `collection`.
Job retries are idempotent: reruns replace derived memories instead of duplicating them.
Supported memory types: `artifact`, `semantic`, `procedural`, `episodic`, `conversation`, `summary`.
Supported memory policies: `amvl`, `ttl`, `lru`.
Feedback accepts `{ memoryId, feedback }` where `feedback` is `positive` or `negative` (optional `eventValue` to weight the signal).
Tenant settings accept `models.answerModel`, `models.booleanAskModel`, `models.reflectModel`, and `models.compactModel`. `embedModel` is instance-wide and should be changed in the self-hosted env or with `atlasrag changemodel`.
The live preset catalog is available from `client.getModels()` / `client.models()`. Current AtlasRAG presets include `gpt-4o`, `gpt-4.1`, `gpt-4o-mini`, `gpt-4.1-mini`, `gpt-4.1-nano`, `gpt-5.2`, `gpt-5-mini`, `gpt-5-nano`, `o1`, `o3`, `o3-mini`, and `o4-mini`, plus custom model ids.

Per-request model override example:

```js
const models = await client.getModels();

const answer = await client.ask("What does AtlasRAG store?", {
  collection: "default",
  model: "gpt-4.1"
});

const check = await client.booleanAsk("Does AtlasRAG store memory for agents?", {
  collection: "default",
  model: "o1"
});
```

## Examples

Run the samples in `examples/`:

```bash
node examples/basic.js
node examples/memory.js
```
