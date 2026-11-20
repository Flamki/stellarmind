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

### Changed

- Agent results record the model that actually responded (`provenance.model`), the provider, and a
  prompt revision/digest (`promptRevision`, `promptDigest`). After a model fallback `model` is the
  fallback model. Demo and remote x402 results no longer claim a live model: `model` is `null`
  (`intendedModel` / `declaredModel` keep the label). No credentials or prompt text are stored.
- Wallet readiness is no longer a one-time check at startup. It is cached for a bounded time and
  refreshed on demand, so funding or a new trustline is picked up without a restart.
- Readiness matches the network profile's asset by code **and** issuer. A `USDC` balance from any
  other issuer no longer counts.
- A failed balance lookup now reports `x402WalletReady: null` (unknown) with a retry hint instead of
  being treated as an empty wallet. Concurrent checks share one lookup.

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
