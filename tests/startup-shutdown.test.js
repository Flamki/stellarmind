/**
 * Startup and shutdown smoke checks (Issue #176)
 *
 * Boots the real server as a child process, waits for `/healthz` on an
 * ephemeral port, then shuts it down and proves nothing was left behind:
 * the process exits, the port is released, and the persisted history file is
 * still parseable afterwards.
 *
 * Portable by construction — `process.execPath` instead of a shell command,
 * `path.join` instead of string concatenation, `os.tmpdir()` (optionally
 * `SMOKE_WORKSPACE_DIR`) for the data directory, and a `finally` that always
 * escalates to `SIGKILL` so a failed job cannot leak a listening server.
 *
 * Run: node tests/startup-shutdown.test.js
 */

import assert from 'node:assert'
import fs from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url))
const startupTimeoutMs = 30000
const shutdownTimeoutMs = 15000

const failures = []
let passed = 0
let skipped = 0
const isWindows = process.platform === 'win32'

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message?.replace(/\n/g, '\n      ')}`)
  }
}

/** Ask the OS for a free port, then hand it to the server under test. */
async function findFreePort() {
  const probe = net.createServer()
  await new Promise((resolve, reject) => {
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', resolve)
  })
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

function portIsFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', () => resolve(false))
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)))
  })
}

async function fetchOk(url, timeoutMs = 3000) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  return response
}

const baseDir = process.env.SMOKE_WORKSPACE_DIR
  ? path.resolve(process.env.SMOKE_WORKSPACE_DIR)
  : os.tmpdir()
await fs.mkdir(baseDir, { recursive: true })

const workDir = await fs.mkdtemp(path.join(baseDir, 'stellar mind smoke '))
const historyFile = path.join(workDir, 'data', 'run history.json')

console.log('\nstartup and shutdown smoke checks (issue #176)')
console.log(`  workspace: ${workDir}`)

/** Start the server and return a handle with collected output. */
async function startServer({ port, extraEnv = {} } = {}) {
  const chosenPort = port ?? (await findFreePort())
  const child = spawn(process.execPath, [serverPath], {
    cwd: workDir,
    env: {
      ...process.env,
      PORT: String(chosenPort),
      SERVER_STELLAR_ADDRESS: process.env.SERVER_STELLAR_ADDRESS || 'GSMOKE_PLACEHOLDER',
      RUN_HISTORY_STORAGE: 'file',
      RUN_HISTORY_FILE: historyFile,
      LOG_FORMAT: 'json',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const output = { stdout: '', stderr: '' }
  child.stdout.on('data', (chunk) => {
    output.stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    output.stderr += chunk
  })

  return { child, port: chosenPort, output, baseUrl: `http://127.0.0.1:${chosenPort}` }
}

/** Wait for the child to exit; returns { code, signal, timedOut }. */
function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        resolve({ code: null, signal: null, timedOut: true })
      }
    }, timeoutMs)

    child.once('exit', (code, signal) => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ code, signal, timedOut: false })
      }
    })
  })
}

/** Always leave the machine clean, whatever happened. */
async function stopServer(handle) {
  if (!handle?.child || handle.child.exitCode !== null) return
  handle.child.kill('SIGTERM')
  let exit = await waitForExit(handle.child, 5000)
  if (exit.timedOut) {
    handle.child.kill('SIGKILL')
    exit = await waitForExit(handle.child, 5000)
  }
  return exit
}

function tail(text, lines = 12) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

await test('the server starts, answers health, and writes its history file', async () => {
  const handle = await startServer()
  try {
    let response = null
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      try {
        response = await fetchOk(`${handle.baseUrl}/healthz`)
        break
      } catch {
        await delay(250)
      }
    }

    assert.ok(response, `server did not answer /healthz within ${startupTimeoutMs}ms`)
    assert.strictEqual(response.status, 200)

    const body = await response.json()
    assert.strictEqual(body.status, 'ok')

    const stat = await fs.stat(historyFile)
    assert.ok(stat.isFile(), `the store created ${historyFile} on startup`)
  } finally {
    await stopServer(handle)
  }
})

await test('shutdown releases the process and the port, leaving no orphan', async () => {
  const handle = await startServer()
  let exit
  try {
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      const alive = await fetchOk(`${handle.baseUrl}/healthz`)
        .then(() => true)
        .catch(() => false)
      if (alive) break
      await delay(250)
    }

    handle.child.kill('SIGTERM')
    exit = await waitForExit(handle.child, shutdownTimeoutMs)
    assert.strictEqual(
      exit.timedOut,
      false,
      `server still running ${shutdownTimeoutMs}ms after shutdown:\n${tail(handle.output.stdout)}`
    )
  } finally {
    await stopServer(handle)
  }

  assert.strictEqual(await portIsFree(handle.port), true, `port ${handle.port} is still bound`)
})

await test('the history file is still parseable after a shutdown', async () => {
  const raw = await fs.readFile(historyFile, 'utf8')
  const parsed = JSON.parse(raw)
  assert.ok(Array.isArray(parsed.runs), 'the file keeps its shape across a start/stop cycle')
})

await test('a second start on the same data directory reloads without losing the file', async () => {
  const before = JSON.parse(await fs.readFile(historyFile, 'utf8'))
  const handle = await startServer()
  try {
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      const alive = await fetchOk(`${handle.baseUrl}/healthz`)
        .then(() => true)
        .catch(() => false)
      if (alive) break
      await delay(250)
    }
    const after = JSON.parse(await fs.readFile(historyFile, 'utf8'))
    assert.ok(Array.isArray(after.runs))
    assert.strictEqual(after.runs.length >= before.runs.length, true, 'no runs were dropped')
  } finally {
    await stopServer(handle)
  }
})

// Windows lets a second socket bind a port that is already in use (SO_REUSEADDR
// is set by Node and Windows resolves the conflict differently from Linux), so
// the bind-failure path cannot be provoked there: the child starts for real and
// the banner is correct. The check stays strict on POSIX, where the diagnostic
// path is what a container or a CI job actually hits.
if (isWindows) {
  skipped += 1
  console.log(
    '  ⊘ a port already in use fails loudly instead of reporting a start ' +
      '(skipped on Windows: a second bind to a busy port can succeed there)'
  )
} else {
  await test('a port already in use fails loudly instead of reporting a start', async () => {
    const blocker = net.createServer()
    await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
    const port = blocker.address().port

    const handle = await startServer({ port })
    try {
      const exit = await waitForExit(handle.child, 20000)
      await delay(300) // let the last stderr write land before it is read
      const combined = `${handle.output.stdout}${handle.output.stderr}`

      assert.strictEqual(
        exit.timedOut,
        false,
        `a taken port must not leave the process running:\n${tail(combined)}`
      )
      assert.notStrictEqual(exit.code, 0, 'a failed start must not exit successfully')
      assert.match(
        combined,
        new RegExp(`EADDRINUSE|port ${port}`),
        `expected a concise diagnostic naming the port, saw:\n${tail(combined)}`
      )
      assert.doesNotMatch(
        combined,
        /StellarMind — AI Agent Marketplace/,
        'the startup banner must not claim a server that never bound'
      )
    } finally {
      await stopServer(handle)
      await new Promise((resolve) => blocker.close(resolve))
    }
  })
}

await test('the temporary workspace is removed', async () => {
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const stillThere = await fs
    .stat(workDir)
    .then(() => true)
    .catch(() => false)
  assert.strictEqual(stillThere, false, `${workDir} should be gone`)
  console.log(`  (removed ${workDir})`)
})

console.log(
  `\n${passed} passed, ${failures.length} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`
)
if (failures.length > 0) {
  console.error(`\ndiagnostics: workspace was ${workDir}`)
  for (const { name, err } of failures) console.error(`  - ${name}: ${err.message}`)
  process.exitCode = 1
} else {
  await fs.rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
