/**
 * Production image dependency & Husky prepare lifecycle tests (Issue #177)
 *
 * Run: node tests/docker-lifecycle.test.js
 */

import assert from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8')
const dockerignore = fs.readFileSync(path.join(repoRoot, '.dockerignore'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const failures = []
let passed = 0

async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.error(`  ✗ ${name}\n      ${err.message.replace(/\n/g, '\n      ')}`)
  }
}

console.log('Production Image Dependency & Husky Lifecycle')

await test('Dockerfile uses npm ci --omit=dev without --ignore-scripts', () => {
  const activeLines = dockerfile
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.match(activeLines, /RUN npm ci --omit=dev\b/, 'Dockerfile should run npm ci --omit=dev')
  assert.ok(
    !activeLines.includes('--only=production'),
    'Dockerfile should not use deprecated --only=production flag'
  )
  assert.ok(
    !activeLines.includes('--ignore-scripts'),
    'Dockerfile must not indiscriminately disable dependency lifecycle scripts via --ignore-scripts'
  )
  assert.match(activeLines, /NODE_ENV=production/, 'Dockerfile should set NODE_ENV=production')
  assert.match(activeLines, /HUSKY=0/, 'Dockerfile should set HUSKY=0')
})

await test('.dockerignore and Dockerfile exclude .git and .husky from build and runtime', () => {
  const ignoreEntries = dockerignore
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  assert.ok(ignoreEntries.includes('.git'), '.dockerignore must exclude .git')
  assert.ok(ignoreEntries.includes('.husky'), '.dockerignore must exclude .husky')
  assert.ok(!/COPY[^\n]*\.git\b/.test(dockerfile), 'Dockerfile must not copy .git')
  assert.ok(!/COPY[^\n]*\.husky\b/.test(dockerfile), 'Dockerfile must not copy .husky')
})

await test('prepare script succeeds when husky and .git are omitted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-prepare-prod-'))
  try {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tempDir, 'package.json'))

    // Case 1: devDependencies omitted (husky module not installed), default env
    const omittedEnv = { ...process.env }
    delete omittedEnv.NODE_ENV
    delete omittedEnv.HUSKY
    const omittedRun = spawnSync(npmCmd, ['run', 'prepare'], {
      cwd: tempDir,
      env: omittedEnv,
      encoding: 'utf8',
    })
    assert.strictEqual(
      omittedRun.status,
      0,
      `prepare should succeed when husky is omitted: ${omittedRun.stderr || omittedRun.stdout}`
    )

    // Case 2: NODE_ENV=production
    const prodRun = spawnSync(npmCmd, ['run', 'prepare'], {
      cwd: tempDir,
      env: { ...process.env, NODE_ENV: 'production' },
      encoding: 'utf8',
    })
    assert.strictEqual(
      prodRun.status,
      0,
      `prepare should succeed when NODE_ENV=production: ${prodRun.stderr || prodRun.stdout}`
    )

    // Case 3: HUSKY=0
    const huskyZeroRun = spawnSync(npmCmd, ['run', 'prepare'], {
      cwd: tempDir,
      env: { ...process.env, HUSKY: '0' },
      encoding: 'utf8',
    })
    assert.strictEqual(
      huskyZeroRun.status,
      0,
      `prepare should succeed when HUSKY=0: ${huskyZeroRun.stderr || huskyZeroRun.stdout}`
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

await test('npm ci --omit=dev installs only runtime dependencies without .git', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-prod-install-'))
  try {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tempDir, 'package.json'))
    fs.copyFileSync(
      path.join(repoRoot, 'package-lock.json'),
      path.join(tempDir, 'package-lock.json')
    )

    const installRun = spawnSync(
      npmCmd,
      ['ci', '--omit=dev', '--prefer-offline', '--no-audit', '--no-fund'],
      {
        cwd: tempDir,
        env: { ...process.env, NODE_ENV: 'production', HUSKY: '0' },
        encoding: 'utf8',
      }
    )
    assert.strictEqual(
      installRun.status,
      0,
      `npm ci --omit=dev failed: ${installRun.stderr || installRun.stdout}`
    )

    for (const dep of Object.keys(pkg.dependencies)) {
      assert.ok(
        fs.existsSync(path.join(tempDir, 'node_modules', ...dep.split('/'))),
        `Required production dependency ${dep} should be installed`
      )
    }

    for (const devDep of Object.keys(pkg.devDependencies)) {
      assert.ok(
        !fs.existsSync(path.join(tempDir, 'node_modules', ...devDep.split('/'))),
        `Development dependency ${devDep} should not be installed in production`
      )
    }

    assert.ok(
      !fs.existsSync(path.join(tempDir, '.husky')),
      'Production install should not create .husky directory'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

await test('Contributor installs still configure Husky hooks in a git checkout', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stellarmind-contrib-hooks-'))
  try {
    fs.copyFileSync(path.join(repoRoot, 'package.json'), path.join(tempDir, 'package.json'))
    fs.cpSync(path.join(repoRoot, '.husky'), path.join(tempDir, '.husky'), { recursive: true })
    fs.mkdirSync(path.join(tempDir, 'node_modules'), { recursive: true })
    fs.symlinkSync(
      path.join(repoRoot, 'node_modules', 'husky'),
      path.join(tempDir, 'node_modules', 'husky'),
      'dir'
    )

    const gitInit = spawnSync('git', ['init'], { cwd: tempDir, encoding: 'utf8' })
    assert.strictEqual(gitInit.status, 0, `git init failed: ${gitInit.stderr}`)

    const contribEnv = { ...process.env, NODE_ENV: 'development' }
    delete contribEnv.HUSKY

    const prepareRun = spawnSync(npmCmd, ['run', 'prepare'], {
      cwd: tempDir,
      env: contribEnv,
      encoding: 'utf8',
    })
    assert.strictEqual(
      prepareRun.status,
      0,
      `Contributor prepare failed: ${prepareRun.stderr || prepareRun.stdout}`
    )

    const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], {
      cwd: tempDir,
      encoding: 'utf8',
    })
    assert.strictEqual(hooksPath.status, 0, 'git config core.hooksPath should be set')
    assert.strictEqual(
      hooksPath.stdout.trim(),
      '.husky/_',
      'Contributor prepare should configure core.hooksPath to .husky/_'
    )
    assert.ok(
      fs.existsSync(path.join(tempDir, '.husky', '_', 'pre-commit')),
      'Husky should generate .husky/_/pre-commit runner'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

await test('Application starts cleanly with isolated demo configuration and no .git dependency', async () => {
  const port = 3177
  const serverPath = path.join(repoRoot, 'src', 'server.js')
  const child = spawn(process.execPath, [serverPath], {
    cwd: os.tmpdir(),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      SERVER_STELLAR_ADDRESS: 'GSMOKE_PLACEHOLDER',
      RUN_HISTORY_STORAGE: 'memory',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })

  try {
    const deadline = Date.now() + 15000
    let healthy = false
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
          signal: AbortSignal.timeout(2000),
        })
        if (res.ok) {
          const body = await res.json()
          assert.strictEqual(body.status, 'ok')
          healthy = true
          break
        }
      } catch {
        // wait for server
      }
      await delay(200)
    }
    assert.ok(healthy, `Server failed to become healthy outside .git directory:\n${output}`)
  } finally {
    child.kill('SIGTERM')
  }
})

console.log('Documentation')

await test('Lifecycle strategy is documented in CONTRIBUTING.md and docs/DOCKER_DEPLOYMENT.md', () => {
  const contributing = fs.readFileSync(path.join(repoRoot, 'CONTRIBUTING.md'), 'utf8')
  const dockerDoc = fs.readFileSync(path.join(repoRoot, 'docs', 'DOCKER_DEPLOYMENT.md'), 'utf8')
  assert.ok(
    contributing.includes('--omit=dev') && contributing.includes('--ignore-scripts'),
    'CONTRIBUTING.md should document the prepare lifecycle strategy'
  )
  assert.ok(
    dockerDoc.includes('--omit=dev') && dockerDoc.includes('--ignore-scripts'),
    'docs/DOCKER_DEPLOYMENT.md should document the production dependency lifecycle strategy'
  )
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  process.exit(1)
}
