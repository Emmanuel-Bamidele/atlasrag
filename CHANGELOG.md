# Changelog

All notable changes to SupaVector will be documented in this file.

This project follows Keep a Changelog principles and uses semantic versioning for tagged releases.

## [Unreleased]

### Fixed

- Made the CLI admin test harness independent from saved local CLI config so machine-specific `tenantId` values do not leak into test assertions.
- Pinned `@xmldom/xmldom` to a non-vulnerable version through the root override so public installs no longer report the known high-severity XML injection advisory.

### Added

- Public OSS community files for contributor onboarding, issue routing, ownership, and pull request hygiene.
- A root `test:prepush` command and a clearer contributor pre-push matrix so outside contributors know which validation to run before opening a pull request.
- Phase 1 hybrid retrieval: reciprocal-rank-fused vector plus lexical retrieval, fixture-driven quality tests for exact identifiers and mixed queries, and a gateway benchmark script for comparing `rrf` against the legacy weighted fusion mode.
