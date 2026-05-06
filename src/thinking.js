"use strict";

const { DEFAULT_THINKING_EFFORT, SUPPORTED_THINKING_EFFORTS } = require("./config");

const EFFORT_DEFAULT_BUDGETS = Object.freeze({
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 32768,
  max: 65536,
});

const VALID_THINKING_FORMATS = new Set([
  "anthropic-standard",
  "bedrock-adaptive",
  "chat_template_kwargs",
  "reasoning_effort",
  "none",
]);

function normalizeThinkingEffort(value) {
  if (typeof value !== "string") return null;
  const n = value.trim().toLowerCase();
  if (!n) return null;
  return SUPPORTED_THINKING_EFFORTS.has(n) ? n : DEFAULT_THINKING_EFFORT;
}

function budgetToEffort(budget) {
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget <= 0) {
    return DEFAULT_THINKING_EFFORT;
  }
  if (budget <= 3072) return "low";
  if (budget <= 10000) return "medium";
  if (budget <= 24000) return "high";
  if (budget <= 48000) return "xhigh";
  return "max";
}

function effortToBudget(effort) {
  return EFFORT_DEFAULT_BUDGETS[effort] || EFFORT_DEFAULT_BUDGETS.medium;
}

/**
 * Decide which wire format to use for a given backend.
 * Explicit per-backend `thinking_format` wins; otherwise pick a sensible
 * default based on backend.type.
 */
function resolveThinkingFormat(backend) {
  if (backend && typeof backend.thinking_format === "string") {
    const f = backend.thinking_format.trim();
    if (VALID_THINKING_FORMATS.has(f)) return f;
  }
  if (!backend) return "bedrock-adaptive";
  if (backend.type === "anthropic") return "anthropic-standard";
  if (backend.type === "openai") return "chat_template_kwargs";
  return "none";
}

/**
 * Read `body.thinking` + legacy aliases and return a canonical summary:
 *   - null                     → caller did not request thinking
 *   - { disabled: true }       → caller explicitly disabled thinking
 *   - { budget_tokens, effort} → thinking enabled with resolved budget + effort
 *
 * Accepts all of: `type:"enabled"`, `type:"adaptive"`, `enabled:true`, and
 * `budget_tokens` alone. If both budget and effort are present, budget wins
 * for the canonical budget field; effort is taken from `output_config.effort`
 * when present, otherwise derived from the budget bucket.
 */
function readThinking(body) {
  if (!body || typeof body !== "object") return null;
  const t = body.thinking;
  if (body.extended_thinking === false || body.extended_thinking === null) {
    return { disabled: true };
  }
  if (!t || typeof t !== "object") return null;
  if (t.enabled === false || t.type === "disabled") return { disabled: true };
  const enabled =
    t.type === "enabled" ||
    t.type === "adaptive" ||
    t.enabled === true ||
    typeof t.budget_tokens === "number";
  if (!enabled) return null;
  let budget = typeof t.budget_tokens === "number" ? t.budget_tokens : undefined;
  let effort = normalizeThinkingEffort(body.output_config?.effort);
  if (!effort && budget !== undefined) effort = budgetToEffort(budget);
  if (!effort) effort = DEFAULT_THINKING_EFFORT;
  if (budget === undefined) budget = effortToBudget(effort);
  return { budget_tokens: budget, effort };
}

/**
 * Rewrite `body` so that its thinking configuration matches the wire format
 * expected by `backend`. Mutates in place.
 *
 * Wire formats:
 *   - anthropic-standard: `thinking:{type:"enabled", budget_tokens:N}`, no output_config
 *   - bedrock-adaptive:   `thinking:{type:"adaptive"}` + `output_config:{effort:"..."}`
 *   - chat_template_kwargs / reasoning_effort: keep canonical
 *     `thinking:{type:"enabled", budget_tokens:N}` so the Chat-completions
 *     converter can read it and emit the backend-specific field.
 *   - none: delete thinking entirely (backend does not support it).
 *
 * Legacy `extended_thinking` is always stripped once interpreted.
 */
function normalizeThinking(body, backend) {
  if (!body || typeof body !== "object") return body;
  const t = readThinking(body);
  delete body.extended_thinking;

  if (!t) {
    // No thinking requested — also drop any lingering output_config.effort
    // we might have synthesized upstream, to avoid surprising a backend that
    // rejects the field when thinking is off.
    if (body.output_config && Object.keys(body.output_config).length === 1 && body.output_config.effort) {
      delete body.output_config;
    }
    return body;
  }

  if (t.disabled) {
    delete body.thinking;
    if (body.output_config && body.output_config.effort) {
      const keys = Object.keys(body.output_config);
      if (keys.length === 1) delete body.output_config;
      else delete body.output_config.effort;
    }
    return body;
  }

  const format = resolveThinkingFormat(backend);
  if (format === "bedrock-adaptive") {
    body.thinking = { type: "adaptive" };
    body.output_config = { ...(body.output_config || {}), effort: t.effort };
    return body;
  }
  if (format === "anthropic-standard") {
    body.thinking = { type: "enabled", budget_tokens: t.budget_tokens };
    if (body.output_config && body.output_config.effort) {
      const keys = Object.keys(body.output_config);
      if (keys.length === 1) delete body.output_config;
      else delete body.output_config.effort;
    }
    return body;
  }
  if (format === "chat_template_kwargs" || format === "reasoning_effort") {
    // Keep canonical {type:enabled, budget_tokens} so the OpenAI-side
    // converter can rewrite to the provider-specific field.
    body.thinking = { type: "enabled", budget_tokens: t.budget_tokens };
    return body;
  }
  // format === "none"
  delete body.thinking;
  if (body.output_config && body.output_config.effort) {
    const keys = Object.keys(body.output_config);
    if (keys.length === 1) delete body.output_config;
    else delete body.output_config.effort;
  }
  return body;
}

module.exports = {
  normalizeThinking,
  normalizeThinkingEffort,
  budgetToEffort,
  effortToBudget,
  readThinking,
  resolveThinkingFormat,
  VALID_THINKING_FORMATS,
  EFFORT_DEFAULT_BUDGETS,
};
