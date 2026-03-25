# Contributing

Thanks for contributing to SupaVector.

This repository is currently optimized for self-hosted deployment and active iteration. Contributions should improve correctness, operator experience, documentation quality, or self-hosting readiness without widening scope casually.

## Before You Start

- Read the root `README.md` first.
- Keep changes focused. Small, reviewable pull requests are preferred over large mixed refactors.
- If you are changing behavior, update docs and tests in the same change.

## Development Setup

The default local workflow is Docker-based:

```bash
cp .env.example .env
docker compose up -d --build
```

Gateway-only work can be done from `gateway/`:

```bash
cd gateway
npm ci
npm run test:unit
```

If the full stack is running, also run:

```bash
npm run test:integration
npm run test:e2e
```

## Pull Request Guidelines

- Explain the problem being solved, not just the code change.
- Keep pull requests scoped to one concern.
- Add or update tests when behavior changes.
- Update `README.md`, API docs, or examples when the user-facing workflow changes.
- Do not include unrelated cleanup.

## Code Expectations

- Prefer straightforward, supportable solutions over clever ones.
- Preserve the current deployment model unless the change explicitly targets deployment work.
- Maintain tenant isolation, auth checks, and idempotency guarantees.
- Keep public/self-hosted setup simple.

## Security And Secrets

- Never commit `.env`, credentials, tokens, or private certificates.
- Do not commit generated telemetry, local database dumps, or other machine-specific artifacts.
- If you find a security issue, do not open a public bug report first. Follow `SECURITY.md`.

## What To Include In A Good Change

- tests for new or changed behavior
- documentation updates if setup or usage changed
- migration notes if deployment operators need to do anything differently

## Scope Notes

Good contribution areas:

- self-hosting and deployment usability
- docs quality and quickstart clarity
- test coverage and CI hardening
- auth, tenancy, and operational safety
- API correctness and SDK improvements

Changes that need extra discussion first:

- storage engine replacements
- major auth model changes
- multi-node/distributed architecture shifts
- breaking API changes

## Product Direction And Contribution Lanes

SupaVector is moving toward a clear role: the memory layer for AI agents.

That means a product that can sit inside a single local loop, a multi-agent system, a backend worker graph, or a deployed runtime and provide durable memory, retrieval, memory policies, and auditability across those environments.

Contributors do not need to solve that in one large change. The preferred approach is incremental work in small lanes that build toward that direction.

Good roadmap-aligned contribution lanes:

- agent loop primitives
- multi-agent memory controls
- provider and model portability
- SDK and runtime integrations
- memory observability and debugging
- local-first and remote deployment parity
- multimodal memory: images, video, and large files

### 1. Agent Loop Primitives

SupaVector already supports document and memory APIs. A strong next step is making it easier for agent runtimes to call SupaVector inside a loop.

Good contributions here:

- session, turn, task, or checkpoint metadata improvements
- better agent-oriented request examples
- loop-safe idempotency and retry behavior
- APIs or SDK helpers for pre-step recall and post-step write flows

Keep changes small. A focused helper, endpoint improvement, or SDK example is better than a large orchestration rewrite.

### 2. Multi-Agent Memory Controls

SupaVector should work for one agent, many agents, and handoffs between agents.

Good contributions here:

- clearer `agentId` usage across APIs and SDKs
- shared vs private vs ACL-scoped memory behavior
- provenance fields for who wrote or updated memory
- handoff-oriented examples and tests

Contributions in this area must preserve tenant isolation and access-control guarantees.

### 3. Provider And Model Portability

SupaVector should remain usable with different base models and deployment styles.

Good contributions here:

- cleaner provider abstraction around embeddings and answer generation
- request-scoped provider configuration improvements
- compatibility fixes for local or self-hosted model backends
- docs that make model/runtime boundaries clearer

Avoid hard-coding SupaVector into one model vendor unless the change is explicitly vendor-specific and isolated.

### 4. SDK And Runtime Integrations

If SupaVector is the memory layer, it needs to be easy to plug into real agent runtimes.

Good contributions here:

- SDK improvements in `sdk/node/`
- new small SDKs or examples for other runtimes
- MCP server work or related interoperability work
- examples for backend workers, coding agents, or multi-agent coordinators

Integrations should stay minimal, composable, and easy to review.

### 5. Memory Observability And Debugging

Memory systems are only trusted when operators can inspect what was written, what was recalled, and why.

Good contributions here:

- better debug output for recall and answer flows
- more transparent memory job status and job result details
- admin or CLI surfaces for inspecting memory behavior
- tests and tooling around recall quality, compaction, and cleanup behavior

This is a high-value area for contributors who want to improve production readiness without changing the core architecture.

### 7. Multimodal Memory: Images, Video, And Large Files

Supavector currently stores and retrieves text. The next frontier is multimodal memory — letting agents store, index, search, and embed non-text content the same way they handle documents today.

Good contributions here:

- image ingestion and embedding pipelines (CLIP, vision model adapters)
- video frame extraction and scene-level indexing
- large file chunking strategies (PDFs with images, slide decks, audio transcripts)
- storage-efficient representation of binary assets alongside their embeddings
- retrieval APIs that return multimodal results alongside text context
- provider abstractions for multimodal embedding models

Contributions in this lane should keep the existing text memory APIs intact and treat multimodal as additive. Start small — a single file type, a single provider adapter, or a retrieval example is a good first step.

### 6. Local-First And Remote Deployment Parity

SupaVector should feel consistent whether it runs on a laptop, a private server, or a shared deployment.

Good contributions here:

- CLI and docs improvements that keep local and remote paths aligned
- deployment examples for reverse proxies and shared environments
- operator ergonomics for config, bootstrap, and service token workflows
- safer update, sync, and maintenance flows

Prefer improvements that keep the same API and mental model across environments.

## How To Help Incrementally

If you want to contribute toward the broader product direction, prefer changes that fit one of these shapes:

- one missing CLI or SDK command
- one endpoint improvement with tests
- one docs section that closes a real usage gap
- one integration example for a real agent/runtime pattern
- one safety or observability improvement for memory operations

Avoid bundling several roadmap lanes into one pull request. A series of small, composable changes is easier to review and more likely to land.

## Support Model

This repository does not currently promise hosted service support or SLA-backed response times. Contributions should assume self-hosted users operating the software in their own environments.
