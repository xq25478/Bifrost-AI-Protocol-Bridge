"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { normalizeThinking, normalizeThinkingEffort } = require("./thinking");

describe("normalizeThinkingEffort", () => {
  it("returns null for non-string", () => {
    assert.strictEqual(normalizeThinkingEffort(123), null);
    assert.strictEqual(normalizeThinkingEffort(null), null);
    assert.strictEqual(normalizeThinkingEffort(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(normalizeThinkingEffort("   "), null);
    assert.strictEqual(normalizeThinkingEffort(""), null);
  });

  it("returns valid efforts as-is", () => {
    assert.strictEqual(normalizeThinkingEffort("low"), "low");
    assert.strictEqual(normalizeThinkingEffort("medium"), "medium");
    assert.strictEqual(normalizeThinkingEffort("high"), "high");
    assert.strictEqual(normalizeThinkingEffort("xhigh"), "xhigh");
    assert.strictEqual(normalizeThinkingEffort("max"), "max");
  });

  it("defaults unknown effort to max", () => {
    assert.strictEqual(normalizeThinkingEffort("ultra"), "max");
    assert.strictEqual(normalizeThinkingEffort("fast"), "max");
  });
});

describe("normalizeThinking", () => {
  it("passes through non-object", () => {
    assert.strictEqual(normalizeThinking(null), null);
    assert.strictEqual(normalizeThinking("string"), "string");
  });

  it("deletes thinking when enabled is false", () => {
    const body = { thinking: { enabled: false } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking, undefined);
  });

  it("deletes thinking when type is disabled", () => {
    const body = { thinking: { type: "disabled" } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking, undefined);
  });

  it("converts enabled=true to adaptive type", () => {
    const body = { thinking: { enabled: true } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking.type, "adaptive");
    assert.strictEqual(body.thinking.enabled, undefined);
    assert.strictEqual(body.thinking.budget_tokens, undefined);
  });

  it("converts type=enabled to adaptive", () => {
    const body = { thinking: { type: "enabled" } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking.type, "adaptive");
  });

  it("converts budget_tokens to adaptive", () => {
    const body = { thinking: { budget_tokens: 1000 } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking.type, "adaptive");
  });

  it("sets default effort when output_config missing", () => {
    const body = { thinking: { enabled: true } };
    normalizeThinking(body);
    assert.strictEqual(body.output_config.effort, "max");
  });

  it("uses existing output_config effort when valid", () => {
    const body = { thinking: { enabled: true }, output_config: { effort: "high" } };
    normalizeThinking(body);
    assert.strictEqual(body.output_config.effort, "high");
  });

  it("removes extended_thinking when false", () => {
    const body = { extended_thinking: false, thinking: { type: "enabled" } };
    normalizeThinking(body);
    assert.strictEqual(body.extended_thinking, undefined);
    assert.strictEqual(body.thinking, undefined);
  });

  it("removes extended_thinking but keeps thinking when true", () => {
    const body = { extended_thinking: true };
    normalizeThinking(body);
    assert.strictEqual(body.extended_thinking, undefined);
  });
});