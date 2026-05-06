"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeThinking,
  normalizeThinkingEffort,
  budgetToEffort,
  effortToBudget,
  readThinking,
  resolveThinkingFormat,
  VALID_THINKING_FORMATS,
  EFFORT_DEFAULT_BUDGETS,
} = require("./thinking");

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

describe("budgetToEffort", () => {
  it("buckets by monotonic thresholds", () => {
    assert.strictEqual(budgetToEffort(1024), "low");
    assert.strictEqual(budgetToEffort(3072), "low");
    assert.strictEqual(budgetToEffort(3073), "medium");
    assert.strictEqual(budgetToEffort(8000), "medium");
    assert.strictEqual(budgetToEffort(10000), "medium");
    assert.strictEqual(budgetToEffort(10001), "high");
    assert.strictEqual(budgetToEffort(24000), "high");
    assert.strictEqual(budgetToEffort(24001), "xhigh");
    assert.strictEqual(budgetToEffort(48000), "xhigh");
    assert.strictEqual(budgetToEffort(48001), "max");
    assert.strictEqual(budgetToEffort(200000), "max");
  });

  it("defaults to max effort for invalid input", () => {
    assert.strictEqual(budgetToEffort(0), "max");
    assert.strictEqual(budgetToEffort(-1), "max");
    assert.strictEqual(budgetToEffort(Number.NaN), "max");
    assert.strictEqual(budgetToEffort(Number.POSITIVE_INFINITY), "max");
    assert.strictEqual(budgetToEffort("big"), "max");
  });
});

describe("effortToBudget", () => {
  it("maps each effort level to a default budget", () => {
    for (const k of Object.keys(EFFORT_DEFAULT_BUDGETS)) {
      assert.strictEqual(effortToBudget(k), EFFORT_DEFAULT_BUDGETS[k]);
    }
  });

  it("falls back to medium for unknown", () => {
    assert.strictEqual(effortToBudget("bogus"), EFFORT_DEFAULT_BUDGETS.medium);
  });
});

describe("resolveThinkingFormat", () => {
  it("honors explicit per-backend override", () => {
    assert.strictEqual(
      resolveThinkingFormat({ type: "anthropic", thinking_format: "bedrock-adaptive" }),
      "bedrock-adaptive"
    );
    assert.strictEqual(
      resolveThinkingFormat({ type: "openai", thinking_format: "reasoning_effort" }),
      "reasoning_effort"
    );
  });

  it("ignores invalid thinking_format and falls back to default", () => {
    assert.strictEqual(
      resolveThinkingFormat({ type: "anthropic", thinking_format: "bogus" }),
      "anthropic-standard"
    );
  });

  it("defaults by backend type when no override", () => {
    assert.strictEqual(resolveThinkingFormat({ type: "anthropic" }), "anthropic-standard");
    assert.strictEqual(resolveThinkingFormat({ type: "openai" }), "chat_template_kwargs");
  });

  it("falls back to bedrock-adaptive when no backend provided (legacy path)", () => {
    assert.strictEqual(resolveThinkingFormat(null), "bedrock-adaptive");
    assert.strictEqual(resolveThinkingFormat(undefined), "bedrock-adaptive");
  });
});

describe("readThinking", () => {
  it("returns null for non-object bodies or missing thinking", () => {
    assert.strictEqual(readThinking(null), null);
    assert.strictEqual(readThinking({}), null);
  });

  it("returns {disabled:true} for explicit off signals", () => {
    assert.deepStrictEqual(readThinking({ thinking: { enabled: false } }), { disabled: true });
    assert.deepStrictEqual(readThinking({ thinking: { type: "disabled" } }), { disabled: true });
    assert.deepStrictEqual(readThinking({ extended_thinking: false }), { disabled: true });
  });

  it("parses budget_tokens and derives effort from bucket", () => {
    const r = readThinking({ thinking: { type: "enabled", budget_tokens: 20000 } });
    assert.strictEqual(r.budget_tokens, 20000);
    assert.strictEqual(r.effort, "high");
  });

  it("uses output_config.effort when present and budget missing", () => {
    const r = readThinking({ thinking: { type: "enabled" }, output_config: { effort: "low" } });
    assert.strictEqual(r.effort, "low");
    assert.strictEqual(r.budget_tokens, EFFORT_DEFAULT_BUDGETS.low);
  });

  it("preserves both when both given — budget wins as-is, effort taken from output_config", () => {
    const r = readThinking({
      thinking: { type: "enabled", budget_tokens: 12000 },
      output_config: { effort: "max" },
    });
    assert.strictEqual(r.budget_tokens, 12000);
    assert.strictEqual(r.effort, "max");
  });
});

describe("normalizeThinking", () => {
  it("passes through non-object", () => {
    assert.strictEqual(normalizeThinking(null), null);
    assert.strictEqual(normalizeThinking("string"), "string");
  });

  it("deletes thinking when enabled is false (no backend)", () => {
    const body = { thinking: { enabled: false } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking, undefined);
  });

  it("deletes thinking when type is disabled (no backend)", () => {
    const body = { thinking: { type: "disabled" } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking, undefined);
  });

  it("legacy path (no backend) still emits bedrock-adaptive for enabled=true", () => {
    const body = { thinking: { enabled: true } };
    normalizeThinking(body);
    assert.strictEqual(body.thinking.type, "adaptive");
    assert.strictEqual(body.thinking.enabled, undefined);
    assert.strictEqual(body.thinking.budget_tokens, undefined);
    assert.strictEqual(body.output_config.effort, "max");
  });

  it("legacy path uses existing output_config.effort when valid", () => {
    const body = { thinking: { enabled: true }, output_config: { effort: "high" } };
    normalizeThinking(body);
    assert.strictEqual(body.output_config.effort, "high");
  });

  it("bedrock-adaptive backend: maps budget_tokens → effort bucket", () => {
    const backend = { type: "anthropic", thinking_format: "bedrock-adaptive" };
    const body = { thinking: { type: "enabled", budget_tokens: 20000 } };
    normalizeThinking(body, backend);
    assert.deepStrictEqual(body.thinking, { type: "adaptive" });
    assert.strictEqual(body.output_config.effort, "high");
  });

  it("anthropic-standard backend: keeps type:enabled + budget_tokens", () => {
    const backend = { type: "anthropic", thinking_format: "anthropic-standard" };
    const body = { thinking: { type: "enabled", budget_tokens: 4096 } };
    normalizeThinking(body, backend);
    assert.deepStrictEqual(body.thinking, { type: "enabled", budget_tokens: 4096 });
    assert.strictEqual(body.output_config, undefined);
  });

  it("chat_template_kwargs backend (openai default): keeps canonical thinking for downstream converter", () => {
    const backend = { type: "openai" };
    const body = { thinking: { type: "enabled", budget_tokens: 4096 } };
    normalizeThinking(body, backend);
    assert.deepStrictEqual(body.thinking, { type: "enabled", budget_tokens: 4096 });
  });

  it("chat_template_kwargs backend: disabled signal deletes thinking", () => {
    const backend = { type: "openai" };
    const body = { thinking: { type: "disabled" } };
    normalizeThinking(body, backend);
    assert.strictEqual(body.thinking, undefined);
  });

  it("none format deletes thinking and strips orphan output_config.effort", () => {
    const backend = { type: "openai", thinking_format: "none" };
    const body = { thinking: { type: "enabled", budget_tokens: 8000 }, output_config: { effort: "low" } };
    normalizeThinking(body, backend);
    assert.strictEqual(body.thinking, undefined);
    assert.strictEqual(body.output_config, undefined);
  });

  it("derives budget from output_config.effort when caller only passed effort", () => {
    const backend = { type: "anthropic", thinking_format: "anthropic-standard" };
    const body = { thinking: { enabled: true }, output_config: { effort: "medium" } };
    normalizeThinking(body, backend);
    assert.strictEqual(body.thinking.type, "enabled");
    assert.strictEqual(body.thinking.budget_tokens, EFFORT_DEFAULT_BUDGETS.medium);
  });

  it("removes extended_thinking when false", () => {
    const body = { extended_thinking: false, thinking: { type: "enabled" } };
    normalizeThinking(body);
    assert.strictEqual(body.extended_thinking, undefined);
    assert.strictEqual(body.thinking, undefined);
  });

  it("removes extended_thinking field even when true (interpreted once)", () => {
    const body = { extended_thinking: true };
    normalizeThinking(body);
    assert.strictEqual(body.extended_thinking, undefined);
  });
});

describe("VALID_THINKING_FORMATS", () => {
  it("contains the expected set", () => {
    const expected = ["anthropic-standard", "bedrock-adaptive", "chat_template_kwargs", "reasoning_effort", "none"];
    for (const v of expected) assert.ok(VALID_THINKING_FORMATS.has(v), `missing ${v}`);
  });
});
