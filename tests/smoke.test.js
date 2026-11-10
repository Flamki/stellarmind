import assert from 'node:assert'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const port = Number.parseInt(process.env.SMOKE_PORT, 10) || 3105
const baseUrl = `http://127.0.0.1:${port}`
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url))
const startupTimeoutMs = 20000
const requestTimeoutMs = 5000

function get(urlPath) {
  return fetch(`${baseUrl}${urlPath}`, { signal: AbortSignal.timeout(requestTimeoutMs) })
}

export async function terminateChildProcess(child, timeoutMs = 4000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  await new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (!settled) {
        settled = true
        resolve()
      }
    }

    child.once('exit', finish)
    child.once('close', finish)

    try {
      child.kill('SIGTERM')
    } catch {
      finish()
      return
    }

    setTimeout(() => {
      if (!settled) {
        try {
          child.kill('SIGKILL')
        } catch {
          // ignore if process already exited
        }
        finish()
      }
    }, timeoutMs).unref()
  })
}

async function runSmokeInstance({ cwd, historyFile }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      SERVER_STELLAR_ADDRESS: process.env.SERVER_STELLAR_ADDRESS || 'GSMOKE_PLACEHOLDER',
      RUN_HISTORY_STORAGE: 'file',
      RUN_HISTORY_FILE: historyFile,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let serverOutput = ''
  let exited = false
  let exitCode = null
  let exitSignal = null

  child.stdout.on('data', (chunk) => {
    serverOutput += chunk
  })
  child.stderr.on('data', (chunk) => {
    serverOutput += chunk
  })
  child.on('exit', (code, signal) => {
    exited = true
    exitCode = code
    exitSignal = signal
  })

  const waitForHealthz = async () => {
    const deadline = Date.now() + startupTimeoutMs
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `server exited before becoming healthy (code=${exitCode}, signal=${exitSignal})`
        )
      }
      try {
        const res = await get('/healthz')
        if (res.ok) return res.json()
      } catch {
        // server not accepting connections yet
      }
      await delay(250)
    }
    throw new Error(`server did not respond on /healthz within ${startupTimeoutMs}ms`)
  }

  return {
    child,
    waitForHealthz,
    getDiagnostics: () => ({
      platform: process.platform,
      node: process.version,
      cwd,
      historyFile,
      exited,
      exitCode,
      exitSignal,
      serverOutput: serverOutput.slice(-4000),
    }),
  }
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'stellarmind-smoke-'))
  const workspaceWithSpaces = path.join(tempRoot, 'StellarMind Smoke Workspace With Spaces')
  const historyFile = path.join(workspaceWithSpaces, 'data', 'run-history.json')
  await fs.mkdir(workspaceWithSpaces, { recursive: true })

  let activeInstance = null

  try {
    console.log(`Smoke check (${process.platform}): booting server on port ${port}`)

    activeInstance = await runSmokeInstance({
      cwd: workspaceWithSpaces,
      historyFile,
    })

    const health = await activeInstance.waitForHealthz()
    assert.strictEqual(health.status, 'ok', '/healthz should report status ok')
    console.log('PASS /healthz responds with status ok')

    const statusRes = await get('/api/status')
    assert.strictEqual(statusRes.status, 200, '/api/status should return 200')
    const status = await statusRes.json()
    assert.strictEqual(status.status, 'online', '/api/status should report online')
    console.log('PASS /api/status reports online')

    const agentsRes = await get('/api/agents')
    assert.strictEqual(agentsRes.status, 200, '/api/agents should return 200')
    const agents = await agentsRes.json()
    assert(Array.isArray(agents) && agents.length > 0, '/api/agents should list agents')
    console.log(`PASS /api/agents lists ${agents.length} agents`)

    const persistedRaw = await fs.readFile(historyFile, 'utf8')
    const persisted = JSON.parse(persistedRaw)
    assert.strictEqual(persisted.version, 1, 'run-history file should be initialized with v1')
    console.log('PASS temporary file history initialized in path with spaces')

    await terminateChildProcess(activeInstance.child)
    activeInstance = null
    console.log('Smoke check passed')
  } catch (err) {
    console.error(`Smoke check failed: ${err.message}`)
    if (activeInstance) {
      const diag = activeInstance.getDiagnostics()
      console.error(
        `Diagnostics: platform=${diag.platform} node=${diag.node} exitCode=${diag.exitCode} signal=${diag.exitSignal}`
      )
      console.error(`Workspace: ${diag.cwd}`)
      if (diag.serverOutput) {
        console.error('--- server output ---')
        console.error(diag.serverOutput)
      }
      await terminateChildProcess(activeInstance.child)
    }
    process.exitCode = 1
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  await main()
}
