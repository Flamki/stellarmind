/**
 * Workspace-path-with-spaces checks (Issue #176)
 *
 * Copies this repository into a temporary directory whose *path contains
 * spaces* (Windows profile directories and many CI workspaces routinely do),
 * links `node_modules` so the copy can run, and executes the offline suites
 * from there. Any code that builds a path by concatenation, forgets to quote a
 * command, or assumes a POSIX-shaped path fails here and nowhere else.
 *
 * The copy is made with `fs.cpSync` and the suites are spawned through
 * `process.execPath`, so the runner itself is portable: no shell syntax, no
 * `cp`/`robocopy`, no assumptions about the separator.
 *
 * Run: node tests/support/space-path-suite.mjs
 */

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const SKIP = new Set(['node_modules', '.git', 'data', 'target', 'coverage', '.husky'])

const SUITES = [
  // Persistence through a spaced data directory.
  {
    name: 'storage reload',
    file: 'tests/storage-reload.test.js',
    env: (dir) => ({ STORAGE_RELOAD_DIR: path.join(dir, 'data store') }),
  },
  // Startup/shutdown with a spaced workspace.
  {
    name: 'startup + shutdown',
    file: 'tests/startup-shutdown.test.js',
    env: (dir) => ({ SMOKE_WORKSPACE_DIR: path.join(dir, 'runtime work') }),
  },
  // Writes into tests/fixtures inside the copy.
  { name: 'run history schema', file: 'tests/run-history-schema.test.js', env: () => ({}) },
]

function baseDir() {
  return process.env.SPACE_PATH_BASE_DIR
    ? path.resolve(process.env.SPACE_PATH_BASE_DIR)
    : os.tmpdir()
}

function copyRepo(destination) {
  fs.mkdirSync(destination, { recursive: true })
  // Enumerate the top level explicitly instead of filtering `fs.cpSync`: the
  // filter receives paths that can differ in case or separator on Windows, and a
  // miss there silently copies `node_modules` (which then makes the link below
  // fail with EEXIST).
  for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    fs.cpSync(path.join(repoRoot, entry.name), path.join(destination, entry.name), {
      recursive: true,
    })
  }
}

function linkNodeModules(destination) {
  const target = path.join(repoRoot, 'node_modules')
  const link = path.join(destination, 'node_modules')
  if (!fs.existsSync(target)) return false
  // The copy excludes node_modules; if something still landed there (an
  // interrupted run, a platform quirk) clear it so the link can be created.
  if (fs.existsSync(link)) fs.rmSync(link, { recursive: true, force: true })
  // `junction` on Windows needs no elevation; `dir` is the POSIX equivalent.
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}

function runSuite(suite, destination) {
  const started = Date.now()
  const result = spawn(process.execPath, [suite.file], {
    cwd: destination,
    env: {
      ...process.env,
      PORT: '', // the suites pick free ports themselves
      STORAGE_RELOAD_DIR: '',
      SMOKE_WORKSPACE_DIR: '',
      SPACE_PATH_BASE_DIR: '',
      ...suite.env(destination),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let output = ''
  result.stdout.on('data', (chunk) => {
    output += chunk
  })
  result.stderr.on('data', (chunk) => {
    output += chunk
  })

  return new Promise((resolve) => {
    result.once('exit', (code, signal) => {
      resolve({ code, signal, output, elapsedMs: Date.now() - started })
    })
  })
}

/** Keep the full output of a suite when the workflow asked for logs. */
function collectLog(name, output) {
  const dir = process.env.CI_LOG_DIR
  if (!dir) return
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `space-path-${name.replace(/[^a-z0-9]+/gi, '-')}.log`), output)
  } catch (err) {
    console.error(`  ! could not write the log for ${name}: ${err.message}`)
  }
}

function tail(text, lines = 15) {
  return text.trim().split('\n').slice(-lines).join('\n')
}

const failures = []
const base = baseDir()
fs.mkdirSync(base, { recursive: true })

// The directory name itself contains spaces, and so do the sub-directories the
// suites are pointed at.
const workspace = fs.mkdtempSync(path.join(base, 'stellar mind workspace '))

console.log('\nworkspace path with spaces (issue #176)')
console.log(`  workspace: ${workspace}`)

try {
  copyRepo(workspace)
  const linked = linkNodeModules(workspace)
  console.log(
    `  copied repository: ${linked ? 'with linked node_modules' : 'WITHOUT node_modules (npm install not run?)'}`
  )

  for (const suite of SUITES) {
    const outcome = await runSuite(suite, workspace)
    collectLog(suite.name, outcome.output)
    if (outcome.code === 0) {
      console.log(`  ✓ ${suite.name} (${outcome.elapsedMs}ms)`)
      continue
    }
    failures.push(suite.name)
    console.error(
      `  ✗ ${suite.name} exited with ${outcome.code ?? outcome.signal} after ${outcome.elapsedMs}ms`
    )
    console.error(`      ${tail(outcome.output).replace(/\n/g, '\n      ')}`)
  }

  if (linked) {
    const linkedTarget = fs.realpathSync(path.join(workspace, 'node_modules'))
    assert.ok(linkedTarget.length > 0, 'node_modules resolves inside the spaced workspace')
  }
} finally {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const stillThere = fs.existsSync(workspace)
  if (stillThere) console.error(`  ! could not remove ${workspace}`)
  else console.log(`  (removed ${workspace})`)
}

console.log(`\n${SUITES.length - failures.length} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.error(`\ndiagnostics: workspace was ${workspace}`)
  for (const name of failures) console.error(`  - ${name}`)
  process.exitCode = 1
}
