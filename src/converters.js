"use strict";

const crypto = require("crypto");
const { normalizeUsage } = require("./usage_recorder");

// ============================================================
// Anthropic -> OpenAI Request
// ============================================================

function anthropicBodyToOpenAIChat(body) {
  const messages = [];
  if (body.system && typeof body.system === "string") {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    messages.push({ role: "system", content: body.system.map(s => s.type === "text" ? s.text : JSON.stringify(s)).join("\n") });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      messages.push({ role: msg.role, content: "" });
      continue;
    }
    const toolResults = [];
    const rest = [];
    for (const c of msg.content) {
      if (c.type === "tool_result") {
        const tc = {
          role: "tool",
          tool_call_id: c.tool_use_id || "",
          content: typeof c.content === "string" ? c.content : JSON.stringify(c.content || "")
        };
        if (c.is_error) tc.content = "[ERROR] " + tc.content;
        messages.push(tc);
      } else {
        rest.push(c);
      }
    }
    if (rest.length > 0) {
      if (msg.role === "assistant") {
        const textParts = [];
        const toolParts = [];
        for (const c of rest) {
          if (c.type === "text") textParts.push(c.text);
          else if (c.type === "tool_use") {
            toolParts.push({
              type: "function",
              id: c.id,
              function: { name: c.name, arguments: JSON.stringify(c.input) }
            });
          }
        }
        const textContent = textParts.join("");
        const am = { role: "assistant", content: textContent || null };
        if (toolParts.length > 0) am.tool_calls = toolParts;
        messages.push(am);
      } else {
        const parts = [];
        for (const c of rest) {
          if (c.type === "text") parts.push(c.text);
          else if (c.type === "image") {
            if (c.source?.type === "base64") {
              parts.push({ type: "image_url", image_url: { url: "data:" + c.source.media_type + ";base64," + c.source.data } });
            } else if (c.source?.type === "url") {
              parts.push({ type: "image_url", image_url: { url: c.source.url } });
            }
          } else if (c.type === "tool_use") {
            parts.push({ type: "text", text: "[tool_use: " + (c.name || "") + " " + JSON.stringify(c.input || {}) + "]" });
          } else {
            parts.push(c.text || JSON.stringify(c));
          }
        }
        if (parts.length === 0) { messages.push({ role: msg.role, content: "" }); continue; }
        if (parts.every(p => typeof p === "string")) {
          messages.push({ role: msg.role, content: parts.join("") });
        } else {
          const contentArr = parts.map(p => typeof p === "string" ? { type: "text", text: p } : p);
          messages.push({ role: msg.role, content: contentArr });
        }
      }
    }
  }

  const req = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream === true
  };
  if (req.stream) req.stream_options = { include_usage: true };
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop_sequences) req.stop = Array.isArray(body.stop_sequences) ? body.stop_sequences : [body.stop_sequences];

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    req.tools = body.tools.map(t => ({
      type: "function",
      function: {
        name: t.name || "",
        description: t.description || "",
        parameters: t.input_schema || { type: "object", properties: {} }
      }
    }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc.type === "auto") req.tool_choice = "auto";
    else if (tc.type === "any") req.tool_choice = "required";
    else if (tc.type === "none") req.tool_choice = "none";
    else if (tc.type === "tool" && tc.name) {
      req.tool_choice = { type: "function", function: { name: tc.name } };
      if (tc.disable_parallel_tool_use) req.parallel_tool_calls = false;
    }
  }
  return req;
}

// ============================================================
// OpenAI -> Anthropic Response (non-streaming)
// ============================================================

function openaiChatResponseToAnthropic(openaiRes) {
  const choice = openaiRes.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  // OpenAI allows content=null when tool_calls present; keep at least empty text
  if (typeof msg.content === "string") content.push({ type: "text", text: msg.content });
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`,
        name: tc.function?.name || "",
        input
      });
    }
  }
  if (content.length === 0) content.push({ type: "text", text: "" });

  const fr = choice?.finish_reason;
  let stopReason = "end_turn";
  if (fr === "stop") stopReason = "end_turn";
  else if (fr === "length") stopReason = "max_tokens";
  else if (fr === "tool_calls") stopReason = "tool_use";
  else if (fr) stopReason = fr;

  const usage = usageToAnthropicShape(openaiRes.usage);

  return {
    id: openaiRes.id || "msg_" + crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: openaiRes.model || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  };
}

// ============================================================
// OpenAI -> Anthropic SSE stream translator
// ============================================================

function createOpenAIToAnthropicSSETranslator(msgId, model) {
  let started = false;
  let textOpen = false;
  let textIndex = -1;
  const toolBlocks = new Map();
  let nextIndex = 0;
  let usage = null;

  function startMessage() {
    if (started) return "";
    started = true;
    return `data: ${JSON.stringify({
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", model, content: [],
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })}\n\n`;
  }

  function openText() {
    if (textOpen) return "";
    textOpen = true;
    textIndex = nextIndex++;
    return `data: ${JSON.stringify({
      type: "content_block_start", index: textIndex,
      content_block: { type: "text", text: "" }
    })}\n\n`;
  }

  function getOrOpenTool(idx, id, name) {
    let tb = toolBlocks.get(idx);
    if (tb) return { tb, sse: "" };
    tb = { index: nextIndex++, id: id || `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`, name: name || "" };
    toolBlocks.set(idx, tb);
    const sse = `data: ${JSON.stringify({
      type: "content_block_start", index: tb.index,
      content_block: { type: "tool_use", id: tb.id, name: tb.name, input: {} }
    })}\n\n`;
    return { tb, sse };
  }

  function closeAll() {
    const parts = [];
    if (textOpen) {
      parts.push(`data: ${JSON.stringify({ type: "content_block_stop", index: textIndex })}\n\n`);
      textOpen = false;
    }
    for (const tb of toolBlocks.values()) {
      parts.push(`data: ${JSON.stringify({ type: "content_block_stop", index: tb.index })}\n\n`);
    }
    toolBlocks.clear();
    return parts.join("");
  }

  function mapStopReason(fr) {
    if (fr === "stop") return "end_turn";
    if (fr === "length") return "max_tokens";
    if (fr === "tool_calls") return "tool_use";
    return fr || "end_turn";
  }

  function closeText() {
    if (!textOpen) return "";
    textOpen = false;
    return `data: ${JSON.stringify({ type: "content_block_stop", index: textIndex })}\n\n`;
  }

  return {
    translate(chunk) {
      if (!chunk || !chunk.choices || !chunk.choices[0]) {
        if (chunk && chunk.usage) usage = chunk.usage;
        return "";
      }
      const choice = chunk.choices[0];
      const delta = choice.delta || {};
      const parts = [];

      if (!started) parts.push(startMessage());

      const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
      const hasText = typeof delta.content === "string" && delta.content.length > 0;

      // Close text block BEFORE opening tool blocks when both appear in same chunk
      if (hasToolCalls && textOpen) parts.push(closeText());

      if (hasText) {
        if (!textOpen) parts.push(openText());
        parts.push(`data: ${JSON.stringify({
          type: "content_block_delta", index: textIndex,
          delta: { type: "text_delta", text: delta.content }
        })}\n\n`);
      }

      if (hasToolCalls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const fn = tc.function || {};
          const { tb, sse } = getOrOpenTool(idx, tc.id, fn.name);
          if (sse) parts.push(sse);
          if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
            parts.push(`data: ${JSON.stringify({
              type: "content_block_delta", index: tb.index,
              delta: { type: "input_json_delta", partial_json: fn.arguments }
            })}\n\n`);
          }
        }
      }

      if (chunk.usage) usage = chunk.usage;

      if (choice.finish_reason) {
        parts.push(closeAll());
        const stop = mapStopReason(choice.finish_reason);
        parts.push(`data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: usageToAnthropicShape(usage)
        })}\n\n`);
        parts.push(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      }

      return parts.join("");
    },
    finalize() {
      if (!started) return "";
      const parts = [closeAll()];
      parts.push(`data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: usageToAnthropicShape(usage)
      })}\n\n`);
      parts.push(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return parts.join("");
    },
    getUsage() { return usage; }
  };
}

// ============================================================
// OpenAI -> Anthropic Request
// ============================================================

function openaiBodyToAnthropic(body) {
  const messages = [];
  let system = undefined;

  for (const msg of body.messages || []) {
    if (msg.role === "system") {
      system = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      continue;
    }
    if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
      }
      messages.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool") {
      const content = [{ type: "tool_result", tool_use_id: msg.tool_call_id || "", content: msg.content || "" }];
      messages.push({ role: "user", content });
      continue;
    }
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const content = msg.content.map(part => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image_url") {
          const url = part.image_url?.url || "";
          if (url.startsWith("data:")) {
            const m = url.match(/^data:([^;]+);base64,(.+)$/);
            if (m) return { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } };
          }
          return { type: "image", source: { type: "url", url } };
        }
        return { type: "text", text: JSON.stringify(part) };
      });
      messages.push({ role: msg.role, content });
    }
  }

  const req = { model: body.model, messages, max_tokens: body.max_tokens || 4096 };
  if (system !== undefined) req.system = system;
  if (body.stream !== undefined) req.stream = body.stream;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools) {
    req.tools = body.tools.map(t => ({
      name: t.function?.name || t.name || "",
      description: t.function?.description || t.description || "",
      input_schema: t.function?.parameters || t.parameters || { type: "object", properties: {} }
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice === "auto") req.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") req.tool_choice = { type: "any" };
    else if (body.tool_choice === "none") req.tool_choice = { type: "none" };
    else if (typeof body.tool_choice === "object") req.tool_choice = { type: "tool", name: body.tool_choice.function?.name || "" };
  }
  return req;
}

// ============================================================
// Anthropic -> OpenAI Response (non-streaming)
// ============================================================

function anthropicResponseToOpenAIChat(anthropicRes) {
  const content = anthropicRes.content || [];
  const textParts = content.filter(b => b.type === "text").map(b => b.text);
  const thinkingParts = content.filter(b => b.type === "thinking").map(b => b.thinking || b.text || "");
  const toolParts = content.filter(b => b.type === "tool_use");

  const allText = textParts.join("") + (thinkingParts.length > 0 ? "\n[Thinking]\n" + thinkingParts.join("\n") : "");

  const message = { role: "assistant", content: allText };
  if (toolParts.length > 0) {
    message.tool_calls = toolParts.map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: "function",
      function: { name: tc.name || "", arguments: JSON.stringify(tc.input || {}) }
    }));
  }

  const finishReason = (() => {
    if (toolParts.length > 0) return "tool_calls";
    const sr = anthropicRes.stop_reason;
    if (sr === "end_turn" || sr === "stop") return "stop";
    if (sr === "max_tokens") return "length";
    if (sr === "tool_use") return "tool_calls";
    return sr || "stop";
  })();

  const anthUsage = usageToAnthropicShape(anthropicRes.usage);
  const oaiUsage = anthropicUsageToOpenAIShape(anthUsage);

  return {
    id: anthropicRes.id || "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicRes.model || "",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason
    }],
    usage: oaiUsage
  };
}

// ============================================================
// Anthropic SSE -> OpenAI SSE stream translator (stateful)
// ============================================================

/**
 * Create a stateful translator from Anthropic SSE to OpenAI SSE.
 *
 * The translator accumulates `input_tokens` + cache fields from `message_start`
 * (Anthropic emits them there, while `message_delta` only carries cumulative
 * `output_tokens`) so that the final OpenAI chunk can report a full
 * `{prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details}`
 * shape sourced entirely from the upstream response body.
 */
function createAnthropicToOpenAISSETranslator(chatId, model) {
  const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

  function translate(line) {
    if (!line.startsWith("data: ")) return "";
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return "data: [DONE]\n\n";

    let evt;
    try { evt = JSON.parse(payload); } catch { return ""; }

    const now = Math.floor(Date.now() / 1000);

    if (evt.type === "message_start") {
      parseAnthropicSSEUsage(line, acc);
      const msg = evt.message || {};
      return `data: ${JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created: now, model: msg.model || model,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }]
      })}\n\n`;
    }

    if (evt.type === "content_block_start") {
      const block = evt.content_block || {};
      if (block.type === "tool_use") {
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: evt.index || 0, id: block.id, type: "function", function: { name: block.name || "", arguments: "" } }] }, finish_reason: null }]
        })}\n\n`;
      }
      return "";
    }

    if (evt.type === "content_block_delta") {
      const delta = evt.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }]
        })}\n\n`;
      }
      if (delta.type === "input_json_delta" && delta.partial_json) {
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: evt.index || 0, function: { arguments: delta.partial_json } }] }, finish_reason: null }]
        })}\n\n`;
      }
      return "";
    }

    if (evt.type === "message_delta") {
      parseAnthropicSSEUsage(line, acc);
      const d = evt.delta || {};

      let finishReason = null;
      if (d.stop_reason) {
        if (d.stop_reason === "end_turn" || d.stop_reason === "stop") finishReason = "stop";
        else if (d.stop_reason === "tool_use") finishReason = "tool_calls";
        else if (d.stop_reason === "max_tokens") finishReason = "length";
        else finishReason = d.stop_reason;
      }
      const anthUsage = {
        input_tokens: acc.input_tokens,
        output_tokens: acc.output_tokens,
      };
      if (acc.cache_read_tokens > 0) anthUsage.cache_read_input_tokens = acc.cache_read_tokens;
      if (acc.cache_write_tokens > 0) anthUsage.cache_creation_input_tokens = acc.cache_write_tokens;
      return `data: ${JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created: now, model,
        choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        usage: anthropicUsageToOpenAIShape(anthUsage)
      })}\n\n`;
    }

    if (evt.type === "message_stop") {
      return "data: [DONE]\n\n";
    }

    return "";
  }

  return { translate, getAcc() { return acc; } };
}

// ============================================================
// Token usage helpers
// ============================================================

/**
 * Shape `res.usage` (either Anthropic or OpenAI) into the Anthropic response
 * `usage` form that Anthropic clients expect. Driven by normalizeUsage so
 * OpenAI's `prompt_tokens_details.cached_tokens` is preserved as
 * `cache_read_input_tokens`.
 */
function usageToAnthropicShape(rawUsage) {
  const norm = normalizeUsage(rawUsage);
  const out = {
    input_tokens: norm.input_tokens,
    output_tokens: norm.output_tokens,
  };
  if (norm.cache_read_tokens > 0) out.cache_read_input_tokens = norm.cache_read_tokens;
  if (norm.cache_write_tokens > 0) out.cache_creation_input_tokens = norm.cache_write_tokens;
  return out;
}

/**
 * Convert a normalized/Anthropic-shape usage object into OpenAI's `usage`
 * shape. OpenAI's `prompt_tokens` INCLUDES cached tokens — so cached tokens
 * are additionally surfaced inside `prompt_tokens_details.cached_tokens`.
 * `cache_creation_input_tokens` is non-standard for OpenAI but emitted as an
 * extension field so no data is lost.
 */
function anthropicUsageToOpenAIShape(anthUsage) {
  const inputTokens = anthUsage.input_tokens || 0;
  const outputTokens = anthUsage.output_tokens || 0;
  const cacheRead = anthUsage.cache_read_input_tokens || 0;
  const cacheWrite = anthUsage.cache_creation_input_tokens || 0;
  const promptTokens = inputTokens + cacheRead;
  const out = {
    prompt_tokens: promptTokens,
    completion_tokens: outputTokens,
    total_tokens: promptTokens + outputTokens,
  };
  if (cacheRead > 0) out.prompt_tokens_details = { cached_tokens: cacheRead };
  if (cacheWrite > 0) out.cache_creation_input_tokens = cacheWrite;
  return out;
}

/**
 * Parse a single Anthropic SSE line and mutate an accumulator with token usage.
 *
 * Handles:
 *   - message_start: sets input_tokens, cache_read, cache_write from initial usage
 *   - message_delta: REPLACES output_tokens (cumulative, not delta) and updates cache fields when present
 *
 * The `acc` shape: { input_tokens, output_tokens, cache_read_tokens, cache_write_tokens }
 */
function parseAnthropicSSEUsage(line, acc) {
  if (!acc || !line || typeof line !== "string") return;
  if (!line.startsWith("data: ")) return;
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") return;

  let evt;
  try { evt = JSON.parse(payload); } catch { return; }

  if (evt.type === "message_start") {
    const u = evt.message?.usage || {};
    if (typeof u.input_tokens === "number") acc.input_tokens = u.input_tokens;
    if (typeof u.output_tokens === "number") acc.output_tokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number") acc.cache_read_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") acc.cache_write_tokens = u.cache_creation_input_tokens;
    // Capture model name from message_start (Anthropic streams include it here)
    if (evt.message?.model) acc.model = evt.message.model;
    return;
  }

  if (evt.type === "message_delta") {
    const u = evt.usage || {};
    // output_tokens in message_delta is CUMULATIVE — replace, not add
    if (typeof u.output_tokens === "number") acc.output_tokens = u.output_tokens;
    if (typeof u.input_tokens === "number") acc.input_tokens = u.input_tokens;
    if (typeof u.cache_read_input_tokens === "number") acc.cache_read_tokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number") acc.cache_write_tokens = u.cache_creation_input_tokens;
    return;
  }
}

module.exports = {
  anthropicBodyToOpenAIChat,
  openaiChatResponseToAnthropic,
  createOpenAIToAnthropicSSETranslator,
  openaiBodyToAnthropic,
  anthropicResponseToOpenAIChat,
  createAnthropicToOpenAISSETranslator,
  usageToAnthropicShape,
  anthropicUsageToOpenAIShape,
  parseAnthropicSSEUsage,
};