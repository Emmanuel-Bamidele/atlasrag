# Retrieval Correctness Design Note

This note describes the Phase 2 retrieval correctness work in SupaVector.

## Filtering Behavior

Search-backed endpoints now share one retrieval filter surface:

- `tenantId`
- `collection`
- `docIds`
- `namespaceIds`
- `tags`
- `agentId`
- `sourceTypes`
- `documentTypes`
- `since`
- `until`
- `timeField`

Where filters apply:

1. Pre-retrieval candidate selection:
   tenant, collection, namespace/doc targeting, source type, document type, tags, and time windows are pushed into the Postgres-backed memory item selectors before vector and lexical retrieval run.
2. Ranking-time safety filter:
   SupaVector rechecks the normalized filter set on merged candidates before final ranking so dense and lexical results cannot leak a wrong tenant, namespace, source type, or stale document into the final ranked set.
3. Endpoint parity:
   `search`, `ask`, `code`, `boolean_ask`, and `memory/recall` all accept the same filter concepts, and the CLI mirrors them with `--doc-ids`, `--namespace-ids`, `--tags`, `--agent-id`, `--source-type`, `--document-type`, `--since`, `--until`, and `--time-field`.

Time-window semantics:

- Default: `timeField=createdAt`
- Freshness-aware: `timeField=freshness`

`createdAt` uses the original ingest time. `freshness` uses metadata timestamps such as `updatedAt`, `publishedAt`, `effectiveAt`, or `syncedAt`, falling back to `created_at` when no freshness metadata exists.

## Recency Scoring

SupaVector still ranks hybrid retrieval first, then applies optional freshness bias:

1. Fuse dense vector and lexical ranks.
2. Apply overlap and exact-match boosts.
3. Blend the fused score with freshness decay when recency is enabled.

Recency inputs:

- explicit request flag: `favorRecency=true|false`
- query-sensitive auto mode when `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1`
- metadata freshness timestamps from `updatedAt`, `publishedAt`, `effectiveAt`, `syncedAt`, and related aliases

Main config flags:

```env
RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1
MEMORY_RETRIEVAL_RECENCY_WEIGHT=0.3
MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS=14
```

Operational meaning:

- `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED=1` turns on auto-recency for clearly freshness-sensitive queries such as "latest incident status" or "current pricing".
- `MEMORY_RETRIEVAL_RECENCY_WEIGHT` controls how much the recency score can influence the final ranking.
- `MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS` controls how quickly freshness decays.

Backward compatibility:

- If callers do nothing, retrieval still works with the prior defaults.
- `favorRecency=false` disables the freshness bias even when the query text looks freshness-sensitive.
- `timeField` defaults to `createdAt`, so old `since` / `until` behavior remains stable unless the caller explicitly opts into freshness-based time filtering.

## Evaluation Workflow

Fixture-driven retrieval evaluation lives in:

- `experiments/fixtures/retrieval_correctness_cases.json`
- `gateway/retrieval_eval.js`
- `gateway/scripts/evaluate_retrieval.js`

Run it with:

```bash
cd gateway
npm run eval:retrieval
```

JSON output:

```bash
cd gateway
node scripts/evaluate_retrieval.js --json
```

The harness reports:

- recall@k
- MRR
- nDCG@k
- average / p50 / p95 latency
- evidence-hit rate

The current curated fixtures cover:

- tenant isolation
- metadata filter correctness
- recent-vs-stale ranking behavior

## How To Interpret Metrics

- recall@k:
  higher is better; it measures how often the relevant evidence appears in the returned top-k set.
- MRR:
  higher is better; it rewards putting the first relevant hit near the top.
- nDCG@k:
  higher is better; it measures ranking quality across the full top-k list, not just the first relevant hit.
- latency:
  use avg, p50, and p95 together; correctness wins that blow up p95 are not production-safe.
- evidence-hit rate:
  a practical groundedness check; it measures whether the top-k includes the expected supporting evidence chunk for the case.
