# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- `GET /api/runs` now returns lightweight run summaries instead of full run records, in a
  deterministic newest-first order (`createdAt` descending, `id` descending as tie-breaker). Events,
  output, plans and payment proofs are available from `GET /api/runs/:id`, which each summary links
  to via `runUrl`.
- `GET /api/runs` rejects invalid `limit` values (non-integers and values below 1) with a structured
  `400` instead of silently falling back to the default. Values above 100 are clamped.

### Added

- Cursor pagination for `GET /api/runs` (`cursor` query parameter, `nextCursor` / `hasMore` in the
  response). Cursors are position-based, so runs created between page requests never produce
  duplicates, and they stay valid across restarts.
- `status`, `createdFrom` and `createdTo` filters for `GET /api/runs`, which compose with
  pagination. Cursors are bound to the filters they were issued for.
- Structured validation errors (`details[].code`) for invalid cursors, filters and dates.
- `interrupted` added to the documented `status` values in the OpenAPI spec.

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
