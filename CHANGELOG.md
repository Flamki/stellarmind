# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `GET /api/wallet/readiness` (`?refresh=true` to re-check): whether the orchestrator wallet can
  settle in the configured asset, with `ready` (`true`/`false`/`null`), `state`, an actionable
  `reason`, `checkedAt`, `expiresAt`, `fresh` and `ageMs`. Run and plan responses carry the same
  data as `x402WalletReadiness`. Configure with `WALLET_READINESS_TTL_MS` and
  `WALLET_READINESS_TIMEOUT_MS`.
- Cursor pagination for `GET /api/runs` (`cursor` query parameter, `nextCursor` / `hasMore` in the
  response). Cursors are position-based, so runs created between page requests never produce
  duplicates, and they stay valid across restarts.
- `status`, `createdFrom` and `createdTo` filters for `GET /api/runs`, which compose with
  pagination. Cursors are bound to the filters they were issued for.
- Structured validation errors (`details[].code`) for invalid cursors, filters and dates.
- `interrupted` added to the documented `status` values in the OpenAPI spec.

### Changed

- Idempotency keys now have a defined retention window. A key stays bound to its run for
  `IDEMPOTENCY_TTL_MS` (default 24 hours) or until the run leaves the bounded run history; after
  that it can be reused. Expired mappings are dropped on lookup, load and save, and the saved
  mapping list no longer keeps the oldest entries and drops the newest. Behavior is documented in
  `docs/architecture.md` and `docs/openapi.yaml`.

- Wallet readiness is no longer a one-time check at startup. It is cached for a bounded time and
  refreshed on demand, so funding or a new trustline is picked up without a restart.
- Readiness matches the network profile's asset by code **and** issuer. A `USDC` balance from any
  other issuer no longer counts.
- A failed balance lookup now reports `x402WalletReady: null` (unknown) with a retry hint instead of
  being treated as an empty wallet. Concurrent checks share one lookup.
- `GET /api/runs` now returns lightweight run summaries instead of full run records, in a
  deterministic newest-first order (`createdAt` descending, `id` descending as tie-breaker). Events,
  output, plans and payment proofs are available from `GET /api/runs/:id`, which each summary links
  to via `runUrl`.
- `GET /api/runs` rejects invalid `limit` values (non-integers and values below 1) with a structured
  `400` instead of silently falling back to the default. Values above 100 are clamped.

### Fixed

- The startup readiness check treated `getBalance()`'s `{ success, balances }` result as an array,
  so it always failed with "Unable to verify x402 wallet readiness".

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