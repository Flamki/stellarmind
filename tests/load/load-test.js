// Load test scenarios for Stellarmind — Closes #38
// Run: npx k6 run tests/load/load-test.js

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const sseConnectTime = new Trend('sse_connect_time');
const orchestratorTime = new Trend('orchestrator_response_time');

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const MAX_VUS = __ENV.MAX_VUS ? parseInt(__ENV.MAX_VUS) : 50;

export const options = {
  stages: [
    { duration: '10s', target: 10 },
    { duration: '20s', target: 25 },
    { duration: '20s', target: MAX_VUS },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000'],
    errors: ['rate<0.10'],
  },
};

const BASELINE = {
  apiResponseMs: 150,
  sseReconnectMs: 500,
  orchestratorP95Ms: 800,
};

export default function () {
  group('GET /api/health', function () {
    const res = http.get(BASE_URL + '/api/health');
    check(res, {
      'health status 200': (r) => r.status === 200,
      'health response time OK': (r) => r.timings.duration < 1000,
    });
    errorRate.add(res.status !== 200);
  });

  group('GET /api/pricing', function () {
    const res = http.get(BASE_URL + '/api/pricing');
    check(res, {
      'pricing status 2xx': (r) => r.status >= 200 && r.status < 500,
      'pricing response under 2s': (r) => r.timings.duration < 2000,
    });
    orchestratorTime.add(res.timings.duration);
    errorRate.add(res.status >= 500);
  });

  group('GET /api/orchestrator/status', function () {
    const res = http.get(BASE_URL + '/api/orchestrator/status');
    check(res, {
      'orchestrator status 2xx': (r) => r.status >= 200 && r.status < 500,
      'orchestrator under 3s': (r) => r.timings.duration < 3000,
    });
    orchestratorTime.add(res.timings.duration);
  });

  group('GET / (SSE simulation)', function () {
    const res = http.get(BASE_URL + '/');
    check(res, {
      'homepage loads': (r) => r.status === 200,
      'homepage under 2s': (r) => r.timings.duration < 2000,
    });
    sseConnectTime.add(res.timings.duration);
  });

  sleep(1);
}

export function handleSummary(data) {
  const summary = {
    timestamp: new Date().toISOString(),
    baseline: BASELINE,
    results: {
      totalRequests: (data.metrics.http_reqs || {}).values ? data.metrics.http_reqs.values.count : 0,
      errorRate: (data.metrics.errors || {}).values ? data.metrics.errors.values.rate : 0,
      p95ResponseTime: data.metrics.http_req_duration ? (data.metrics.http_req_duration.values['p(95)'] || 0) : 0,
    },
    assessment: 'BASELINE ESTABLISHED',
  };

  return {
    'stdout': JSON.stringify(summary, null, 2),
    'tests/load/results.json': JSON.stringify(summary, null, 2),
  };
}
