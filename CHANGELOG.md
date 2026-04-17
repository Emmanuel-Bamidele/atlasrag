# Changelog

All notable changes to SupaVector will be documented in this file.

This project follows Keep a Changelog principles and uses semantic versioning for tagged releases.

## [Unreleased]

## [0.3.0] - 2026-04-17

### Added

- Phase 2 retrieval correctness improvements: first-class retrieval filters for namespace, source type, document type, tags, agent-scoped sources, and configurable time windows across search-backed endpoints.
- A fixture-driven retrieval evaluation harness with recall@k, MRR, nDCG, latency, and evidence-hit reporting via `cd gateway && npm run eval:retrieval`.

### Changed

- Search, ask, code, boolean_ask, and memory recall now apply the same retrieval filter surface and can use metadata freshness timestamps for time-range filtering.
- Query-driven recency preference is now configurable with `RETRIEVAL_QUERY_RECENCY_AUTO_ENABLED`, `MEMORY_RETRIEVAL_RECENCY_WEIGHT`, and `MEMORY_RETRIEVAL_RECENCY_HALFLIFE_DAYS`.

## [0.2.0] - 2026-04-17

### Fixed

- Made the CLI admin test harness independent from saved local CLI config so machine-specific `tenantId` values do not leak into test assertions.
- Pinned `@xmldom/xmldom` to a non-vulnerable version through the root override so public installs no longer report the known high-severity XML injection advisory.

### Added

- Public OSS community files for contributor onboarding, issue routing, ownership, and pull request hygiene.
- A root `test:prepush` command and a clearer contributor pre-push matrix so outside contributors know which validation to run before opening a pull request.
- Phase 1 hybrid retrieval: reciprocal-rank-fused vector plus lexical retrieval, fixture-driven quality tests for exact identifiers and mixed queries, and a gateway benchmark script for comparing `rrf` against the legacy weighted fusion mode.
