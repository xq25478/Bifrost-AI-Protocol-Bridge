"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeUsage, recordRequestUsage, resetForTest } = (() => {
  const mod = require("./usage_recorder");
  mod.resetForTest();
  require("./metrics").resetForTest();
  return mod;
})();
const { incMetric, metricsSnapshot } = require("./metrics");

describe("usage_recorder - normalizeUsage", () => {
  it("returns zeros for null/undefined/non-object", () => {
    const r = normalizeUsage(null);
    assert.deepStrictEqual(r, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
    assert.deepStrictEqual(normalizeUsage(undefined), r);
    assert.deepStrictEqual(normalizeUsage("abc"), r);
  });

  it("returns zeros for empty object", () => {
    const r = normalizeUsage({});
    assert.deepStrictEqual(r, { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 });
  });

  it("handles Anthropic shape with cache", () => {
    const r = normalizeUsage({
      input_tokens: 100,
      output_tokens: 200,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 30
    });
    assert.strictEqual(r.input_tokens, 100);
    assert.strictEqual(r.output_tokens, 200);
    assert.strictEqual(r.cache_read_tokens, 50);
    assert.strictEqual(r.cache_write_tokens, 30);
  });

  it("handles Anthropic shape without cache", () => {
    const r = normalizeUsage({ input_tokens: 500, output_tokens: 350 });
    assert.strictEqual(r.input_tokens, 500);
    assert.strictEqual(r.output_tokens, 350);
    assert.strictEqual(r.cache_read_tokens, 0);
    assert.strictEqual(r.cache_write_tokens, 0);
  });

  it("handles OpenAI simple shape (no details)", () => {
    const r = normalizeUsage({ prompt_tokens: 300, completion_tokens: 150 });
    assert.strictEqual(r.input_tokens, 300);
    assert.strictEqual(r.output_tokens, 150);
    assert.strictEqual(r.cache_read_tokens, 0);
  });

  it("handles OpenAI shape with prompt_tokens_details.cached_tokens", () => {
    const r = normalizeUsage({
      prompt_tokens: 500,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 200 }
    });
    assert.strictEqual(r.input_tokens, 300);
    assert.strictEqual(r.output_tokens, 200);
    assert.strictEqual(r.cache_read_tokens, 200);
    assert.strictEqual(r.cache_write_tokens, 0);
  });

  it("handles OpenAI cached_tokens (top-level, non-standard fallback)", () => {
    const r = normalizeUsage({
      prompt_tokens: 400,
      completion_tokens: 100,
      cached_tokens: 150
    });
    assert.strictEqual(r.input_tokens, 250);
    assert.strictEqual(r.output_tokens, 100);
    assert.strictEqual(r.cache_read_tokens, 150);
  });

  it("does not produce negative input_tokens when cached > prompt", () => {
    const r = normalizeUsage({
      prompt_tokens: 10,
      prompt_tokens_details: { cached_tokens: 100 }
    });
    assert.strictEqual(r.input_tokens, 0);
    assert.strictEqual(r.cache_read_tokens, 100);
  });

  it("does not override output_tokens with completion_tokens when both present", () => {
    const r = normalizeUsage({ input_tokens: 100, output_tokens: 200, completion_tokens: 250 });
    assert.strictEqual(r.output_tokens, 200, "output_tokens should take priority over completion_tokens");
  });

  it("uses completion_tokens when no output_tokens present", () => {
    const r = normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    assert.strictEqual(r.output_tokens, 50);
  });

  it("produces integers via | 0", () => {
    const r = normalizeUsage({ input_tokens: 100.99, output_tokens: 50.1 });
    assert.strictEqual(r.input_tokens, 100);
    assert.strictEqual(r.output_tokens, 50);
  });
});

describe("usage_recorder - recordRequestUsage", () => {
  beforeEach(() => {
    resetForTest();
    require("./metrics").resetForTest();
  });

  it("is idempotent per rid", () => {
    recordRequestUsage({ rid: "req-1", usage: { input_tokens: 100 } });
    recordRequestUsage({ rid: "req-1", usage: { input_tokens: 200 } });
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.input, 100);
  });

  it("records input and output tokens", () => {
    recordRequestUsage({ rid: "req-2", usage: { input_tokens: 150, output_tokens: 80 } });
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.input, 150);
    assert.strictEqual(m.tokens.output, 80);
  });

  it("records cache_read / cache_write tokens", () => {
    recordRequestUsage({
      rid: "req-3",
      usage: { input_tokens: 100, output_tokens: 60, cache_read_input_tokens: 40, cache_creation_input_tokens: 15 }
    });
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.cache_read, 40);
    assert.strictEqual(m.tokens.cache_write, 15);
  });

  it("handles empty usage", () => {
    recordRequestUsage({ rid: "req-4", usage: {} });
    const m = metricsSnapshot();
    assert.strictEqual(m.tokens.input, 0);
    assert.strictEqual(m.tokens.output, 0);
  });

  it("handles null entry gracefully", () => {
    assert.doesNotThrow(() => recordRequestUsage(null));
  });
});

describe("usage_recorder - rid ring eviction", () => {
  beforeEach(() => {
    resetForTest();
    require("./metrics").resetForTest();
  });

  it("re-records a rid after eviction from ring", () => {
    for (let i = 0; i < 5000; i++) {
      recordRequestUsage({ rid: "r-" + i, usage: { input_tokens: 1 } });
    }
    recordRequestUsage({ rid: "r-0", usage: { input_tokens: 5 } });
    const m = metricsSnapshot();
    assert.ok(m.tokens.input >= 5001);
  });
});