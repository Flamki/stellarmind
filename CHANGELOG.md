# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Run and step identity on orchestration events (Issue #163).** Every event broadcast or persisted
  for a run now carries the `runId` it belongs to plus a monotonic `stepIndex` and a `stepId`; an
  `agent_response` pairs with the `agent_call` it answers, so a call and its response share one
  step. The dashboard counts steps by that identity instead of by agent name (two steps that reuse
  an agent are two steps) and ignores events belonging to another run. Reducer unit tests live in
  `tests/run-progress.test.js` and event identity tests in `tests/run-event-identity.test.js`.

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
