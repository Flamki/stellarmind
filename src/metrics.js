/**
 * Operational metrics registry and Prometheus / JSON exporter (issue #181).
 *
 * Tracks:
 *  - Accepted and terminal orchestration runs (`stellarmind_runs_accepted_total`, `stellarmind_runs_terminal_total`)
 *  - Queued admissions (`stellarmind_orchestration_queued_total`)
 *  - Active and queued orchestration gauges (`stellarmind_orchestration_active_runs`, `stellarmind_orchestration_queued_runs`)
 *  - Phase latency histograms (`stellarmind_phase_duration_ms`)
 *  - Payment and settlement outcomes (`stellarmind_settlement_outcomes_total`)
 *  - Run-history persistence errors (`stellarmind_persistence_errors_total`)
 *
 * Cardinality invariant:
 *  Every label key and value is validated against a closed allowlist (`ALLOWED_LABEL_VALUES`).
 *  Prompts, run IDs, wallet addresses, and transaction hashes are never accepted as labels.
 */

export const DEFAULT_LATENCY_BUCKETS_MS = Object.freeze([
  5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000,
])

export const ALLOWED_LABEL_VALUES = Object.freeze({
  mode: {
    allowed: new Set(['live', 'demo']),
    fallback: 'live',
  },
  submission: {
    allowed: new Set(['sync', 'async', 'execute', 'preview']),
    fallback: 'sync',
  },
  status: {
    allowed: new Set(['completed', 'failed', 'cancelled', 'interrupted', 'rejected']),
    fallback: 'failed',
  },
  phase: {
    allowed: new Set(['queue_wait', 'planning', 'agent_step', 'settlement', 'total_run']),
    fallback: 'total_run',
  },
  method: {
    allowed: new Set(['x402', 'stellar_xlm', 'unpaid']),
    fallback: 'unpaid',
  },
  outcome: {
    allowed: new Set(['settled', 'failed', 'unresolved', 'skipped']),
    fallback: 'failed',
  },
  asset: {
    allowed: new Set(['USDC', 'XLM', 'none']),
    fallback: 'none',
  },
  operation: {
    allowed: new Set([
      'init',
      'read',
      'write',
      'create_run',
      'append_event',
      'record_payment',
      'complete_run',
      'fail_run',
      'reconcile',
    ]),
    fallback: 'write',
  },
})

export function sanitizeLabels(rawLabels = {}, allowedKeys = []) {
  const sanitized = {}
  for (const key of allowedKeys) {
    const spec = ALLOWED_LABEL_VALUES[key]
    if (!spec) continue
    const candidate = rawLabels?.[key] !== undefined ? String(rawLabels[key]).trim() : spec.fallback
    sanitized[key] = spec.allowed.has(candidate) ? candidate : spec.fallback
  }
  return sanitized
}

export function resolveActivityMode(options = {}) {
  const { activityMode, mode, demo, source, config } = options
  const explicit = String(activityMode || mode || '').toLowerCase()
  if (explicit === 'demo' || demo === true || demo === 'true' || source === 'demo') {
    return 'demo'
  }
  if (explicit === 'live' || demo === false || demo === 'false' || source === 'live') {
    return 'live'
  }
  if (typeof source === 'string' && source.toLowerCase().includes('demo')) {
    return 'demo'
  }
  if (config && typeof config === 'object') {
    const hasLiveCredentials = Boolean(
      config.anthropicApiKey || config.serverAddress || config.orchestratorSecret
    )
    return hasLiveCredentials ? 'live' : 'demo'
  }
  return 'live'
}

export function normalizeSettlementMethod(paidVia) {
  const v = String(paidVia || '').toLowerCase()
  if (v.includes('x402')) return 'x402'
  if (v.includes('xlm') || v.includes('stellar')) return 'stellar_xlm'
  return 'unpaid'
}

export function normalizeSettlementAsset(asset, method) {
  const normalized = String(asset || '').toUpperCase()
  if (normalized === 'USDC' || normalized === 'XLM') return normalized
  if (method === 'x402') return 'USDC'
  if (method === 'stellar_xlm') return 'XLM'
  return 'none'
}

function serializeLabelKey(labels, keys) {
  return keys.map((k) => `${k}=${labels[k]}`).join(',')
}

function formatPrometheusLabels(labels, extraLabels = {}) {
  const merged = { ...labels, ...extraLabels }
  const entries = Object.entries(merged)
  if (entries.length === 0) return ''
  const body = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')
  return `{${body}}`
}

export function createMetricsRegistry(options = {}) {
  const buckets = Array.isArray(options.buckets)
    ? [...options.buckets].sort((a, b) => a - b)
    : [...DEFAULT_LATENCY_BUCKETS_MS]

  let queueStateProvider =
    typeof options.getQueueState === 'function' ? options.getQueueState : null
  let manualActiveRuns = 0
  let manualQueuedRuns = 0
  let peakQueuedRuns = 0

  const acceptedRuns = new Map() // key -> { labels, value }
  const terminalRuns = new Map() // key -> { labels, value }
  const queuedAdmissions = new Map() // key -> { labels, value }
  const settlementOutcomes = new Map() // key -> { labels, value }
  const persistenceErrors = new Map() // key -> { labels, value }
  const phaseDurations = new Map() // key -> { labels, count, sum, bucketCounts: number[] }

  function incrementCounter(map, rawLabels, keys, delta = 1) {
    const labels = sanitizeLabels(rawLabels, keys)
    const key = serializeLabelKey(labels, keys)
    const existing = map.get(key)
    if (existing) {
      existing.value += delta
    } else {
      map.set(key, { labels, value: delta })
    }
  }

  function observeHistogram(map, rawLabels, keys, durationMs) {
    const numeric = Number(durationMs)
    const safeMs = Number.isFinite(numeric) && numeric >= 0 ? numeric : 0
    const labels = sanitizeLabels(rawLabels, keys)
    const key = serializeLabelKey(labels, keys)
    let entry = map.get(key)
    if (!entry) {
      entry = {
        labels,
        count: 0,
        sum: 0,
        bucketCounts: buckets.map(() => 0),
      }
      map.set(key, entry)
    }
    entry.count += 1
    entry.sum += safeMs
    for (let i = 0; i < buckets.length; i++) {
      if (safeMs <= buckets[i]) {
        entry.bucketCounts[i] += 1
      }
    }
  }

  function resolveGauges() {
    if (queueStateProvider) {
      const state = queueStateProvider() || {}
      const active = Number.isFinite(state.active) ? state.active : manualActiveRuns
      const queued = Number.isFinite(state.queued) ? state.queued : manualQueuedRuns
      if (queued > peakQueuedRuns) peakQueuedRuns = queued
      return {
        active,
        queued,
        peakQueued: peakQueuedRuns,
      }
    }
    return {
      active: manualActiveRuns,
      queued: manualQueuedRuns,
      peakQueued: peakQueuedRuns,
    }
  }

  return {
    setQueueStateProvider(fn) {
      queueStateProvider = typeof fn === 'function' ? fn : null
    },

    recordRunAccepted({ mode = 'live', submission = 'sync' } = {}) {
      incrementCounter(acceptedRuns, { mode, submission }, ['mode', 'submission'], 1)
    },

    recordRunTerminal({ status = 'completed', mode = 'live', durationMs } = {}) {
      incrementCounter(terminalRuns, { status, mode }, ['status', 'mode'], 1)
      if (durationMs !== undefined && durationMs !== null) {
        this.observePhaseDuration({ phase: 'total_run', mode, durationMs })
      }
    },

    recordRunQueued({ mode = 'live', queueLength } = {}) {
      incrementCounter(queuedAdmissions, { mode }, ['mode'], 1)
      if (Number.isFinite(queueLength) && queueLength > peakQueuedRuns) {
        peakQueuedRuns = queueLength
      }
    },

    setQueueDepth({ active, queued } = {}) {
      if (Number.isFinite(active)) manualActiveRuns = Math.max(0, active)
      if (Number.isFinite(queued)) {
        manualQueuedRuns = Math.max(0, queued)
        if (manualQueuedRuns > peakQueuedRuns) {
          peakQueuedRuns = manualQueuedRuns
        }
      }
    },

    observePhaseDuration({ phase = 'total_run', mode = 'live', durationMs = 0 } = {}) {
      observeHistogram(phaseDurations, { phase, mode }, ['phase', 'mode'], durationMs)
    },

    recordSettlementOutcome({
      method = 'unpaid',
      outcome = 'settled',
      asset = 'none',
      mode = 'live',
      durationMs,
    } = {}) {
      const normalizedMethod = normalizeSettlementMethod(method)
      const normalizedAsset = normalizeSettlementAsset(asset, normalizedMethod)
      incrementCounter(
        settlementOutcomes,
        {
          method: normalizedMethod,
          outcome,
          asset: normalizedAsset,
          mode,
        },
        ['method', 'outcome', 'asset', 'mode'],
        1
      )
      if (durationMs !== undefined && durationMs !== null) {
        this.observePhaseDuration({ phase: 'settlement', mode, durationMs })
      }
    },

    recordPersistenceError({ operation = 'write' } = {}) {
      incrementCounter(persistenceErrors, { operation }, ['operation'], 1)
    },

    getSnapshot() {
      const gauges = resolveGauges()
      return {
        gauges: {
          activeRuns: gauges.active,
          queuedRuns: gauges.queued,
          peakQueuedRuns: gauges.peakQueued,
        },
        counters: {
          runsAccepted: Array.from(acceptedRuns.values()).map((e) => ({
            labels: { ...e.labels },
            value: e.value,
          })),
          runsTerminal: Array.from(terminalRuns.values()).map((e) => ({
            labels: { ...e.labels },
            value: e.value,
          })),
          runsQueued: Array.from(queuedAdmissions.values()).map((e) => ({
            labels: { ...e.labels },
            value: e.value,
          })),
          settlementOutcomes: Array.from(settlementOutcomes.values()).map((e) => ({
            labels: { ...e.labels },
            value: e.value,
          })),
          persistenceErrors: Array.from(persistenceErrors.values()).map((e) => ({
            labels: { ...e.labels },
            value: e.value,
          })),
        },
        histograms: {
          phaseDurationMs: Array.from(phaseDurations.values()).map((entry) => {
            const bucketMap = {}
            for (let i = 0; i < buckets.length; i++) {
              bucketMap[String(buckets[i])] = entry.bucketCounts[i]
            }
            bucketMap['+Inf'] = entry.count
            return {
              labels: { ...entry.labels },
              count: entry.count,
              sum: Number(entry.sum.toFixed(3)),
              buckets: bucketMap,
            }
          }),
        },
      }
    },

    formatPrometheus() {
      const gauges = resolveGauges()
      const lines = []

      lines.push(
        '# HELP stellarmind_runs_accepted_total Total number of orchestration runs accepted for execution.'
      )
      lines.push('# TYPE stellarmind_runs_accepted_total counter')
      for (const entry of acceptedRuns.values()) {
        lines.push(
          `stellarmind_runs_accepted_total${formatPrometheusLabels(entry.labels)} ${entry.value}`
        )
      }

      lines.push(
        '# HELP stellarmind_runs_terminal_total Total number of orchestration runs reaching a terminal state.'
      )
      lines.push('# TYPE stellarmind_runs_terminal_total counter')
      for (const entry of terminalRuns.values()) {
        lines.push(
          `stellarmind_runs_terminal_total${formatPrometheusLabels(entry.labels)} ${entry.value}`
        )
      }

      lines.push(
        '# HELP stellarmind_orchestration_active_runs Current number of active in-flight orchestration runs.'
      )
      lines.push('# TYPE stellarmind_orchestration_active_runs gauge')
      lines.push(`stellarmind_orchestration_active_runs ${gauges.active}`)

      lines.push(
        '# HELP stellarmind_orchestration_queued_runs Current number of orchestration runs waiting in the admission queue.'
      )
      lines.push('# TYPE stellarmind_orchestration_queued_runs gauge')
      lines.push(`stellarmind_orchestration_queued_runs ${gauges.queued}`)

      lines.push(
        '# HELP stellarmind_orchestration_queue_peak_runs Peak number of orchestration runs observed waiting in the admission queue.'
      )
      lines.push('# TYPE stellarmind_orchestration_queue_peak_runs gauge')
      lines.push(`stellarmind_orchestration_queue_peak_runs ${gauges.peakQueued}`)

      lines.push(
        '# HELP stellarmind_orchestration_queued_total Total number of orchestration runs that waited in the admission queue.'
      )
      lines.push('# TYPE stellarmind_orchestration_queued_total counter')
      for (const entry of queuedAdmissions.values()) {
        lines.push(
          `stellarmind_orchestration_queued_total${formatPrometheusLabels(entry.labels)} ${entry.value}`
        )
      }

      lines.push(
        '# HELP stellarmind_phase_duration_ms Duration of orchestration phases in milliseconds.'
      )
      lines.push('# TYPE stellarmind_phase_duration_ms histogram')
      for (const entry of phaseDurations.values()) {
        for (let i = 0; i < buckets.length; i++) {
          lines.push(
            `stellarmind_phase_duration_ms_bucket${formatPrometheusLabels(entry.labels, { le: buckets[i] })} ${entry.bucketCounts[i]}`
          )
        }
        lines.push(
          `stellarmind_phase_duration_ms_bucket${formatPrometheusLabels(entry.labels, { le: '+Inf' })} ${entry.count}`
        )
        lines.push(
          `stellarmind_phase_duration_ms_sum${formatPrometheusLabels(entry.labels)} ${Number(entry.sum.toFixed(3))}`
        )
        lines.push(
          `stellarmind_phase_duration_ms_count${formatPrometheusLabels(entry.labels)} ${entry.count}`
        )
      }

      lines.push(
        '# HELP stellarmind_settlement_outcomes_total Total number of agent step payment and settlement outcomes.'
      )
      lines.push('# TYPE stellarmind_settlement_outcomes_total counter')
      for (const entry of settlementOutcomes.values()) {
        lines.push(
          `stellarmind_settlement_outcomes_total${formatPrometheusLabels(entry.labels)} ${entry.value}`
        )
      }

      lines.push(
        '# HELP stellarmind_persistence_errors_total Total number of run-history storage persistence errors.'
      )
      lines.push('# TYPE stellarmind_persistence_errors_total counter')
      for (const entry of persistenceErrors.values()) {
        lines.push(
          `stellarmind_persistence_errors_total${formatPrometheusLabels(entry.labels)} ${entry.value}`
        )
      }

      return `${lines.join('\n')}\n`
    },

    reset() {
      acceptedRuns.clear()
      terminalRuns.clear()
      queuedAdmissions.clear()
      settlementOutcomes.clear()
      persistenceErrors.clear()
      phaseDurations.clear()
      manualActiveRuns = 0
      manualQueuedRuns = 0
      peakQueuedRuns = 0
    },
  }
}

export const defaultMetrics = createMetricsRegistry()
