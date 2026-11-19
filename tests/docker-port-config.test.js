/**
 * Docker Port Configuration Tests
 * Validates that container port mappings and health checks are properly configured.
 *
 * Run: node tests/docker-port-config.test.js
 */

import assert from 'node:assert'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ─── Tiny test harness ──────────────────────────────────────────
const failures = []
let passed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

// ─── Helper to read files ───────────────────────────────────────
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

async function readRepoFile(filePath) {
  return await readFile(path.join(repoRoot, filePath), 'utf-8')
}

// ─── Test Configuration Files ───────────────────────────────────
console.log('Dockerfile Configuration')

test('Dockerfile exposes port 3001', async () => {
  const dockerfile = await readRepoFile('Dockerfile')
  assert.ok(dockerfile.includes('EXPOSE 3001'), 'Dockerfile should expose port 3001')
  assert.ok(!dockerfile.includes('EXPOSE 3000'), 'Dockerfile should not expose port 3000')
})

test('Dockerfile health check uses /healthz', async () => {
  const dockerfile = await readRepoFile('Dockerfile')
  assert.ok(dockerfile.includes('/healthz'), 'Health check should use /healthz endpoint')
  assert.ok(!dockerfile.includes('/health '), 'Health check should not use /health endpoint')
  assert.ok(!dockerfile.includes('/health||'), 'Health check should not use /health endpoint')
})

test('Dockerfile health check respects PORT env var', async () => {
  const dockerfile = await readRepoFile('Dockerfile')
  assert.ok(
    dockerfile.includes('${PORT:-3001}') || dockerfile.includes('localhost:3001'),
    'Health check should use PORT env var or default to 3001'
  )
})

console.log('docker-compose.yml Configuration')

test('docker-compose maps port 3001:3001', async () => {
  const compose = await readRepoFile('docker-compose.yml')
  assert.ok(
    compose.includes("'3001:3001'") || compose.includes('"3001:3001"'),
    'docker-compose should map port 3001:3001'
  )
  assert.ok(
    !compose.includes("'3000:3000'") && !compose.includes('"3000:3000"'),
    'docker-compose should not map port 3000:3000'
  )
})

test('docker-compose sets PORT=3001 environment variable', async () => {
  const compose = await readRepoFile('docker-compose.yml')
  assert.ok(compose.includes('PORT=3001'), 'docker-compose should set PORT=3001')
})

test('docker-compose health check uses /healthz', async () => {
  const compose = await readRepoFile('docker-compose.yml')
  assert.ok(compose.includes('/healthz'), 'Health check should use /healthz endpoint')
  assert.ok(
    !compose.includes("'/health'") && !compose.includes('"/health"'),
    'Health check should not use /health endpoint'
  )
})

test('docker-compose health check uses port 3001', async () => {
  const compose = await readRepoFile('docker-compose.yml')
  assert.ok(
    compose.includes('localhost:3001/healthz'),
    'Health check should probe localhost:3001/healthz'
  )
})

console.log('Server Configuration')

test('src/config.js defaults to port 3001', async () => {
  const config = await readRepoFile('src/config.js')
  assert.ok(config.includes('process.env.PORT || 3001'), 'config.js should default to port 3001')
})

console.log('Environment Configuration')

test('.env.example documents PORT=3001', async () => {
  const envExample = await readRepoFile('.env.example')
  assert.ok(envExample.includes('PORT=3001'), '.env.example should document PORT=3001')
})

test('.env.example reference table shows default 3001', async () => {
  const envExample = await readRepoFile('.env.example')
  const lines = envExample.split('\n')
  const portLine = lines.find((line) => line.includes('| PORT'))

  if (portLine) {
    assert.ok(
      portLine.includes('3001'),
      'Environment reference table should show PORT default as 3001'
    )
    assert.ok(
      !portLine.includes('3000'),
      'Environment reference table should not show PORT default as 3000'
    )
  }
})

console.log('Documentation')

test('README examples use port 3001', async () => {
  const readme = await readRepoFile('README.md')
  const port3001Count = (readme.match(/localhost:3001/g) || []).length
  const port3000Count = (readme.match(/localhost:3000/g) || []).length

  assert.ok(port3001Count > 0, 'README should have examples using port 3001')
  assert.strictEqual(port3000Count, 0, 'README should not have examples using port 3000')
})

test('docs/repository-map.md uses port 3001', async () => {
  const repoMap = await readRepoFile('docs/repository-map.md')
  assert.ok(
    repoMap.includes('localhost:3001') || !repoMap.includes('localhost:300'),
    'repository-map.md should use port 3001 or not mention localhost port'
  )
  assert.ok(!repoMap.includes('localhost:3000'), 'repository-map.md should not use port 3000')
})

console.log('Health Check Endpoint')

test('/healthz endpoint is implemented in server', async () => {
  const server = await readRepoFile('src/server.js')
  assert.ok(server.includes("app.get('/healthz'"), 'Server should implement GET /healthz')
})

test('/healthz returns required fields', async () => {
  const server = await readRepoFile('src/server.js')
  const healthzSection = server.slice(
    server.indexOf("app.get('/healthz'"),
    server.indexOf("app.get('/healthz'") + 500
  )

  assert.ok(healthzSection.includes('status'), '/healthz should return status field')
  assert.ok(healthzSection.includes('uptime'), '/healthz should return uptime field')
  assert.ok(healthzSection.includes('timestamp'), '/healthz should return timestamp field')
})

console.log('Port Configuration Consistency')

test('All configuration files use consistent port 3001', async () => {
  const dockerfile = await readRepoFile('Dockerfile')
  const compose = await readRepoFile('docker-compose.yml')
  const config = await readRepoFile('src/config.js')
  const envExample = await readRepoFile('.env.example')

  // Dockerfile exposes 3001
  assert.ok(dockerfile.includes('EXPOSE 3001'))

  // docker-compose maps 3001:3001
  assert.ok(compose.includes('3001:3001'))

  // config.js defaults to 3001
  assert.ok(config.includes('|| 3001'))

  // .env.example documents 3001
  assert.ok(envExample.includes('PORT=3001'))
})

test('All health checks use /healthz endpoint', async () => {
  const dockerfile = await readRepoFile('Dockerfile')
  const compose = await readRepoFile('docker-compose.yml')

  // Both use /healthz
  assert.ok(dockerfile.includes('/healthz'))
  assert.ok(compose.includes('/healthz'))

  // Neither use /health
  assert.ok(!dockerfile.includes('/health ') && !dockerfile.includes('/health||'))
  assert.ok(!compose.includes("'/health'") && !compose.includes('"/health"'))
})

// ─── Report results ──────────────────────────────────────────────
console.log(`\n${passed} passed, ${failures.length} failed`)

if (failures.length > 0) {
  process.exit(1)
}
