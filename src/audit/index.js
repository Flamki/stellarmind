/**
 * Audit History Module — StellarMind
 * Persists orchestration and payment events for audit history.
 * Stellar Wave bounty #26
 */

const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const AUDIT_DIR = process.env.AUDIT_DIR || path.join(__dirname, '..', '..', 'logs', 'audit');
const RETENTION_DAYS = parseInt(process.env.AUDIT_RETENTION_DAYS || '90', 10);

class AuditLogger {
  constructor() {
    this.initialized = false;
  }

  async init() {
    await fs.mkdir(AUDIT_DIR, { recursive: true });
    this.initialized = true;
  }

  /**
   * Generate a deterministic event ID from event data.
   */
  _generateEventId(event) {
    const payload = JSON.stringify({
      type: event.type,
      entityId: event.entityId,
      timestamp: event.timestamp,
      action: event.action
    });
    return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  /**
   * Get the log file path for a given date.
   */
  _getLogPath(date) {
    const d = date || new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return path.join(AUDIT_DIR, `audit-${yyyy}-${mm}-${dd}.jsonl`);
  }

  /**
   * Record an orchestration event.
   * @param {Object} event
   * @param {'orchestration'|'payment'|'agent'|'system'} event.type
   * @param {string} event.entityId — run ID, payment ID, agent ID, etc.
   * @param {string} event.action — 'started', 'completed', 'failed', etc.
   * @param {Object} [event.metadata] — additional data
   */
  async record(event) {
    if (!this.initialized) await this.init();

    const entry = {
      eventId: this._generateEventId(event),
      type: event.type,
      entityId: event.entityId,
      action: event.action,
      timestamp: event.timestamp || new Date().toISOString(),
      metadata: event.metadata || {}
    };

    const logPath = this._getLogPath(new Date(entry.timestamp));
    const line = JSON.stringify(entry) + '\n';
    await fs.appendFile(logPath, line, 'utf8');
    return entry.eventId;
  }

  /**
   * Query audit events within a date range.
   * @param {Object} filters
   * @param {string} [filters.type] — event type filter
   * @param {string} [filters.entityId] — entity ID filter
   * @param {Date} [filters.from] — start date
   * @param {Date} [filters.to] — end date
   * @param {number} [filters.limit] — max results (default 100)
   */
  async query(filters = {}) {
    const { type, entityId, from, to, limit = 100 } = filters;
    const results = [];
    const start = from || new Date(Date.now() - RETENTION_DAYS * 86400000);
    const end = to || new Date();

    const current = new Date(start);
    while (current <= end) {
      const logPath = this._getLogPath(current);
      try {
        const content = await fs.readFile(logPath, 'utf8');
        for (const line of content.trim().split('\n')) {
          if (!line) continue;
          try {
            const entry = JSON.parse(line);
            if (type && entry.type !== type) continue;
            if (entityId && entry.entityId !== entityId) continue;
            results.push(entry);
            if (results.length >= limit) return results;
          } catch (_) { /* skip malformed lines */ }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') throw e;
      }
      current.setDate(current.getDate() + 1);
    }

    return results;
  }

  /**
   * Clean up audit logs older than retention period.
   */
  async cleanup() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000);
    const files = await fs.readdir(AUDIT_DIR);
    for (const file of files) {
      if (!file.startsWith('audit-') || !file.endsWith('.jsonl')) continue;
      const dateStr = file.replace('audit-', '').replace('.jsonl', '');
      const [yyyy, mm, dd] = dateStr.split('-').map(Number);
      const fileDate = new Date(yyyy, mm - 1, dd);
      if (fileDate < cutoff) {
        await fs.unlink(path.join(AUDIT_DIR, file));
      }
    }
  }
}

// Singleton
const auditLogger = new AuditLogger();

module.exports = { AuditLogger, auditLogger };
