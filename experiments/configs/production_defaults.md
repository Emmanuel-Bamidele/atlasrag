# Production Default Configuration Inventory

This file records the default policy-relevant settings used by experiments. Source of truth for AMV-L runtime defaults is `gateway/index.js` env fallbacks; TTL/LRU experiment baselines are explicit override configs and are not applied to production defaults.

## AMV-L defaults (from code fallbacks)

- `TTL_SWEEP_INTERVAL_MS=300000`
- `MEMORY_VALUE_DECAY_INTERVAL_MS=3600000`
- `MEMORY_REDUNDANCY_INTERVAL_MS=86400000`
- `MEMORY_LIFECYCLE_INTERVAL_MS=86400000`
- `MEMORY_LIFECYCLE_MIN_AGE_HOURS=24`
- `MEMORY_LIFECYCLE_MAX_DELETES=0`
- `MEMORY_LIFECYCLE_DRY_RUN=0`
- `MEMORY_LIFECYCLE_DELETE_THRESHOLD=0.25`
- `MEMORY_LIFECYCLE_SUMMARY_THRESHOLD=0.45`
- `MEMORY_LIFECYCLE_PROMOTE_THRESHOLD=0.70`
- `MEMORY_LIFECYCLE_COMPACT_GROUP_SIZE=5`
- `MEMORY_TIER_HOT_UP=0.70` (or `MEMORY_LIFECYCLE_PROMOTE_THRESHOLD` when set)
- `MEMORY_TIER_HOT_DOWN=0.62`
- `MEMORY_TIER_WARM_UP=0.45`
- `MEMORY_TIER_WARM_DOWN=0.25` (or delete threshold)
- `MEMORY_TIER_EVICT=0.25` (or delete threshold)
- `MEMORY_INIT_VALUE=0.50`
- `MEMORY_RETRIEVAL_WARM_SAMPLE_K=8`
- `MEMORY_RETRIEVAL_WARM_SAMPLE_POOL_MULTIPLIER=4`
- `MEMORY_RETRIEVAL_WARM_SELECTION=random`
- `MEMORY_ACCESS_ALPHA=0.08`
- `MEMORY_CONTRIBUTION_BETA=0.20`
- `MEMORY_NEGATIVE_STEP=0.08`
- `MEMORY_RECENCY_HALFLIFE_DAYS=30`
- `MEMORY_VALUE_DECAY_LAMBDA=ln(2)/halflife_days` (default `~0.0231`)
- `HYBRID_RETRIEVAL_ENABLED=1`
- `HYBRID_FUSION_MODE=rrf`
- `HYBRID_RRF_K=60`
- `HYBRID_VECTOR_WEIGHT=0.72`
- `HYBRID_LEXICAL_WEIGHT=0.28`
- `HYBRID_LEXICAL_MULTIPLIER=2`
- `HYBRID_LEXICAL_CAP=120`
- `HYBRID_RERANK_OVERLAP_BOOST=0.12`
- `HYBRID_RERANK_EXACT_BOOST=0.08`

## TTL baseline override (experiment only)

Config file: `experiments/configs/policies/ttl_baseline.json`

- Disables value/redundancy/lifecycle intervals.
- Keeps TTL sweeps active.
- Expands retrieval sample limits to emulate broad TTL retrieval behavior.

## LRU baseline override (experiment only)

Config file: `experiments/configs/policies/lru_baseline.json`

- Disables value/redundancy/lifecycle intervals.
- Uses `MEMORY_RETRIEVAL_WARM_SELECTION=lru`.
- Sets value dynamics (`alpha`, `beta`, decay) to zero.

## Notes

- No production default files are modified by this experiment harness.
- All experiment behavior changes are applied only via per-run env override files generated under `experiments/runs/<suite_id>/<run>/compose.env`.
- Hybrid retrieval benchmark fixtures live in `experiments/fixtures/hybrid_retrieval_cases.json` and can be exercised with `cd gateway && npm run benchmark:hybrid`.
