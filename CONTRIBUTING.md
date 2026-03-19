# Contributing

Thanks for contributing to AtlasRAG.

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

## Support Model

This repository does not currently promise hosted service support or SLA-backed response times. Contributions should assume self-hosted users operating the software in their own environments.
