"use strict";

const { DEFAULT_THINKING_EFFORT, SUPPORTED_THINKING_EFFORTS } = require("./config");

function normalizeThinkingEffort(value) {
  if (typeof value !== "string") return null;
  const n = value.trim().toLowerCase();
  if (!n) return null;
  return SUPPORTED_THINKING_EFFORTS.has(n) ? n : DEFAULT_THINKING_EFFORT;
}

/**
 * Normalize `thinking` configuration for compatibility.
 * Converts `thinking.enabled` to `thinking.type: "adaptive"` for AWS Bedrock,
 * and handles `extended_thinking` legacy field.
 * Mutates the body in place.
 */
function normalizeThinking(body) {
  if (!body || typeof body !== "object") return body;

  if (body.thinking && typeof body.thinking === "object") {
    if (body.thinking.enabled === false || body.thinking.type === "disabled") {
      delete body.thinking;
    } else if (
      body.thinking.type === "enabled" ||
      body.thinking.enabled === true ||
      body.thinking.budget_tokens !== undefined
    ) {
      body.thinking.type = "adaptive";
      delete body.thinking.enabled;
      delete body.thinking.budget_tokens;
      const effort = normalizeThinkingEffort(body.output_config?.effort);
      body.output_config = {
        ...(body.output_config || {}),
        effort: effort || DEFAULT_THINKING_EFFORT
      };
    }
  }

  if (body.extended_thinking !== undefined) {
    if (body.extended_thinking === false || body.extended_thinking === null) {
      delete body.thinking;
    }
    delete body.extended_thinking;
  }

  return body;
}

module.exports = { normalizeThinking, normalizeThinkingEffort };