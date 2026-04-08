# SupaVector Hosted

This guide is for developers using SupaVector as a hosted service — where SupaVector runs the infrastructure and you call the API with a token issued from the Dashboard.

Choose this path when:

- you do not want to run Docker, Postgres, or any SupaVector server yourself
- you want a working API token in under five minutes
- you are building an app, backend, agent, or prototype that calls SupaVector

What you are not setting up:

- any server, Docker container, or Compose file
- `.env` files or bootstrap scripts
- your own Postgres database for SupaVector

## 5-Minute Path

If you want the shortest path:

1. Sign in
2. Create a project
3. Copy the `supav_...` service token
4. Run `python3 -m pip install supavector`
5. Set `SUPAVECTOR_BASE_URL` and `SUPAVECTOR_API_KEY`
6. Start calling the API from your backend, worker, notebook, or agent runtime

## Step 1 — Sign Up

Go to the SupaVector hosted instance and sign up with Google, GitHub, or email.

If you use email, a one-time code is sent to your inbox. Enter it to complete sign-in. No password is stored.

## Step 2 — Create A Project

After signing in, the **Dashboard** tab appears in the navigation.

1. Click **Dashboard**
2. Click **New Project**
3. Enter a project name (max 80 characters)
4. Click **Create**

A project represents one isolated SupaVector tenant. All documents, memories, and usage are scoped to that project.

On hosted deployments, treat the **Dashboard** as the control plane. The gateway **Settings** page is intentionally reduced to browser-local developer controls such as the saved token for that browser session and optional provider override keys. Manage project tokens, SSO, users, billing, and enterprise controls in the Dashboard instead of the gateway Settings page.

## Step 3 — Copy Your Service Token

When a project is created, a service token is displayed **once**. Copy it immediately.

```
supav_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

The token is not stored in plain text on the server. If you close the dialog without copying it, create a new token from the project's token list. The old one remains active until you revoke it.

Store the token the same way you store any API secret:

- a secret manager (AWS Secrets Manager, Doppler, 1Password Secrets Automation)
- an environment variable in your deployment pipeline
- never in source control or browser-accessible code

## Step 4 — Set Up Billing

AI generation (`/ask`, `/v1/ask`, `/boolean_ask`, `/v1/boolean_ask`) uses prepaid credit unless the request supplies the matching request-scoped provider key for the effective generation provider.

1. In the Dashboard, click **Add Credit** in the credit balance card
2. Choose a preset amount ($5, $10, $25, $50) or enter a custom amount
3. Click the amount to proceed to Stripe Checkout
4. Complete payment with a card
5. You are redirected back to the Dashboard with your balance updated

Credits are per-account. All projects under your account share the same credit balance.
Hosted storage is billed separately from that credit balance through the Billing Portal. Keep a saved payment method on file if you want hosted writes to continue without storage-billing grace windows.

### Credit Pricing

Two things consume billing meters:

| Meter | What triggers it | How it's billed |
|---|---|---|
| **AI generation** | `/ask`, `/boolean_ask` | Per 1,000 billable generation tokens. If the request uses the matching request-scoped provider key, that generation is billed by your provider instead of hosted credit. |
| **Storage** | `/v1/docs`, `/v1/docs/url`, `/v1/memory/write`, collection deletes, and other retained hosted data changes | Monthly `GB-month` based on average retained hosted storage during the billing period |

Storage billing is computed from retained hosted bytes over time, not a one-time charge per write. Writes and deletes update the storage meter, but monthly invoices are based on average retained usage across the billing period. Storage is shown in the Dashboard and billed separately from prepaid AI credit.

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
python3 -m pip install supavector

SUPAVECTOR_BASE_URL=https://YOUR_HOSTED_DOMAIN
SUPAVECTOR_API_KEY=supav_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Then call the API the same way as any SupaVector deployment. Python example:

```python
from supavector import Client

client = Client.from_env(collection="default")

client.index_text(
    "welcome",
    "SupaVector stores memory for agents.",
    params={"idempotencyKey": "doc-001"},
)

answer = client.ask("What does SupaVector store?", {"k": 7})
print(answer["data"]["answer"])
```

Raw HTTP example:

```bash
# Health check (no token needed)
curl -sS "${SUPAVECTOR_BASE_URL}/health"

# Index a document
curl -sS "${SUPAVECTOR_BASE_URL}/v1/docs" \
  -H "Authorization: Bearer ${SUPAVECTOR_API_KEY}" \
  -H "Idempotency-Key: doc-001" \
  -H "Content-Type: application/json" \
  -d '{
    "docId": "welcome",
    "collection": "default",
    "text": "SupaVector stores memory for agents."
  }'

# Ask a question
curl -sS "${SUPAVECTOR_BASE_URL}/v1/ask" \
  -H "Authorization: Bearer ${SUPAVECTOR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "question": "What does SupaVector store?",
    "k": 7,
    "policy": "amvl",
    "favorRecency": true
  }'
```

To create a hosted Memory with explicit conversation-memory mode, set `sourceConfig.conversationMemory.strategy` to either `turn_log` or `hybrid_wiki`:

```bash
curl -sS "${SUPAVECTOR_BASE_URL}/v1/memories" \
  -H "X-API-Key: ${SUPAVECTOR_API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Support Memory",
    "provider": "openai",
    "model": "gpt-5.2",
    "sourceConfig": {
      "conversationMemory": {
        "enabled": true,
        "autoWriteDefault": true,
        "includeInAskDefault": true,
        "strategy": "turn_log"
      }
    }
  }'
```

If you want long-term conversation state that compounds over time into a readable article, switch that `strategy` value to `hybrid_wiki` and optionally add wiki fields such as `wikiEnabled`, `wikiPages`, `wikiUpdateEveryTurns`, `wikiKeepRecentTurns`, `wikiRawRetentionDays`, or `wikiPageMaxChars`. If you do not want conversation wiki, leave the strategy at `turn_log` or omit it.

### How Structured Memory Works

- Each chat still writes raw conversation turns to the Memory-owned conversation collection.
- Recent turns stay available as short-term context for follow-up replies.
- A background updater rewrites one living wiki article from the previous wiki version plus the latest question and response turns.
- The article is rewritten in place instead of appending forever, which keeps long-term conversation state bounded without discarding durable context.
- If you do not want that behavior, use `turn_log` and the Memory will keep relying on the longer raw turn history instead.

When a hosted Memory uses `hybrid_wiki`, the Memory detail view in Studio exposes a **Conversation wiki** inspector where you can load a specific conversation id, read the current article, queue a rebuild, delete stored wiki state, or manually overwrite the article. Those actions use the current Studio session token rather than the project service token.

Studio-authenticated conversation wiki routes:

```text
GET    /portal/projects/:projectId/brains/:memoryId/conversations/:conversationId/wiki
POST   /portal/projects/:projectId/brains/:memoryId/conversations/:conversationId/wiki/rebuild
PUT    /portal/projects/:projectId/brains/:memoryId/conversations/:conversationId/wiki/:page
DELETE /portal/projects/:projectId/brains/:memoryId/conversations/:conversationId/wiki
```

If you are self-hosting or automating outside the browser session, use the underlying gateway conversation wiki endpoints or the CLI memory commands instead of the Studio routes above.
`/v1/docs` remains text-first on hosted deployments too. If you send source code directly, you can include optional `sourceType`, `title`, `sourceUrl`, and `metadata` fields. Set `"sourceType":"code"` only for actual code payloads; hosted Memory GitHub repo sync applies that automatically for matched repo files.

Set `"favorRecency": true` when newer matching evidence should outrank older matches. This is especially useful for continuously updated facts such as company product data, release notes, incident timelines, and conversation-like state. Hosted synced sources attach `syncedAt` automatically, and direct writes can also include timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt` in `metadata`.

The hosted instance supplies the AI provider by default. If you send a matching request-scoped provider key such as `X-OpenAI-API-Key`, `X-Gemini-API-Key`, or `X-Anthropic-API-Key` on supported sync routes, the request can use your provider key instead of the hosted default. On hosted deployments, that changes AI generation billing for that request, but it does not move storage out of SupaVector-hosted infrastructure.

## Using Your Own Provider Key On Hosted

You can keep using your hosted `supav_` token while sending your own provider key on supported sync requests.

- `POST /v1/ask`, `POST /v1/code`, and `POST /v1/boolean_ask` accept request-scoped provider-key headers plus optional `provider` and `model` overrides in the JSON body.
- When the matching generation-key header is present for the effective provider, hosted AI credit is not deducted for that request.
- Hosted storage billing still applies because the data remains on SupaVector-hosted infrastructure.

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
- Projected storage charge this billing period
- Storage billing status and Billing Portal access

You can also call the API directly:

```bash
# Credit balance (requires portal JWT, not service token)
curl -sS "${SUPAVECTOR_BASE_URL}/portal/billing/balance" \
  -H "Authorization: Bearer YOUR_PORTAL_JWT"

# Transaction history
curl -sS "${SUPAVECTOR_BASE_URL}/portal/billing/transactions" \
  -H "Authorization: Bearer YOUR_PORTAL_JWT"

# Billing overview, payment-method status, and portal session link
curl -sS "${SUPAVECTOR_BASE_URL}/portal/billing" \
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

### 402 — Storage Payment Method Required

```json
{
  "error": "Storage billing requires a saved payment method. Add one in the Billing Portal to continue writes.",
  "code": "STORAGE_PAYMENT_METHOD_REQUIRED"
}
```

**Cause:** The hosted account is writing data to SupaVector-hosted storage but does not have a saved payment method after the grace window.

**Fix:** Open the Billing Portal from the Dashboard, save a payment method, and retry the write. Reads and search may continue during grace, but hosted writes can block once the grace window ends.

### 402 — Storage Billing Past Due

```json
{
  "error": "Storage billing is past due. Update your payment method in the Billing Portal to continue writes.",
  "code": "STORAGE_BILLING_PAST_DUE"
}
```

**Cause:** A hosted storage invoice failed and the past-due grace window expired.

**Fix:** Update the payment method in the Billing Portal and pay the outstanding invoice. After the account returns to good standing, hosted writes resume.

### 401 — Invalid or Revoked Token

```json
{
  "error": "Unauthorized"
}
```

**Cause:** The token is missing, malformed, revoked, or belongs to a different deployment.

**Fix:** Verify the token starts with `supav_`, was copied from the Dashboard of this deployment, and has not been revoked.

### 410 — Token Revoked

Returned by the token reveal endpoint when a token has been explicitly revoked. If a generation request returns 401, check the Dashboard to confirm the token is still active.

## Hosted Versus Self-Hosted

| | SupaVector Hosted | Self-Hosted |
|---|---|---|
| You run Docker | No | Yes |
| You manage Postgres | No | Yes |
| Where your token comes from | Dashboard sign-up | `bootstrap_instance.js` script |
| Token prefix | `supav_` | Any (usually no prefix) |
| AI generation billing | Prepaid credit by default, or your provider billed directly when the request uses the matching provider-key header | Your own provider or infrastructure |
| Storage billing | Monthly hosted `GB-month` based on retained storage, billed separately from credit | Your own infrastructure costs |
| Data residency | SupaVector-managed | Your own infrastructure |

Self-hosted tokens do not go through the credit system. If you see `supav_` in your token and you are not using the hosted service, that token was minted by a portal-enabled deployment and does carry the credit requirement.

## Multiple Projects

Each project is a separate SupaVector tenant with its own:

- document and memory store
- token list
- usage meter

Use separate projects to isolate different apps, environments (production vs staging), or customers. Credits are shared across all projects under your account.

## Read Next

- [`setup-modes.md`](setup-modes.md) — understand how hosted fits into the broader SupaVector setup modes
- [`enterprise.md`](enterprise.md) — enterprise SSO, hosted-vs-BYO billing boundaries, and rollout guidance
- [`agents.md`](agents.md) — wiring your service token into an agent or backend runtime
