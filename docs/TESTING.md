# Testing Guide

This document describes the test infrastructure and how to add new tests.

## Test Organization

Tests are organized into three categories via `tests/test-manifest.json`:

### 1. Offline Regression Tests (`offline`)

Fast, deterministic tests that run without network dependencies. These are the core quality gate and
run automatically in CI.

**Examples:**

- Unit tests for agents, orchestration, pricing
- Payment reconciliation logic
- Run history persistence
- Request validation
- API integration tests (mocked)

**Command:** `npm test`

### 2. Validation Tests (`validation`)

API validation and contract tests that verify request/response schemas.

**Examples:**

- API validation tests
- Schema validation

**Command:** `npm run test:validation`

### 3. Opt-in Tests (`optin`)

Tests requiring live funding, network access, or manual execution. These do NOT run in CI
automatically.

**Examples:**

- Demo scripts (`npm run demo`)
- Load tests (`tests/load/load-test.js`)
- Smoke tests with real server startup (`npm run smoke`)

**Command:** Run individually as needed

## Running Tests

```bash
# Run all offline regression tests (default)
npm test

# Run offline + validation tests
npm run test:all

# Run only validation tests
npm run test:validation

# Validate that all tests are categorized
npm run test:validate-manifest

# Run a specific test directly
node tests/orchestrator.budget.test.js

# Run smoke test (opt-in)
npm run smoke

# Run demo (opt-in, requires funded wallets)
npm run demo
```

## Adding New Tests

When you add a new test file, you **must** categorize it in `tests/test-manifest.json`:

1. **For offline regression tests** (most common):

   ```json
   {
     "offline": ["tests/my-new-feature.test.js"]
   }
   ```

2. **For validation tests**:

   ```json
   {
     "validation": ["tests/api-contract-validation.test.js"]
   }
   ```

3. **For opt-in tests** (live funding, network, manual):

   ```json
   {
     "optin": ["tests/load/stress-test.js"]
   }
   ```

### Why This Matters

The manifest-based approach ensures:

✅ **No silent omissions** — New tests cannot accidentally skip CI  
✅ **Explicit categorization** — Every test's purpose is documented  
✅ **Fast feedback** — Offline tests run quickly without network delays  
✅ **Flexible execution** — Run full suite or specific categories

### Validation

CI automatically validates that every `.test.js` file is categorized:

```bash
npm run test:validate-manifest
```

If you see this error:

```
❌ Uncategorized test files found:
   - tests/my-new-test.test.js
```

Add the file to `tests/test-manifest.json` under the appropriate category.

## Test File Naming

- **Unit/integration tests:** `tests/feature-name.test.js`
- **Component tests:** `src/component/feature.test.js`
- **Load tests:** `tests/load/scenario.js`

All files matching `*.test.js` are discovered by the validator.

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs:

1. **Lint** — ESLint, Prettier, Markdown lint
2. **Validate manifest** — Ensures all tests are categorized
3. **Offline tests** — `npm test`
4. **Validation tests** — `npm run test:validation`
5. **Smoke** — `npm run smoke`

Failures in any step block the merge.

## Test Requirements

### Offline Tests Must

- ✅ Run without network access
- ✅ Complete in < 10 seconds (per file)
- ✅ Be deterministic (no flaky behavior)
- ✅ Exit with code 0 on success, nonzero on failure

### Validation Tests May

- Call APIs with mocked responses
- Verify request/response contracts
- Test schema validation

### Opt-in Tests May

- Require funded Stellar wallets
- Make real network requests
- Take longer to complete
- Require manual setup

## Troubleshooting

### "Uncategorized test files found"

Add the test to `tests/test-manifest.json`.

### "Test file not found"

The manifest references a file that doesn't exist. Remove it from the manifest.

### Test hangs or times out

Offline tests should not start servers or wait for network. Move long-running tests to `optin`.

### Exit code is always 0

Tests must throw errors or call `process.exit(1)` on failure. Use `assert` or test framework
assertions.

## Example Test Structure

```javascript
/**
 * Feature Name Tests
 *
 * What this test validates and why.
 *
 * Run: node tests/feature-name.test.js
 */

import assert from 'node:assert'

console.log('Testing feature X...')

// Test case 1
assert.strictEqual(1 + 1, 2, 'Basic math works')

// Test case 2
const result = myFunction()
assert.ok(result.success, 'Function returns success')

console.log('✅ All tests passed')
process.exit(0)
```

## Related Files

- `tests/test-manifest.json` — Test categorization
- `tests/run-tests.js` — Test runner
- `tests/validate-manifest.js` — Manifest validator
- `.github/workflows/ci.yml` — CI configuration
- `package.json` — Test commands
