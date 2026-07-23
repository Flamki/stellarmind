import assert from 'node:assert'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const port = Number.parseInt(process.env.SMOKE_PORT, 10) || 3105
const baseUrl = `http://127.0.0.1:${port}`
const serverPath = fileURLToPath(new URL('../src/server.js', import.meta.url))
const startupTimeoutMs = 20000
const requestTimeoutMs = 5000

// Startup pricing validation requires a non-empty payTo address. A placeholder
// is fine here: x402 middleware init failures are caught by the server and the
// smoke check only exercises unauthenticated endpoints.
const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: String(port),
    SERVER_STELLAR_ADDRESS: process.env.SERVER_STELLAR_ADDRESS || 'GSMOKE_PLACEHOLDER',
    RUN_HISTORY_STORAGE: 'memory',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let serverOutput = ''
let exited = false
child.stdout.on('data', (chunk) => {
  serverOutput += chunk
})
child.stderr.on('data', (chunk) => {
  serverOutput += chunk
})
child.on('exit', () => {
  exited = true
})
child.on('error', (err) => {
  console.error(`Smoke check failed: could not spawn server: ${err.message}`)
  process.exit(1)
})

// Bounded requests: a route that accepts the connection but never responds
// must fail the check (and print the server output) instead of hanging until
// the job timeout cancels the run.
function get(path) {
  return fetch(`${baseUrl}${path}`, { signal: AbortSignal.timeout(requestTimeoutMs) })
}

async function waitForHealthz() {
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error('server exited before becoming healthy')
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

async function main() {
  console.log('Smoke check: booting server on port ' + port)

  const health = await waitForHealthz()
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

  console.log('Smoke check passed')
}

main()
  .then(() => {
    child.kill('SIGTERM')
    process.exit(0)
  })
  .catch((err) => {
    console.error(`Smoke check failed: ${err.message}`)
    if (serverOutput) {
      console.error('--- server output ---')
      console.error(serverOutput)
    }
    child.kill('SIGTERM')
    process.exit(1)
  })
