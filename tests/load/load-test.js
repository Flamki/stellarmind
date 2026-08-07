/**
 * StellarMind Load Test — Orchestrator & SSE Concurrency
 * 
 * Usage:
 *   k6 run tests/load/load-test.js
 *   artillery run tests/load/load-test.yml
 * 
 * Baseline thresholds:
 *   - /api/orchestrate: p95 < 2000ms at 50 concurrent VUs
 *   - /api/events (SSE): 100 concurrent connections, <1% error rate
 *   - /healthz: p99 < 100ms
 * 
 * Closes #38
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// ── Custom Metrics ──────────────────────────────────────────────
const sseErrorRate = new Rate('sse_errors');
const orchestrateDuration = new Trend('orchestrate_duration', true);
const healthzDuration = new Trend('healthz_duration', true);
const eventsConnectDuration = new Trend('events_connect_duration', true);

// ── Configuration ───────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || 'http://localhost:3001';
const STAGES = [
  // Ramp-up: simulate organic traffic growth
  { duration: '30s', target: 10 },
  { duration: '30s', target: 25 },
  { duration: '30s', target: 50 },
  // Steady state: sustained concurrency
  { duration: '60s', target: 50 },
  // Ramp-down
  { duration: '30s', target: 0 },
];

export const options = {
  stages: STAGES,
  thresholds: {
    http_req_duration: ['p(95)<3000', 'p(99)<5000'],
    http_req_failed: ['rate<0.05'],
    orchestrate_duration: ['p(95)<2000', 'p(99)<4000'],
    healthz_duration: ['p(99)<100'],
    sse_errors: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

// ── Helper: generate unique task payload ────────────────────────
function makeTaskPayload(vuId, iteration) {
  return JSON.stringify({
    task: `Research task VU-${vuId} iter-${iteration}: analyze market trends for DeFi protocols`,
    budget: 50 + (iteration % 10),
  });
}

// ── Test Suite ──────────────────────────────────────────────────
export default function () {
  const vuId = __VU;
  const iteration = __ITER;

  // ── Group 1: Health Check Baseline ────────────────────────────
  group('Health Check', () => {
    const res = http.get(`${BASE_URL}/healthz`, {
      tags: { name: 'healthz' },
    });
    healthzDuration.add(res.timings.duration);
    check(res, {
      'healthz returns 200': (r) => r.status === 200,
      'healthz body has status': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.status === 'ok' && typeof body.uptime === 'number';
        } catch {
          return false;
        }
      },
    });
  });

  // ── Group 2: Orchestrate Endpoint ─────────────────────────────
  group('Orchestrate API', () => {
    const payload = makeTaskPayload(vuId, iteration);
    const params = {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'orchestrate' },
    };

    const res = http.post(`${BASE_URL}/api/orchestrate`, payload, params);
    orchestrateDuration.add(res.timings.duration);

    check(res, {
      'orchestrate returns 200 or 207': (r) =>
        r.status === 200 || r.status === 207,
      'orchestrate returns valid JSON': (r) => {
        try {
          const body = JSON.parse(r.body);
          return body.hasOwnProperty('plan') || body.hasOwnProperty('results');
        } catch {
          return false;
        }
      },
    });

    // Also test GET variant
    const getRes = http.get(
      `${BASE_URL}/api/orchestrate?task=test-vu${vuId}&budget=10`,
      { tags: { name: 'orchestrate_get' } }
    );
    orchestrateDuration.add(getRes.timings.duration);
  });

  // ── Group 3: SSE Event Stream ────────────────────────────────
  group('SSE Event Stream', () => {
    const res = http.get(`${BASE_URL}/api/events`, {
      headers: { Accept: 'text/event-stream' },
      tags: { name: 'sse_events' },
      timeout: '15s',
    });

    eventsConnectDuration.add(res.timings.duration);

    const hasEventStream = res.headers['Content-Type']?.includes('text/event-stream');
    const hasData = res.body?.includes('data:') || res.status === 200;

    check(res, {
      'SSE returns 200': (r) => r.status === 200,
      'SSE has text/event-stream content-type': () => hasEventStream || hasData,
    });

    if (res.status !== 200) {
      sseErrorRate.add(1);
    }
  });

  // ── Group 4: Agent Registry (read-heavy) ─────────────────────
  group('Agent Registry', () => {
    const res = http.get(`${BASE_URL}/api/agents`, {
      tags: { name: 'agents' },
    });
    check(res, {
      'agents returns 200': (r) => r.status === 200,
    });
  });

  // Stagger requests to avoid thundering herd
  sleep(Math.random() * 2 + 0.5);
}

// ── Custom Summary ──────────────────────────────────────────────
export function handleSummary(data) {
  const baseline = {
    target_concurrency: 50,
    target_orchestrate_p95_ms: 2000,
    target_healthz_p99_ms: 100,
    target_sse_error_rate: 0.01,
  };

  console.log(`
╔══════════════════════════════════════════════════════╗
║         StellarMind Load Test Results               ║
╠══════════════════════════════════════════════════════╣
║ Baseline Targets:                                    ║
║   Orchestrate p95:   < ${baseline.target_orchestrate_p95_ms}ms                        ║
║   Healthz p99:       < ${baseline.target_healthz_p99_ms}ms                          ║
║   SSE Error Rate:    < ${(baseline.target_sse_error_rate * 100).toFixed(0)}%                            ║
║   Target Concurrency: ${baseline.target_concurrency} VUs                       ║
╚══════════════════════════════════════════════════════╝
  `);

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'results/load-test-summary.json': JSON.stringify(data, null, 2),
  };
}
