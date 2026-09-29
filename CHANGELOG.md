# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Cross-OS offline coverage (Issue #176).** The same offline suites now run on Ubuntu and Windows
  in a dedicated `Offline suites (<os>)` matrix job, and two new suites exercise the places where
  the platforms actually differ: `tests/storage-reload.test.js` writes runs, events, receipts and
  idempotency records to a temporary file and reloads them in a second store (including a corrupted
  file, a `maxRuns` trim and concurrent writes), and `tests/startup-shutdown.test.js` boots the real
  server on an ephemeral port, waits for `/healthz`, shuts it down and proves the port is released,
  escalating to `SIGKILL` in `finally` so a failed job cannot leak a listening process.
  `tests/support/space-path-suite.mjs` (`npm run test:spaces`) copies the repository into a
  temporary path containing spaces and runs the suites from there. All of it uses
  `os.tmpdir()`/`path.join`/`process.execPath`, so no shell-specific syntax is involved, and the job
  prints the tails of the collected logs when it fails.

### Fixed

- **A failed start no longer looks like a successful one.** `npm start` printed its startup banner
  even when the port was already taken (the `listen` callback fires even for a failed bind), and
  then exited `0` without a diagnostic. The banner is now printed only for a server that is really
  listening, and a bind failure logs `server_listen_failed` with a one-line explanation and exits
  non-zero, so CI and deployments can see it.

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
