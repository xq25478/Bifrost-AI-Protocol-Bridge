"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { incMetric, recordLatency, metricsSnapshot, resetForTest } = require("./metrics");

describe("metrics - incMetric", () => {
  beforeEach(() => resetForTest());

  it("increments existing keys", () => {
    incMetric("requests_total", 1);
    incMetric("requests_total", 2);
    assert.strictEqual(metricsSnapshot().requests, 3);
  });

  it("increments status codes", () => {
    incMetric("status_2xx", 1);
    incMetric("status_4xx", 1);
    incMetric("status_5xx", 1);
    const m = metricsSnapshot();
    assert.strictEqual(m.status["2xx"], 1);
    assert.strictEqual(m.status["4xx"], 1);
    assert.strictEqual(m.status["5xx"], 1);
  });

  it("defaults increment to 1", () => {
    incMetric("upstream_errors");
    assert.strictEqual(metricsSnapshot().upstream_errors, 1);
  });
});

describe("metrics - recordLatency", () => {
  beforeEach(() => resetForTest());

  it("records latencies and computes percentiles", () => {
    for (let i = 1; i <= 100; i++) {
      recordLatency(i);
    }
    const m = metricsSnapshot();
    assert.ok(m.latency_p50 >= 49 && m.latency_p50 <= 51);
    assert.ok(m.latency_p95 >= 94 && m.latency_p95 <= 96);
    assert.ok(m.latency_p99 >= 98 && m.latency_p99 <= 100);
  });

  it("returns 0 for empty ring buffer", () => {
    const m = metricsSnapshot();
    assert.strictEqual(m.latency_p50, 0);
    assert.strictEqual(m.latency_p95, 0);
    assert.strictEqual(m.latency_p99, 0);
  });
});

describe("metrics - token counters via incMetric", () => {
  beforeEach(() => resetForTest());

  it("increments token fields individually", () => {
    incMetric("input_tokens", 150);
    incMetric("output_tokens", 80);
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.input, 150);
    assert.strictEqual(m.tokens.output, 80);
  });

  it("returns 0 for unset token fields", () => {
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.input, 0);
    assert.strictEqual(m.tokens.output, 0);
    assert.strictEqual(m.tokens.cache_read, 0);
    assert.strictEqual(m.tokens.cache_write, 0);
  });
});