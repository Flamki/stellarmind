/**
 * SSE Heartbeat & Stale-Client Cleanup Module
 * 
 * Adds periodic heartbeat events, safe broadcast with error handling,
 * and stale-client eviction to the SSE event stream.
 * 
 * Usage in server.js:
 *   import { setupHeartbeat, safeBroadcast, stopHeartbeat } from './sse-heartbeat.js'
 *   const { safeBroadcast } = setupHeartbeat(sseClients, broadcast, { intervalMs: 30000 })
 */

import { logger } from './logger.js'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30000
const DEFAULT_STALE_TIMEOUT_MS = 90000  // 3 heartbeat cycles
const DEFAULT_MAX_CLIENTS = 100

/**
 * Creates a safe broadcast wrapper that guards against write failures
 * and tracks per-client metadata for staleness detection.
 */
export function createClientTracker() {
  const clients = new Map()  // response -> { id, addedAt, lastWrite, writeErrors }

  function addClient(res) {
    if (clients.size >= DEFAULT_MAX_CLIENTS) {
      logger.warn('sse_max_clients_reached', { current: clients.size, max: DEFAULT_MAX_CLIENTS })
      return false
    }
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      addedAt: Date.now(),
      lastWrite: Date.now(),
      writeErrors: 0,
      res,
    }
    clients.set(res, entry)
    logger.debug('sse_client_added', { clientId: entry.id, total: clients.size })
    return true
  }

  function removeClient(res) {
    const entry = clients.get(res)
    if (entry) {
      logger.debug('sse_client_removed', { clientId: entry.id, total: clients.size - 1 })
      clients.delete(res)
    }
  }

  function markWrite(res) {
    const entry = clients.get(res)
    if (entry) {
      entry.lastWrite = Date.now()
      entry.writeErrors = 0
    }
  }

  function markError(res) {
    const entry = clients.get(res)
    if (entry) {
      entry.writeErrors += 1
      if (entry.writeErrors >= 3) {
        logger.warn('sse_client_write_error_limit', { clientId: entry.id, errors: entry.writeErrors })
        return true  // signal removal
      }
    }
    return false
  }

  function getStaleClients(staleTimeoutMs) {
    const now = Date.now()
    const stale = []
    for (const [res, entry] of clients) {
      if (now - entry.lastWrite > staleTimeoutMs) {
        stale.push({ res, entry })
      }
    }
    return stale
  }

  function size() {
    return clients.size
  }

  function getStats() {
    const now = Date.now()
    let oldestAge = 0
    let newestAge = Infinity
    for (const [, entry] of clients) {
      const age = now - entry.addedAt
      if (age > oldestAge) oldestAge = age
      if (age < newestAge) newestAge = age
    }
    return {
      total: clients.size,
      oldestConnectedMs: oldestAge || 0,
      newestConnectedMs: newestAge === Infinity ? 0 : newestAge,
    }
  }

  return { addClient, removeClient, markWrite, markError, getStaleClients, size, getStats }
}

/**
 * Safe broadcast: writes event to all clients with try/catch,
 * removing clients whose connections are broken.
 */
export function safeBroadcast(clients, clientTracker, event) {
  const data = JSON.stringify(event)
  const deadClients = []

  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`)
      if (clientTracker) clientTracker.markWrite(res)
    } catch (err) {
      // Connection broken - client will be evicted
      logger.debug('sse_write_failed', {
        error: err?.message?.substring(0, 80) || 'unknown',
        clientCount: clients.length,
      })
      const shouldRemove = clientTracker ? clientTracker.markError(res) : true
      if (shouldRemove) {
        deadClients.push(res)
      }
    }
  }

  // Remove dead clients from the array
  for (const dead of deadClients) {
    const idx = clients.indexOf(dead)
    if (idx !== -1) {
      clients.splice(idx, 1)
      if (clientTracker) clientTracker.removeClient(dead)
    }
  }
}

/**
 * Sets up the SSE heartbeat and stale-client cleanup.
 * 
 * @param {Array} sseClients - The array of SSE response objects
 * @param {Function} broadcastFn - The existing broadcast function (will be wrapped)
 * @param {Object} options - { intervalMs, staleTimeoutMs }
 * @returns {{ safeBroadcast: Function, stopHeartbeat: Function, getStats: Function }}
 */
export function setupHeartbeat(sseClients, broadcastFn, options = {}) {
  const intervalMs = options.intervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS
  const staleTimeoutMs = options.staleTimeoutMs || DEFAULT_STALE_TIMEOUT_MS
  const clientTracker = createClientTracker()

  // Wrap the existing sseClients.push to auto-track new clients
  const originalPush = sseClients.push.bind(sseClients)
  sseClients.push = function (res) {
    clientTracker.addClient(res)
    return originalPush(res)
  }

  // Wrap the existing cleanup on close to also remove from tracker
  // Note: server.js already has req.on('close', ...) but we also track

  // Periodic heartbeat + stale cleanup
  const intervalId = setInterval(() => {
    try {
      // 1. Send heartbeat
      const heartbeatEvent = {
        type: 'heartbeat',
        timestamp: new Date().toISOString(),
        clientCount: sseClients.length,
      }
      safeBroadcast(sseClients, clientTracker, heartbeatEvent)

      // 2. Evict stale clients
      const staleClients = clientTracker.getStaleClients(staleTimeoutMs)
      for (const { res, entry } of staleClients) {
        const idx = sseClients.indexOf(res)
        if (idx !== -1) {
          sseClients.splice(idx, 1)
          clientTracker.removeClient(res)
          logger.info('sse_client_evicted_stale', {
            clientId: entry.id,
            ageMs: Date.now() - entry.addedAt,
            lastWriteMs: Date.now() - entry.lastWrite,
          })
        }
      }

      if (staleClients.length > 0) {
        logger.info('sse_stale_cleanup', {
          evicted: staleClients.length,
          remaining: sseClients.length,
        })
      }
    } catch (err) {
      logger.warn('sse_heartbeat_error', { error: err?.message?.substring(0, 120) })
    }
  }, intervalMs)

  // Unref so it doesn't keep the process alive (for testing)
  if (intervalId.unref) {
    intervalId.unref()
  }

  logger.info('sse_heartbeat_started', {
    intervalMs,
    staleTimeoutMs,
    maxClients: DEFAULT_MAX_CLIENTS,
  })

  function stopHeartbeat() {
    clearInterval(intervalId)
    logger.info('sse_heartbeat_stopped')
  }

  function getStats() {
    return {
      ...clientTracker.getStats(),
      heartbeatIntervalMs: intervalMs,
      staleTimeoutMs,
    }
  }

  return {
    safeBroadcast: (event) => safeBroadcast(sseClients, clientTracker, event),
    stopHeartbeat,
    getStats,
  }
}
