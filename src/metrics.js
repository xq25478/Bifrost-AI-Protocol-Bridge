"use strict";

const LATENCY_RING_SIZE = 1000;
const latencyRing = new Int32Array(LATENCY_RING_SIZE);
let latencyLen = 0;
let latencyWrite = 0;

const metrics = {
  requests_total: 0,
  status_2xx: 0, status_4xx: 0, status_5xx: 0,
  upstream_errors: 0,
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
};

function incMetric(key, n = 1) { metrics[key] += n; }

function recordLatency(ms) {
  latencyRing[latencyWrite] = ms;
  latencyWrite = (latencyWrite + 1) % LATENCY_RING_SIZE;
  if (latencyLen < LATENCY_RING_SIZE) latencyLen++;
}

function metricPercentile(p) {
  if (latencyLen === 0) return 0;
  const arr = latencyRing.slice(0, latencyLen);
  arr.sort((a, b) => a - b);
  return arr[Math.floor(latencyLen * p)] || 0;
}

function metricsSnapshot() {
  return {
    requests: metrics.requests_total,
    status: { "2xx": metrics.status_2xx, "4xx": metrics.status_4xx, "5xx": metrics.status_5xx },
    upstream_errors: metrics.upstream_errors,
    latency_p50: metricPercentile(0.5),
    latency_p95: metricPercentile(0.95),
    latency_p99: metricPercentile(0.99),
    tokens: {
      input: metrics.input_tokens,
      output: metrics.output_tokens,
      cache_read: metrics.cache_read_tokens,
      cache_write: metrics.cache_write_tokens,
    },
  };
}

module.exports = {
  incMetric,
  recordLatency,
  metricsSnapshot,
  _latencyRing: latencyRing,
  _latencyLen: latencyLen,
  resetForTest() {
    metrics.requests_total = 0;
    metrics.status_2xx = 0;
    metrics.status_4xx = 0;
    metrics.status_5xx = 0;
    metrics.upstream_errors = 0;
    metrics.input_tokens = 0;
    metrics.output_tokens = 0;
    metrics.cache_read_tokens = 0;
    metrics.cache_write_tokens = 0;
    latencyLen = 0;
    latencyWrite = 0;
  },
};