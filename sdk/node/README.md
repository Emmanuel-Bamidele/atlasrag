# AtlasRAG Node SDK

A small, dependency-free Node.js client for the AtlasRAG API.

## Install (local workspace)

```bash
cd sdk/node
npm install
```

## Quick start

```js
const { AtlasRAGClient } = require("@atlasrag/sdk");

const client = new AtlasRAGClient({
  baseUrl: process.env.ATLASRAG_URL || "http://localhost:3000"
});

async function main() {
  await client.login(process.env.ATLASRAG_USER, process.env.ATLASRAG_PASS);

  await client.indexText("welcome", "AtlasRAG stores memory for agents.", {
    collection: "default"
  });

  const answer = await client.ask("What does AtlasRAG store?", { k: 3 });
  console.log(answer.data.answer);
}

main().catch(console.error);
```

## Authentication

Use a JWT (Bearer) or a service token (API key). If both are set, the SDK prefers the API key.

```js
const client = new AtlasRAGClient({
  baseUrl: "http://localhost:3000",
  apiKey: process.env.ATLASRAG_API_KEY
});
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
- `memoryWrite(data)`
- `memoryRecall(data)`
- `memoryReflect(data)`
- `memoryCleanup(data)`
- `memoryCompact(data)`
- `getJob(id)`

## Parameters

Most methods accept `collection` and `tenantId` in `params` or `data`.
If you set them on the client via `setCollection()` / `setTenant()`, they are sent automatically.
Write/index/reflect endpoints require `Idempotency-Key`. Pass `idempotencyKey` in params/data to have the SDK send it as a header.
Memory writes and reflect support access control via `visibility` (`tenant`, `private`, `acl`) and `acl` list (array of principal IDs). The principal is derived from the auth token subject; if you pass `principalId` it must match the token.
You can set a default principal on the client with `setPrincipal()`, but the server will validate it against the token.

## Examples

Run the samples in `examples/`:

```bash
node examples/basic.js
node examples/memory.js
```
