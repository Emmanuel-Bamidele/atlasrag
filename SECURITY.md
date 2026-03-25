# Security Policy

## Supported Scope

SupaVector is currently documented as self-hosted software. Security work should prioritize:

- tenant isolation
- authentication and authorization
- service token handling
- secret management
- unsafe URL ingestion or SSRF paths
- data deletion and memory visibility controls

## Reporting A Vulnerability

Do not open a public issue for a suspected security vulnerability.

Preferred path:

- use the repository host's private vulnerability reporting feature if available
- otherwise contact the maintainers privately before any public disclosure

Include:

- a clear description of the issue
- affected component or endpoint
- reproduction steps or proof of concept
- impact assessment
- any suggested mitigation

## Disclosure Expectations

- Please give maintainers reasonable time to investigate and fix the issue before public disclosure.
- Avoid publishing exploit details while a fix is pending.
- If credentials, keys, or cert material may be exposed, say so explicitly in the report.

## Repository Hygiene

Security-sensitive material should not be committed to the repository, including:

- environment files with live secrets
- production credentials
- private keys
- generated certificate bundles intended for real deployments

## Operational Notes

Operators deploying SupaVector should:

- use strong secrets for JWT and cookie signing
- store secrets outside version control
- rotate credentials if exposure is suspected
- review proxy, TLS, and public ingress configuration before internet exposure
- keep Postgres backups and restore procedures tested

## Current Policy Limits

This file describes reporting expectations only. It does not yet define formal support windows, CVE issuance policy, or SLA-backed response times.
