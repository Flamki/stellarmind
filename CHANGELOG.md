# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Run report export (Issue #167).** A stored run can be exported as a versioned JSON document
  (`schemaVersion`) or as readable Markdown, both generated from persisted detail only:
  `GET /api/runs/:id/export?format=json|md` (downloads with a `Content-Disposition` filename, `404`
  for an unknown run, `400` for an unsupported format) and
  `npm run export:run -- <runId> [--format json|md] [--out <path>|-]` for the CLI. The export
  carries run id, timestamps, task/status/source, the executed plan (provenance), every recorded
  step outcome, the settled asset amounts, and the payment receipts.
- Run receipts now record the **network** they were settled on (`txProofs[].network` plus a
  `confirmed` flag), so an exported report says where a transaction hash can be verified.

## [1.0.0] — 2026-08-09

### Added

- Initial release
- Agent orchestration platform
- Multi-provider LLM support
- REST API with OpenAPI specification
- Web dashboard with real-time SSE updates
- Docker support for reproducible deployment
- Circuit breaker for upstream provider stability
- Audit history persistence for orchestration events
- Comprehensive documentation and contributor guides

Generated for Stellar Wave bounty #33
