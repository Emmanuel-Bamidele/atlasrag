# AtlasRAG Agent Instructions

These instructions are for coding assistants or local AI agents working inside this repository on a developer machine.

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
- Never commit service tokens, JWTs, or OpenAI keys to the repository.

## Collection Rules

- Use `--collection` explicitly on `atlasrag write`, `atlasrag search`, `atlasrag ask`, and `atlasrag boolean_ask` whenever collection scope matters.
- Keep write and read operations on the same collection unless the user explicitly wants a wider or different scope.
- For folder ingest, `atlasrag write --folder ./some-folder` uses the folder name as the collection if `--collection` is omitted.
- When a caller needs a grounded binary decision instead of a freeform answer, use `atlasrag boolean_ask`. The API, SDK, and UI responses include `supportingChunks` when the caller needs the exact evidence text.

## Model Rules

- For local self-hosted defaults, use `atlasrag changemodel` instead of telling the user to edit the env file by hand.
- `atlasrag onboard` and `atlasrag changemodel` support numbered generation-model choices for the current preset list, including GPT-4.1 / GPT-4o, GPT-5 presets, and o-series reasoning models.
- `ask` and `boolean_ask` also accept a per-request `model` override through the API and CLI when the caller wants a different generation model for one request. On the CLI, `--model` accepts the same common numbered shortcuts too.
- Use `GET /v1/models` when you need the live preset catalog and current instance defaults.
- Tenant-level admin settings can override `answerModel`, `booleanAskModel`, `reflectModel`, and `compactModel` via `/v1/admin/tenant`.
- `embedModel` is instance-wide, not tenant-specific. Changing it requires a reindex because AtlasRAG stores all vectors in one embedding space.

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
