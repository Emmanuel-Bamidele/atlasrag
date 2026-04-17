# Hybrid Retrieval Design Note

This note describes the Phase 1 retrieval change shipped in SupaVector.

Phase 2 retrieval correctness work builds on this baseline with first-class filters, freshness-aware time windows, and a fixture-driven evaluation harness. See [`retrieval-correctness.md`](retrieval-correctness.md) for those additions.

## Flow

1. `searchChunks(...)` embeds the query and builds the tenant-scoped candidate set from memory policy gating.
2. The C++ vector store returns dense candidates for semantic recall.
3. Postgres full-text search returns lexical candidates from `chunks.text` using `to_tsvector('simple', text)` and `websearch_to_tsquery`.
4. SupaVector unions those candidates by chunk id, keeps both dense and lexical rank positions, then fuses them into one ranked list.
5. Recency bias is applied after fusion when `favorRecency` is on or auto-enabled for recency-sensitive memory types.

## Fusion Strategy

- Default mode: `HYBRID_FUSION_MODE=rrf`
- Fallback mode: `HYBRID_FUSION_MODE=weighted`

`rrf` uses reciprocal rank fusion across the dense and lexical result lists:

- dense contribution: `HYBRID_VECTOR_WEIGHT / (HYBRID_RRF_K + dense_rank)`
- lexical contribution: `HYBRID_LEXICAL_WEIGHT / (HYBRID_RRF_K + lexical_rank)`

After the base fused score is computed, SupaVector still applies the existing lightweight rerank signals:

- token overlap boost via `HYBRID_RERANK_OVERLAP_BOOST`
- exact substring boost via `HYBRID_RERANK_EXACT_BOOST`
- optional recency blending via `favorRecency`

The `weighted` fallback keeps the previous normalized score blend so operators can roll back the fusion behavior without disabling hybrid retrieval entirely.

## Config Flags

Main retrieval flags:

```env
HYBRID_RETRIEVAL_ENABLED=1
HYBRID_FUSION_MODE=rrf
HYBRID_RRF_K=60
HYBRID_VECTOR_WEIGHT=0.72
HYBRID_LEXICAL_WEIGHT=0.28
HYBRID_LEXICAL_MULTIPLIER=2
HYBRID_LEXICAL_CAP=120
HYBRID_RERANK_OVERLAP_BOOST=0.12
HYBRID_RERANK_EXACT_BOOST=0.08
```

Operational meaning:

- `HYBRID_RETRIEVAL_ENABLED=0` disables lexical retrieval and keeps vector-only ranking behavior.
- `HYBRID_FUSION_MODE=rrf` is the default and is recommended for exact identifiers and mixed queries.
- `HYBRID_FUSION_MODE=weighted` preserves the prior score-normalized hybrid fusion.
- `HYBRID_RRF_K` controls how steeply reciprocal rank contributions decay.

## Backward Compatibility

- When hybrid retrieval is disabled, the ranking path stays vector-only.
- Existing API shapes do not change.
- Existing env weights still apply; `rrf` reuses the same vector and lexical weights instead of introducing a new weighting surface.
- The `weighted` fallback is kept specifically for safe rollback and evaluation.

## Quality Fixture

Curated fixture cases live in:

- `experiments/fixtures/hybrid_retrieval_cases.json`

They cover:

- exact-match identifiers
- semantic-only queries
- mixed semantic plus exact-match queries

Run the benchmark with:

```bash
cd gateway
npm run benchmark:hybrid
```
