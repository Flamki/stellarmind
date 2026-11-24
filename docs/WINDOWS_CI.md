# Windows CI Coverage

This document describes the Windows compatibility testing in the CI pipeline.

## Overview

As of issue #176, the CI pipeline runs tests on both **Linux** and **Windows** to ensure
cross-platform compatibility. This catches platform-specific issues early:

- File path handling (forward slash vs backslash)
- Line ending differences (LF vs CRLF)
- Child process behavior (SIGTERM vs SIGKILL)
- Temporary directory locations
- Path handling with spaces

## CI Matrix

The following jobs run on both `ubuntu-latest` and `windows-latest`:

### 1. Unit and API Tests

Runs all offline regression tests including:

- Agent orchestration
- Budget tracking
- Payment attempts
- API validation
- **Windows compatibility tests** (paths with spaces, file operations, etc.)

### 2. Smoke Tests

Starts the server and validates:

- Server startup and `/healthz` endpoint
- API status endpoint (`/api/status`)
- Agent registry endpoint (`/api/agents`)
- Proper child process cleanup on both platforms

## Windows-Specific Adaptations

### Child Process Cleanup

**Problem:** Windows doesn't support POSIX signals like `SIGTERM`.

**Solution:** The smoke test detects the platform and uses appropriate termination:

```javascript
function cleanupChild() {
  if (process.platform === 'win32') {
    child.kill('SIGKILL')
  } else {
    child.kill('SIGTERM')
  }
}
```

### Path Handling

**Problem:** Windows uses backslashes (`\`) while Linux uses forward slashes (`/`).

**Solution:** All code uses `path.join()` and `path.resolve()` for platform-independent paths:

```javascript
const historyFile = path.join(tempDir, 'run-history.json')
```

### Temporary Directories

**Problem:** Temp directory locations differ across platforms.

**Solution:** Use `os.tmpdir()` consistently:

```javascript
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-'))
```

### Line Endings

**Problem:** Windows uses CRLF (`\r\n`) while Linux uses LF (`\n`).

**Solution:**

- `.gitattributes` normalizes line endings in Git
- Code reads files with `utf8` encoding which handles both
- Tests validate both CRLF and LF line endings work correctly

## Windows Compatibility Tests

The test suite includes explicit Windows compatibility validation:

```bash
node tests/windows-compatibility.test.js
```

This test validates:

1. ✅ Paths with spaces
2. ✅ Path normalization across platforms
3. ✅ File storage in temporary directories
4. ✅ Line ending handling (CRLF vs LF)
5. ✅ Child process spawn and cleanup
6. ✅ Concurrent file operations
7. ✅ Storage reload after simulated crash
8. ✅ Special characters in filenames

## Running Windows Tests Locally

### On Windows

```powershell
# Install dependencies
npm ci

# Run all tests
npm test

# Run only smoke test
npm run smoke

# Run only Windows compatibility tests
node tests/windows-compatibility.test.js
```

### On Linux (validate cross-platform code)

```bash
# Run all tests (includes Windows compatibility checks)
npm test

# The tests validate cross-platform code even on Linux
```

## CI Failure Diagnostics

When a Windows job fails, check:

1. **Path separators**: Ensure code uses `path.join()`, not string concatenation
2. **Process cleanup**: Check child processes are terminated properly
3. **Line endings**: Verify files are read/written with explicit encoding
4. **Temporary files**: Ensure temp directories are cleaned up
5. **Timeouts**: Windows may be slower for some operations; check timeout values

## Workspace Paths with Spaces

The CI explicitly tests handling of workspace paths containing spaces. This is validated by:

1. Creating temporary directories with spaces: `stellarmind test 1234567890`
2. Writing and reading files from those paths
3. Running file storage operations with spaces in paths

If your code doesn't use `path.join()` and quotes properly, paths with spaces will fail.

## Best Practices for Windows Compatibility

### ✅ DO

```javascript
// Use path.join() for all path operations
const filePath = path.join(dir, 'file.json')

// Use os.tmpdir() for temporary files
const temp = path.join(os.tmpdir(), 'prefix-')

// Clean up child processes with platform detection
if (process.platform === 'win32') {
  child.kill('SIGKILL')
} else {
  child.kill('SIGTERM')
}

// Use explicit UTF-8 encoding
await fs.readFile(file, 'utf8')
await fs.writeFile(file, content, 'utf8')
```

### ❌ DON'T

```javascript
// Don't concatenate paths with /
const filePath = dir + '/' + 'file.json' // ❌

// Don't hardcode /tmp
const temp = '/tmp/prefix-' // ❌

// Don't assume POSIX signals work
child.kill('SIGTERM') // ❌ Fails on Windows

// Don't rely on default encoding
await fs.readFile(file) // ❌ May handle line endings differently
```

## Future Improvements

Potential enhancements for Windows coverage:

- [ ] Test with PowerShell Core vs Command Prompt
- [ ] Validate UNC paths (`\\server\share`)
- [ ] Test long path support (> 260 characters)
- [ ] Validate file locking behavior
- [ ] Test case-insensitive filesystem scenarios

## Related Issues

- #176 - Add Windows coverage for startup, storage, and contributor commands
- #175 - Make the default test command run every intended offline regression suite
- #135 - Serialize file-history writes and drain pending events before completion

## See Also

- [CONTRIBUTING.md](../CONTRIBUTING.md) - Contributor workflow including Windows setup
- [docs/TESTING.md](TESTING.md) - Test organization and execution (when available)
- `.github/workflows/ci.yml` - CI pipeline configuration
