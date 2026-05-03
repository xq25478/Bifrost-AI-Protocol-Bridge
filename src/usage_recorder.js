"use strict";

const { incMetric } = require("./metrics");

let store = null;
try { store = require("./store"); } catch { store = null; }

const RID_RING_SIZE = 4096;
const recordedRids = new Set();
const recordedRidQueue = [];

function markRecorded(rid) {
  if (!rid) return false;
  if (recordedRids.has(rid)) return true;
  recordedRids.add(rid);
  recordedRidQueue.push(rid);
  if (recordedRidQueue.length > RID_RING_SIZE) {
    const evicted = recordedRidQueue.shift();
    recordedRids.delete(evicted);
  }
  return false;
}

/**
 * Normalize a vendor-specific usage object into a uniform shape.
 *
 * Anthropic shape:
 *   { input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }
 *
 * OpenAI shape:
 *   { prompt_tokens, completion_tokens, total_tokens?,
 *     prompt_tokens_details?: { cached_tokens } }
 *
 * The OpenAI `prompt_tokens` already INCLUDES cached tokens. We split them so
 * `input_tokens` represents non-cache prompt tokens and `cache_read_tokens`
 * represents the cached portion. This matches Anthropic's accounting where
 * `input_tokens` excludes cache reads.
 *
 * Returns:
 *   { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== "object") {
    return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  }

  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;

  if (typeof usage.input_tokens === "number") input = usage.input_tokens;
  if (typeof usage.output_tokens === "number") output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === "number") cacheRead = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === "number") cacheWrite = usage.cache_creation_input_tokens;
  // Normalized shape — allow normalizeUsage to be safely invoked on its own
  // output (e.g., acc objects built by stream handlers).
  if (typeof usage.cache_read_tokens === "number") cacheRead = usage.cache_read_tokens;
  if (typeof usage.cache_write_tokens === "number") cacheWrite = usage.cache_write_tokens;

  if (typeof usage.prompt_tokens === "number") {
    let cached = 0;
    if (usage.prompt_tokens_details && typeof usage.prompt_tokens_details.cached_tokens === "number") {
      cached = usage.prompt_tokens_details.cached_tokens;
    } else if (typeof usage.cached_tokens === "number") {
      cached = usage.cached_tokens;
    }
    input = Math.max(0, usage.prompt_tokens - cached);
    if (cached > cacheRead) cacheRead = cached;
  }
  if (typeof usage.completion_tokens === "number" && output === 0) {
    output = usage.completion_tokens;
  }

  return {
    input_tokens: Math.max(0, input | 0),
    output_tokens: Math.max(0, output | 0),
    cache_read_tokens: Math.max(0, cacheRead | 0),
    cache_write_tokens: Math.max(0, cacheWrite | 0),
  };
}

/**
 * Record a single completed request's usage. Called once per request from
 * ctx.end via the logger; idempotent per rid (size-bounded ring).
 */
function recordRequestUsage(entry) {
  if (!entry) return;
  const rid = entry.rid;
  if (markRecorded(rid)) return;

  const norm = normalizeUsage(entry.usage);

  if (norm.input_tokens) incMetric("input_tokens", norm.input_tokens);
  if (norm.output_tokens) incMetric("output_tokens", norm.output_tokens);
  if (norm.cache_read_tokens) incMetric("cache_read_tokens", norm.cache_read_tokens);
  if (norm.cache_write_tokens) incMetric("cache_write_tokens", norm.cache_write_tokens);

  if (store && typeof store.insertRequest === "function") {
    try {
      store.insertRequest({
        rid: rid || "",
        ts: typeof entry.ts === "number" ? entry.ts : Date.now(),
        model: entry.model || "",
        backend: entry.backend || "",
        endpoint: entry.endpoint || "",
        client_format: entry.client_format || "",
        stream: entry.stream ? 1 : 0,
        status: typeof entry.status === "number" ? entry.status : 0,
        duration_ms: typeof entry.duration_ms === "number" ? entry.duration_ms : 0,
        input_tokens: norm.input_tokens,
        output_tokens: norm.output_tokens,
        cache_read: norm.cache_read_tokens,
        cache_write: norm.cache_write_tokens,
        ttft_ms: typeof entry.ttft_ms === "number" ? entry.ttft_ms : 0,
        itl_avg_ms: typeof entry.itl_avg_ms === "number" ? entry.itl_avg_ms : 0,
        input_bytes: typeof entry.input_bytes === "number" ? entry.input_bytes : 0,
      });
    } catch {}
  }
}

function resetForTest() {
  recordedRids.clear();
  recordedRidQueue.length = 0;
}

module.exports = {
  normalizeUsage,
  recordRequestUsage,
  resetForTest,
};
