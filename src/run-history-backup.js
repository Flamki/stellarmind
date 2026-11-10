import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { backupRunHistory, restoreRunHistory, verifyRunHistoryFile } from './storage/run-history.js'

const DEFAULT_HISTORY_FILE = process.env.RUN_HISTORY_FILE || 'data/run-history.json'

function defaultBackupPath(sourcePath) {
  const dir = path.join(path.dirname(sourcePath), 'backups')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(dir, `run-history-${stamp}.backup.json`)
}

export async function runHistoryCli(argv = process.argv.slice(2)) {
  const [command, arg1, arg2] = argv

  if (command === 'backup') {
    const sourcePath = arg2 ? arg1 : DEFAULT_HISTORY_FILE
    const backupPath = arg2 || arg1 || defaultBackupPath(sourcePath)
    const report = await backupRunHistory(sourcePath, backupPath)
    console.log(JSON.stringify({ action: 'backup', ...report }, null, 2))
    return report
  }

  if (command === 'restore') {
    if (!arg1) {
      const err = new Error(
        'Usage: node src/run-history-backup.js restore <backupPath> [targetPath]'
      )
      err.code = 'MISSING_BACKUP_PATH'
      throw err
    }
    const backupPath = arg1
    const targetPath = arg2 || DEFAULT_HISTORY_FILE
    const report = await restoreRunHistory(backupPath, targetPath)
    console.log(JSON.stringify({ action: 'restore', ...report }, null, 2))
    return report
  }

  if (command === 'verify') {
    const filePath = arg1 || DEFAULT_HISTORY_FILE
    const verified = await verifyRunHistoryFile(filePath)
    const report = { ...verified }
    delete report.runs
    delete report.idempotency
    console.log(JSON.stringify({ action: 'verify', ...report }, null, 2))
    return report
  }

  const err = new Error('Usage: node src/run-history-backup.js <backup|restore|verify> [args...]')
  err.code = 'INVALID_COMMAND'
  throw err
}

const isDirectExecution =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectExecution) {
  runHistoryCli().catch((err) => {
    console.error(`run-history-backup error (${err.code || 'ERROR'}): ${err.message}`)
    process.exit(1)
  })
}
