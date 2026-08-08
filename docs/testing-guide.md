# Testing Guide

## Overview

StellarMind uses a multi-layered testing approach to ensure reliability across agent interactions, payment flows, and budget enforcement.

## Test Categories

### Unit Tests (`npm test`)

Run individual component tests in isolation:

```bash
npm test                    # Run all unit tests
npm test -- --testPathPattern=settlement  # Run specific tests
npm test -- --watch         # Watch mode
```

Key test files:

| File | Coverage |
|------|----------|
| `src/agents/settlement-header.test.js` | x402 settlement header parsing |
| `src/agents/budget.test.js` | Budget enforcement logic |
| `src/agents/orchestrator.test.js` | Task decomposition and routing |

### Budget Guardrail Tests (`npm run test:budget`)

Validates spending constraints:

```bash
npm run test:budget
```

Tests ensure:
- Tasks cannot exceed per-task budget
- Global cap is respected across concurrent tasks
- Minimum balance reserve is maintained
- Rate limiting prevents agent abuse

### Integration Smoke Tests (`npm run smoke`)

End-to-end verification of the API surface:

```bash
npm run smoke
```

Validates:
- Premium endpoints return proper x402 challenges
- Health check endpoint responds correctly
- SSE stream initializes and delivers events
- Agent registry returns valid agent descriptors

### Manual Testing with Stellar Testnet

For payment flow testing on Testnet:

```bash
# 1. Fund your test account
curl "https://friendbot.stellar.org?addr=YOUR_PUBLIC_KEY"

# 2. Start the server with debug logging
DEBUG=stellar-mind:* STELLAR_NETWORK=TESTNET npm run dev

# 3. Submit a task via the dashboard or curl
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"task":"analyze market trends","budget":10}'
```

### Running CI Locally

Simulate the full CI pipeline:

```bash
# Lint
npm run lint
npm run format:check

# Test matrix (requires nvm)
for v in 18 20 22; do
  nvm use $v && npm ci && npm test
done

# Coverage
npx c8 --reporter=lcov --reporter=text npm test
```

## Test Fixtures

Test fixtures are located in `test/fixtures/`:

```
test/fixtures/
├── payments/           # Stellar transaction fixtures
├── agents/             # Mock agent responses
└── sse/                # SSE event stream fixtures
```

## Writing New Tests

1. Create test file next to the source: `src/path/to/module.test.js`
2. Use the project's test framework (Jest)
3. Mock external dependencies (Stellar SDK, HTTP clients)
4. Run `npm test` to verify

### Example Test Pattern

```javascript
const { enforceBudget } = require('../agents/budget');

describe('Budget Enforcement', () => {
  it('rejects tasks exceeding per-task budget', () => {
    const result = enforceBudget({ cost: 100 }, { maxPerTask: 50 });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('exceeds');
  });

  it('allows tasks within budget', () => {
    const result = enforceBudget({ cost: 30 }, { maxPerTask: 50 });
    expect(result.allowed).toBe(true);
  });

  it('deducts from global cap', () => {
    const state = { globalCap: 100, spent: 80 };
    const result = enforceBudget({ cost: 15 }, { maxPerTask: 50 }, state);
    expect(result.allowed).toBe(true);
    expect(state.spent).toBe(95);
  });
});
```
