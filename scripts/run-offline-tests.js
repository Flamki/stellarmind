#!/usr/bin/env node
/**
 * Default offline regression gate (#175).
 *
 * Suites are discovered, never listed: every `<root>/**\/*.test.js` is part of
 * the default gate, so a new regression file is picked up the moment it lands.
 * The only files the gate skips live under OPT_IN_DIRS — live-funded demos, k6
 * load scenarios, anything needing network or Docker — and they are named in one
 * place, so a test-shaped file that is neither discovered nor opted in fails the
 * gate instead of rotting unnoticed.
 *
 * Usage:
 *   node scripts/run-offline-tests.js            # run every discovered suite
 *   node scripts/run-offline-tests.js --list     # print what would run
 *   node scripts/run-offline-tests.js --repo-root <dir> --roots tests,src
 *
 * Every failing suite keeps its own output and the process exits non-zero with
 * the failing suite names, so CI names the problem rather than printing "tests
 * failed".
 */
import { readdirSync, existsSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Directories whose suites are opt-in: they need k6, Docker, or live funding. */
export const OPT_IN_DIRS = ['tests/load', 'tests/opt-in']

/** Default discovery roots, relative to the repository root. */
export const DEFAULT_ROOTS = ['tests', 'src']

/** A file that looks like a suite but is not a `*.test.js` file is suspicious. */
const TEST_NAME_RE = /(^|[/.-])test([/.-]|$)/i

const DEFAULT_SUITE_TIMEOUT_MS = 120_000

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function toRel(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join('/')
}

function isOptedIn(rel) {
  return OPT_IN_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))
}

/** Discover every suite that belongs to the default offline gate. */
export function discoverSuites({ roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT } = {}) {
  const found = []
  for (const root of roots) {
    const abs = path.join(repoRoot, root)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
    for (const file of walk(abs)) {
      const rel = toRel(repoRoot, file)
      if (rel.endsWith('.test.js') && !isOptedIn(rel)) found.push(rel)
    }
  }
  return [...new Set(found)].sort()
}

/**
 * Test-shaped files that are neither discovered nor explicitly opted in. An
 * empty list means nothing under the roots can be silently skipped.
 */
export function findUnclassifiedSuites({ roots = DEFAULT_ROOTS, repoRoot = REPO_ROOT } = {}) {
  const discovered = new Set(discoverSuites({ roots, repoRoot }))
  const unclassified = []
  for (const root of roots) {
    const abs = path.join(repoRoot, root)
    if (!existsSync(abs) || !statSync(abs).isDirectory()) continue
    for (const file of walk(abs)) {
      const rel = toRel(repoRoot, file)
      if (!rel.endsWith('.js')) continue
      if (discovered.has(rel) || isOptedIn(rel)) continue
      if (TEST_NAME_RE.test(path.basename(rel))) unclassified.push(rel)
    }
  }
  return [...new Set(unclassified)].sort()
}

/** Run one suite in its own process; never throws, always reports. */
export function runSuite(rel, { repoRoot = REPO_ROOT, timeoutMs = DEFAULT_SUITE_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [rel], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  })
  const output = `${result.stdout || ''}${result.stderr || ''}`
  const timedOut = result.signal === 'SIGTERM' || result.error?.code === 'ETIMEDOUT'
  return {
    name: rel,
    ok: result.status === 0,
    status: result.status,
    timedOut,
    durationMs: Date.now() - started,
    output,
    error: result.error ? String(result.error.message || result.error) : null,
  }
}

const FAILURE_TAIL_LINES = 15

function tail(text, lines = FAILURE_TAIL_LINES) {
  const trimmed = text.trimEnd().split('\n')
  return trimmed.slice(Math.max(0, trimmed.length - lines)).join('\n')
}

/**
 * Run every discovered suite, printing one line per suite and the failing ones'
 * own output. Returns a summary; the CLI turns it into an exit code.
 */
export function runAll({
  roots = DEFAULT_ROOTS,
  repoRoot = REPO_ROOT,
  timeoutMs = DEFAULT_SUITE_TIMEOUT_MS,
  log = console.log,
} = {}) {
  const suites = discoverSuites({ roots, repoRoot })
  const unclassified = findUnclassifiedSuites({ roots, repoRoot })

  if (unclassified.length > 0) {
    log('Unclassified test-shaped files (add them to the gate or to OPT_IN_DIRS in scripts/run-offline-tests.js):')
    for (const file of unclassified) log(`  - ${file}`)
    return { suites, results: [], failed: suites, unclassified, timedOut: [] }
  }

  const results = []
  for (const suite of suites) {
    const result = runSuite(suite, { repoRoot, timeoutMs })
    results.push(result)
    const seconds = (result.durationMs / 1000).toFixed(1)
    log(`${result.ok ? '✔' : '✘'} ${suite} (${seconds}s)${result.timedOut ? ' — timed out' : ''}`)
  }

  const failed = results.filter((result) => !result.ok)
  for (const result of failed) {
    log(`\n--- ${result.name} ${result.timedOut ? 'timed out' : `exited ${result.status}`} ---`)
    log(tail(result.output))
    if (result.error) log(`spawn error: ${result.error}`)
  }

  const passed = results.length - failed.length
  log(`\n${results.length} suite(s): ${passed} passed, ${failed.length} failed`)
  if (failed.length > 0) {
    log(`Failed suites: ${failed.map((result) => result.name).join(', ')}`)
  }

  return {
    suites,
    results,
    failed: failed.map((result) => result.name),
    unclassified,
    timedOut: results.filter((result) => result.timedOut).map((result) => result.name),
  }
}

function parseArgs(argv) {
  const args = { list: false, roots: DEFAULT_ROOTS, repoRoot: REPO_ROOT }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--list') args.list = true
    else if (arg === '--roots') args.roots = String(argv[++i] || '').split(',').filter(Boolean)
    else if (arg === '--repo-root') args.repoRoot = path.resolve(argv[++i] || '.')
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i])
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.list) {
    for (const suite of discoverSuites(args)) console.log(suite)
    const unclassified = findUnclassifiedSuites(args)
    if (unclassified.length > 0) {
      console.error(`Unclassified test-shaped files: ${unclassified.join(', ')}`)
      process.exitCode = 1
    }
    return
  }

  const summary = runAll(args)
  if (summary.failed.length > 0 || summary.unclassified.length > 0) process.exitCode = 1
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) main()
