# StellarMind Load Testing

Load and concurrency tests for the StellarMind orchestrator and SSE event stream.

## Quick Start

### k6

```bash
# Install k6: https://k6.io/docs/get-started/installation/
k6 run tests/load/load-test.js

# Custom base URL and output
BASE_URL=https://stellarmind.example.com k6 run --out json=results.json tests/load/load-test.js
```

### Artillery

```bash
# Install Artillery: npm install -g artillery
artillery run tests/load/load-test.yml

# With environment variables
TASK_TEMPLATE="Custom task" artillery run tests/load/load-test.yml
```

## Baseline Metrics

| Metric | Target | Critical |
|--------|--------|----------|
| Orchestrate p95 latency | < 2000ms | < 4000ms |
| Health check p99 latency | < 100ms | < 200ms |
| SSE error rate | < 1% | < 5% |
| Max concurrent VUs | 50 | — |

## Test Coverage

| Endpoint | Method | Scenarios |
|----------|--------|-----------|
| `/healthz` | GET | Baseline health, sustained load |
| `/api/orchestrate` | POST | Task decomposition, budget enforcement |
| `/api/orchestrate` | GET | Query-string variant |
| `/api/events` | GET | SSE stream connection |
| `/api/agents` | GET | Agent registry read |
| `/api/agents/discover/:capability` | GET | Capability-based lookup |

## Follow-up Tasks

Findings from these load tests should produce:
- Orchestrator concurrency tuning (worker pool size)
- SSE connection pooling optimization
- Rate limiter threshold calibration
- Resource usage profiling (CPU/memory under load)
