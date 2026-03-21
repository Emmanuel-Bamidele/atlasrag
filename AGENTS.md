# AtlasRAG Agent Instructions

These instructions are for coding assistants or local AI agents working inside this repository on a developer machine.

## Setup Mode Rule

When a user asks setup questions, first classify which mode they actually mean before giving commands:

- self-hosted bundled stack
- self-hosted with external Postgres
- existing shared AtlasRAG deployment
- existing shared deployment plus their own provider key
- backend-as-caller
- human admin

Use [`docs/setup-modes.md`](docs/setup-modes.md) as the primary repository reference when the user is unsure which path they are setting up.

High-signal boundary rules:

- if they are cloning the repo and running Docker themselves, they are in a self-hosted mode
- if they already have `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`, they are in a shared-deployment mode
- `--external-postgres` is still self-hosted AtlasRAG
- do not tell shared-deployment users to run local bootstrap or onboard commands on a client machine unless that machine is also the AtlasRAG server

## Local CLI First

If this repository is available locally and the goal is to run or test AtlasRAG on the same computer:

1. Prefer the `atlasrag` CLI over raw bootstrap commands.
2. Run `atlasrag doctor` first to see whether local prerequisites and saved config already exist.
3. If AtlasRAG has not been configured yet, run `atlasrag onboard`.
4. Use raw `docker compose ... scripts/bootstrap_instance.js` commands only if:
   - the CLI is unavailable
   - the user explicitly asks for the manual path
   - or you are debugging the bootstrap process itself

## Service Token Rules

- On the normal local self-hosted path, `atlasrag onboard` creates the first admin and the first service token automatically.
- The CLI saves the base URL and service token in `~/.atlasrag/config.json`.
- If you are using the CLI on the same machine, do not ask the user to paste the token back into the CLI; the saved config is the normal path.
- Only surface the token with `atlasrag config show --show-secrets` when the user needs to wire another local app, backend, worker, or agent runtime.
- Never commit service tokens, JWTs, or provider keys to the repository.

## Collection Rules

- Use `--collection` explicitly on `atlasrag write`, `atlasrag search`, `atlasrag ask`, and `atlasrag boolean_ask` whenever collection scope matters.
- Keep write and read operations on the same collection unless the user explicitly wants a wider or different scope.
- For folder ingest, `atlasrag write --folder ./some-folder` uses the folder name as the collection if `--collection` is omitted.
- When a caller needs a grounded binary decision instead of a freeform answer, use `atlasrag boolean_ask`. The API, SDK, and UI responses include `supportingChunks` when the caller needs the exact evidence text.

## Model Rules

- For local self-hosted defaults, use `atlasrag changemodel` instead of telling the user to edit the env file by hand.
- `atlasrag onboard` and `atlasrag changemodel` support numbered provider choices first, then numbered model choices for the selected provider. Generation providers are currently OpenAI, Gemini, and Anthropic. Embedding providers are currently OpenAI and Gemini.
- `ask` and `boolean_ask` also accept per-request `provider` and `model` overrides through the API and CLI when the caller wants a different generation provider/model for one request. On the CLI, `--provider` and `--model` accept the same common numbered shortcuts too.
- Use `GET /v1/models` when you need the live preset catalog and current instance defaults.
- Tenant-level admin settings can override `answerProvider`, `answerModel`, `booleanAskProvider`, `booleanAskModel`, `reflectProvider`, `reflectModel`, `compactProvider`, and `compactModel` via `/v1/admin/tenant`.
- `embedProvider` and `embedModel` are instance-wide, not tenant-specific. Changing either requires a reindex because AtlasRAG stores all vectors in one embedding space.

## Local CLI Examples

```bash
atlasrag doctor
atlasrag onboard
atlasrag write --doc-id welcome --collection local-demo --text "AtlasRAG stores memory for agents."
atlasrag search --q "memory for agents" --collection local-demo --k 5
atlasrag ask --question "What does AtlasRAG store?" --collection local-demo
atlasrag boolean_ask --question "Does AtlasRAG store memory for agents?" --collection local-demo
```

Folder ingest:

```bash
atlasrag write --folder ./customer-support
atlasrag search --q "refund policy" --collection customer-support --k 5
```

## Shared Deployment Rule

If the user is not self-hosting locally and is targeting an existing AtlasRAG deployment instead:

- use `ATLASRAG_BASE_URL` and `ATLASRAG_API_KEY`
- do not run local bootstrap commands
- do not assume access to a local Docker stack
