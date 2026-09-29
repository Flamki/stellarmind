# Changelog

All notable changes to StellarMind will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Versioned offline quality set for agent output (Issue #154).** `eval/quality-set.json` pairs
  non-sensitive tasks with structural success properties (sections, vocabulary, length, list
  constraints, JSON shape, code-block size), and `npm run eval:quality` scores captured outputs
  against them with no keys, wallets or network access. Reports carry the set/prompt revisions and
  the bound model revision, keep the human-judgement questions unscored, and are deterministic — two
  runs produce byte-identical files. `--check-baseline` compares against the committed
  `eval/baseline.json`, so a quality change is always an explicit, reviewable diff; the deliberately
  incomplete captures in `eval/fixtures/incomplete` prove the checks can fail. `--live` runs the
  real agents, refuses to start without an explicit `EVAL_LIVE_CONFIRM` case budget, and is never
  used by CI. Documented in [docs/quality-evals.md](docs/quality-evals.md).

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
