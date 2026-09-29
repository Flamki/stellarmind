#!/usr/bin/env node
/**
 * Export a stored run report (Issue #167)
 *
 *   npm run export:run -- <runId> [--format json|md] [--out <path>]
 *
 * Reads the run from the same history store the server writes to and writes the
 * versioned JSON (default) or the readable Markdown to disk — or to stdout when
 * `--out -` is passed, so it can be piped or captured in CI.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.js'
import { createRunHistoryStore } from './storage/run-history.js'
import {
  buildRunExportJson,
  buildRunExportMarkdown,
  exportFilename,
  RUN_EXPORT_SCHEMA_VERSION,
} from './storage/run-export.js'

function parseArgs(argv) {
  const args = { runId: null, format: 'json', out: null }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--format') {
      args.format = String(argv[i + 1] || 'json').toLowerCase()
      i += 1
    } else if (arg === '--out') {
      args.out = argv[i + 1]
      i += 1
    } else if (!args.runId) {
      args.runId = arg
    }
  }
  return args
}

function usage() {
  console.error(
    'Usage: npm run export:run -- <runId> [--format json|md] [--out <path>]\n' +
      '  --format  json (default) or md\n' +
      '  --out     file path, a directory, or - for stdout'
  )
}

async function main() {
  const { runId, format, out } = parseArgs(process.argv.slice(2))

  if (!runId) {
    usage()
    process.exitCode = 2
    return
  }
  if (!['json', 'md', 'markdown'].includes(format)) {
    console.error(`Unsupported format '${format}': use 'json' or 'md'`)
    process.exitCode = 2
    return
  }

  const store = await createRunHistoryStore(config)
  const run = await store.getRun(runId)
  if (!run) {
    console.error(`Run '${runId}' not found (store: ${config.runHistoryStorage})`)
    process.exitCode = 1
    return
  }

  const exported = buildRunExportJson(run, { network: config.network })
  const isMarkdown = format !== 'json'
  const contents = isMarkdown
    ? buildRunExportMarkdown(exported)
    : `${JSON.stringify(exported, null, 2)}\n`
  const extension = isMarkdown ? 'md' : 'json'

  if (out === '-') {
    process.stdout.write(contents)
    return
  }

  let target = out
  if (!target) {
    target = path.resolve(process.cwd(), exportFilename(exported.run.id, extension))
  } else {
    const resolved = path.resolve(process.cwd(), target)
    // A directory (or a path without an extension) gets the default filename.
    const looksLikeDirectory = target.endsWith(path.sep) || !path.extname(resolved)
    target = looksLikeDirectory
      ? path.join(resolved, exportFilename(exported.run.id, extension))
      : resolved
  }

  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, contents, 'utf8')

  console.log(
    `Exported ${runId} (report schema v${RUN_EXPORT_SCHEMA_VERSION}, ${format}) to ${target}`
  )
}

main().catch((err) => {
  console.error(`Export failed: ${err.message}`)
  process.exitCode = 1
})
