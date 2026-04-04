# Good First Issues

Use this page when you want a small, clearly bounded way to help with SupaVector.

The goal is not to turn every contribution into a beginner-only task. The goal is to make it easy for contributors at different levels to find one small thing, understand where to start, and ship a reviewable pull request.

## Labels We Use

- `good first issue`: first-time-friendly work with a narrow scope, clear starting files, and an obvious verify path
- `help wanted`: still scoped, but usually needs a bit more context or touches more than one area
- `advanced-small-scope`: not a required GitHub label, but a useful bucket for short issues that still need deeper repo familiarity

For maintainers:

- Use `good first issue` only when the work can stay within one subsystem or one small docs/test slice.
- Include a `Start here` section with real file paths.
- Include a `Verify` section with a command, test file, or manual path.
- If the issue grows beyond its original scope, remove the `good first issue` label and keep `help wanted`.

## Starter Backlog

### Beginner

#### 1. Add Node SDK request-shaping tests

Why this is a good first issue:

- the work is isolated to the Node SDK
- the logic is mostly pure request assembly and header behavior
- there is currently no dedicated SDK test file, so the contribution adds immediate value

Start here:

- [`sdk/node/src/client.js`](../sdk/node/src/client.js)
- [`sdk/node/package.json`](../sdk/node/package.json)

Done when:

- query and body defaults are covered
- API key vs Bearer token precedence is covered
- request-scoped provider headers and `Idempotency-Key` behavior are covered
- the SDK has a simple test command contributors can run locally

Verify:

- `cd sdk/node && npm test`

#### 2. Expand CLI ingest edge-case coverage

Why this is a good first issue:

- the CLI already has a focused test file
- the work is test-first and does not need Docker or model keys
- it improves confidence around folder ingest without changing API behavior

Start here:

- [`cli/lib.js`](../cli/lib.js)
- [`cli/tests/cli_helpers.test.js`](../cli/tests/cli_helpers.test.js)

Done when:

- skipped directories like `node_modules`, `.venv`, `dist`, and `coverage` are covered by tests
- codebase detection stays stable for common repo roots
- any bug fix stays narrowly scoped to ingest helpers

Verify:

- `node cli/tests/cli_helpers.test.js`

### Intermediate

#### 3. Add a shared-deployment Node SDK example

Why this is a good next step:

- the repo already documents shared-deployment flows, but the SDK examples are still local-first
- the work is mostly examples and docs, not deep gateway changes
- it helps app developers who already have `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`

Start here:

- [`sdk/node/examples/basic.js`](../sdk/node/examples/basic.js)
- [`sdk/node/examples/memory.js`](../sdk/node/examples/memory.js)
- [`sdk/node/README.md`](../sdk/node/README.md)
- [`docs/agents.md`](agents.md)

Done when:

- there is an example that uses a service token against an existing deployment
- the example shows optional request-scoped provider-key override usage
- collection usage is explicit so reads and writes stay in the same scope

Verify:

- the example runs with `node sdk/node/examples/<example-name>.js` when `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY` are set

#### 4. Tighten `/v1/models` docs and coverage

Why this is a good next step:

- the model catalog is a real integration surface for the CLI, SDK, and UI
- tests already exist, so contributors can extend the current pattern
- the scope is still small enough to review without a broader refactor

Start here:

- [`gateway/model_config.js`](../gateway/model_config.js)
- [`gateway/tests/model_config.test.js`](../gateway/tests/model_config.test.js)
- [`docs/agents.md`](agents.md)

Done when:

- docs explain how callers should use `/v1/models` to discover the live preset catalog and current defaults
- tests cover the new or clarified behavior
- changes do not widen the provider/model contract casually

Verify:

- `node gateway/tests/model_config.test.js`

### Advanced Small Scope

#### 5. Improve provider-override guidance in the public docs UI

Why this is a good advanced-small-scope issue:

- it touches real user-facing behavior
- the code is front-end heavy, but still local to the public docs surface
- it can improve operator experience without changing storage or auth architecture

Start here:

- [`gateway/public/app.js`](../gateway/public/app.js)
- [`gateway/public/index.html`](../gateway/public/index.html)
- [`gateway/public/partials/page-playground.html`](../gateway/public/partials/page-playground.html)
- [`gateway/public/styles/`](../gateway/public/styles)

Done when:

- the UI makes it clearer when a user is relying on saved provider overrides vs runtime request values
- error or status messaging is easier to understand without reading the source
- keyboard and focus behavior remain intact

Verify:

- manual check in the local docs UI plus any targeted browser-safe regression tests you add

#### 6. Keep SDK examples from drifting out of date

Why this is a good advanced-small-scope issue:

- examples often break quietly even when core tests pass
- the work stays bounded to examples, docs, and smoke coverage
- it helps beginners later because the starter examples remain trustworthy

Start here:

- [`sdk/node/examples/`](../sdk/node/examples)
- [`scripts/test_oss_ci_local.sh`](../scripts/test_oss_ci_local.sh)
- [`package.json`](../package.json)

Done when:

- the OSS smoke path exercises at least one SDK example or validates example assumptions explicitly
- docs and example env variable names stay aligned
- the check is cheap enough to keep in normal contributor workflows

Verify:

- `npm run test:oss-smoke`

## How To Turn One Of These Into A Real Issue

1. Open a new issue from the repository's `Good First Issue` template.
2. Copy one starter item from this page into the issue summary.
3. Fill in the exact files, definition of done, and verify command.
4. Add `good first issue` for beginner-friendly tickets or `help wanted` for deeper but still bounded work.
5. Link the issue back to the pull request so the next contributor can see what changed and what is still open.
