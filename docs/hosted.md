# AtlasRAG Hosted

This guide is for developers using AtlasRAG as a hosted service — where AtlasRAG runs the infrastructure and you call the API with a token issued from the Dashboard.

Choose this path when:

- you do not want to run Docker, Postgres, or any AtlasRAG server yourself
- you want a working API token in under five minutes
- you are building an app, backend, agent, or prototype that calls AtlasRAG

What you are not setting up:

- any server, Docker container, or Compose file
- `.env` files or bootstrap scripts
- your own Postgres database for AtlasRAG

## Step 1 — Sign Up

Go to the AtlasRAG hosted instance and sign up with Google, GitHub, or email.

If you use email, a one-time code is sent to your inbox. Enter it to complete sign-in. No password is stored.

## Step 2 — Create A Project

After signing in, the **Dashboard** tab appears in the navigation.

1. Click **Dashboard**
2. Click **New Project**
3. Enter a project name (max 80 characters)
4. Click **Create**

A project represents one isolated AtlasRAG tenant. All documents, memories, and usage are scoped to that project.

## Step 3 — Copy Your Service Token

When a project is created, a service token is displayed **once**. Copy it immediately.

```
atrg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token is not stored in plain text on the server. If you close the dialog without copying it, create a new token from the project's token list. The old one remains active until you revoke it.

Store the token the same way you store any API secret:

- a secret manager (AWS Secrets Manager, Doppler, 1Password Secrets Automation)
- an environment variable in your deployment pipeline
- never in source control or browser-accessible code

## Step 4 — Add Credits

AI generation (`/ask`, `/v1/ask`, `/boolean_ask`, `/v1/boolean_ask`) requires credit.

1. In the Dashboard, click **Add Credit** in the credit balance card
2. Choose a preset amount ($5, $10, $25, $50) or enter a custom amount
3. Click the amount to proceed to Stripe Checkout
4. Complete payment with a card
5. You are redirected back to the Dashboard with your balance updated

Credits are per-account. All projects under your account share the same credit balance.

### Credit Pricing

Two things consume billing meters:

| Meter | What triggers it | How it's billed |
|---|---|---|
| **AI generation** | `/ask`, `/boolean_ask` | Per 1,000 tokens (input + output) |
| **Storage** | `/v1/docs`, `/v1/docs/url`, `/v1/memory/write` | Per GB of data stored in the hosted Postgres |

Storage is measured as actual bytes (document metadata + chunk text) and updated automatically after each write. It is shown in the Dashboard but is **not** deducted from your prepaid credit balance — storage cost is tracked separately in the billing meter and appears in your monthly billing history.

Check the Dashboard for current rates.

### Test Mode Payments

If the hosted instance is in test mode, use Stripe's test card details:

```
Card number:  4242 4242 4242 4242
Expiry:       Any future date (e.g. 12/29)
CVC:          Any 3 digits
ZIP:          Any 5 digits
```

No real charge is made.

## Step 5 — Wire Up Your Runtime

Set two environment variables in your app, agent, or script:

```bash
ATLASRAG_BASE_URL=https://YOUR_HOSTED_DOMAIN
ATLASRAG_API_KEY=atrg_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then call the API the same way as any AtlasRAG deployment:

```bash
# Health check (no token needed)
curl -sS "${ATLASRAG_BASE_URL}/health"

# Index a document
curl -sS "${ATLASRAG_BASE_URL}/v1/docs" \
  -H "Authorization: Bearer ${ATLASRAG_API_KEY}" \
  -H "Idempotency-Key: doc-001" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "welcome",
    "collection": "default",
    "text": "AtlasRAG stores memory for agents."
  }'

# Ask a question
curl -sS "${ATLASRAG_BASE_URL}/v1/ask" \
  -H "Authorization: Bearer ${ATLASRAG_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What does AtlasRAG store?",
    "k": 5,
    "policy": "amvl"
  }'
```

The hosted instance supplies the AI provider (no `X-OpenAI-API-Key` required unless you want to override it).

## Managing Tokens

From the Dashboard, on each project's detail view, you can:

- **Create additional tokens** — useful for separating production, staging, and CI
- **Revoke a token** — immediately invalidates it; no grace period
- **See last used time** — per-token, so you know which are active

Token names are for your own reference. The actual secret value is only shown at creation time.

## Checking Usage

The Dashboard shows per-account and per-project usage:

- Credit balance remaining
- AI generation tokens used this billing period
- Estimated AI cost in USD
- Storage bytes used across all projects
- Storage cost this billing period

You can also call the API directly:

```bash
# Credit balance (requires portal JWT, not service token)
curl -sS "${ATLASRAG_BASE_URL}/portal/billing/balance" \
  -H "Authorization: Bearer YOUR_PORTAL_JWT"

# Transaction history
curl -sS "${ATLASRAG_BASE_URL}/portal/billing/transactions" \
  -H "Authorization: Bearer YOUR_PORTAL_JWT"
```

Portal JWTs are obtained at sign-in and refreshed automatically by the dashboard. For programmatic access to billing data, use the session token from your browser or implement the sign-in flow in your tooling.

## Error Reference

### 402 — Insufficient Credits

```json
{
  "error": "Insufficient credits. Add credit from the Dashboard to continue generating.",
  "code": "CREDIT_REQUIRED"
}
```

**Cause:** Your account balance has reached zero.

**Fix:** Add credit from the Dashboard and retry the request. Write endpoints (`/v1/docs`, `/v1/docs/url`, `/v1/memory/write`) and read endpoints (`/v1/search`, `/v1/memory/recall`) are not credit-gated and will continue to work. Note that writes still update the storage meter even when your credit balance is zero.

**In your code** — check for this specific code before surfacing the error to end users:

```js
const res = await fetch(`${BASE}/v1/ask`, { method: "POST", headers, body });
const data = await res.json();

if (res.status === 402 && data.code === "CREDIT_REQUIRED") {
  // Surface a "top up credit" prompt to the user
  // or queue the request for retry after top-up
}
```

### 503 — Credit Check Temporarily Unavailable

```json
{
  "error": "Service temporarily unavailable. Please try again.",
  "code": "CREDIT_CHECK_FAILED"
}
```

**Cause:** The server could not verify your credit balance due to a transient error (database connectivity, deployment issue).

**Fix:** Retry with exponential backoff. This does not mean your balance is zero — it means the check itself failed. The server blocks generation rather than allowing an unverified request through.

### 401 — Invalid or Revoked Token

```json
{
  "error": "Unauthorized"
}
```

**Cause:** The token is missing, malformed, revoked, or belongs to a different deployment.

**Fix:** Verify the token starts with `atrg_`, was copied from the Dashboard of this deployment, and has not been revoked.

### 410 — Token Revoked

Returned by the token reveal endpoint when a token has been explicitly revoked. If a generation request returns 401, check the Dashboard to confirm the token is still active.

## Hosted Versus Self-Hosted

| | AtlasRAG Hosted | Self-Hosted |
|---|---|---|
| You run Docker | No | Yes |
| You manage Postgres | No | Yes |
| Where your token comes from | Dashboard sign-up | `bootstrap_instance.js` script |
| Token prefix | `atrg_` | Any (usually no prefix) |
| AI generation billing | Credit balance in Dashboard | Your own provider key billed directly |
| Storage billing | Measured per write, shown in Dashboard | Not tracked |
| Data residency | AtlasRAG-managed | Your own infrastructure |

Self-hosted tokens do not go through the credit system. If you see `atrg_` in your token and you are not using the hosted service, that token was minted by a portal-enabled deployment and does carry the credit requirement.

## Multiple Projects

Each project is a separate AtlasRAG tenant with its own:

- document and memory store
- token list
- usage meter

Use separate projects to isolate different apps, environments (production vs staging), or customers. Credits are shared across all projects under your account.

## Read Next

- [`setup-modes.md`](setup-modes.md) — understand how hosted fits into the broader AtlasRAG setup modes
- [`agents.md`](agents.md) — wiring your service token into an agent or backend runtime
