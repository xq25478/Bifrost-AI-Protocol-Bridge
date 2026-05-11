"use strict";

const { DEFAULT_MAX_TOKENS } = require("./config");

const crypto = require("crypto");
const { normalizeUsage } = require("./usage_recorder");
const { budgetToEffort, effortToBudget } = require("./thinking");

// ============================================================
// Anthropic -> OpenAI Request
// ============================================================

/**
 * Flatten an Anthropic `tool_result.content` value into Chat's `role:"tool"`
 * content shape. Anthropic accepts string | [{type:"text"}|{type:"image"}];
 * Chat traditionally accepts a plain string, but newer OpenAI SDKs tolerate
 * an array of content parts. Strategy: if every block is text, concatenate to
 * string (lossless + friendliest to old servers); else emit an array so the
 * image parts survive.
 */
function toolResultContentToChat(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  const parts = [];
  let onlyText = true;
  for (const b of raw) {
    if (b == null) continue;
    if (typeof b === "string") { parts.push({ type: "text", text: b }); continue; }
    if (b.type === "text" && typeof b.text === "string") { parts.push({ type: "text", text: b.text }); continue; }
    if (b.type === "image") {
      onlyText = false;
      const src = b.source || {};
      if (src.type === "base64" && src.data) {
        parts.push({ type: "image_url", image_url: { url: `data:${src.media_type || "image/png"};base64,${src.data}` } });
        continue;
      }
      if (src.type === "url" && src.url) {
        parts.push({ type: "image_url", image_url: { url: src.url } });
        continue;
      }
      parts.push({ type: "text", text: "[image omitted]" });
      continue;
    }
    try { parts.push({ type: "text", text: JSON.stringify(b) }); } catch {}
  }
  if (parts.length === 0) return "";
  if (onlyText) return parts.map(p => p.text).join("");
  return parts;
}

function anthropicBodyToOpenAIChat(body, backend) {
  const messages = [];
  if (body.system && typeof body.system === "string") {
    messages.push({ role: "system", content: body.system });
  } else if (Array.isArray(body.system)) {
    messages.push({ role: "system", content: body.system.map(s => s.type === "text" ? s.text : JSON.stringify(s)).join("\n") });
  }
  for (const msg of body.messages || []) {
    // Anthropic spec only emits role:"user" or role:"assistant" in messages[];
    // anything else (system/developer/tool, or accidental Responses leakage)
    // is unknown to a Chat-format backend. Downgrade to "user" rather than
    // forwarding a role the downstream may reject. The Anthropic-side
    // `system` field is handled separately above.
    const inRole = (msg.role === "assistant" || msg.role === "user") ? msg.role : "user";
    if (typeof msg.content === "string") {
      messages.push({ role: inRole, content: msg.content });
      continue;
    }
    if (!Array.isArray(msg.content)) {
      messages.push({ role: inRole, content: "" });
      continue;
    }
    // Walk the content array preserving block order. Anthropic allows
    // `tool_result` blocks to be interleaved with `text`/`image` blocks
    // inside a single user turn; the previous implementation pushed all
    // tool_results before all non-tool blocks, silently reordering the
    // conversation. We now flush a pending `rest` buffer into a user
    // message every time we hit a tool_result, so the resulting Chat
    // message order mirrors the original Anthropic block order.
    if (inRole === "assistant") {
      // assistant-side: filter out tool_result (illegal per Anthropic, but
      // tolerate) and fold the rest into the existing assistant builder.
      const rest = msg.content.filter(c => c && c.type !== "tool_result");
      if (rest.length > 0) {
        const textParts = [];
        const thinkingParts = [];
        const toolParts = [];
        for (const c of rest) {
          if (c.type === "text") textParts.push(c.text);
          // Preserve historical Anthropic `thinking` blocks as Chat
          // `reasoning_content`, which is the vLLM / SGLang / DeepSeek / GLM
          // reasoner convention and the same field our OpenAI->Anthropic
          // response converter emits. Lets multi-turn CoT survive both
          // directions of translation without vendor-specific plumbing.
          else if (c.type === "thinking") thinkingParts.push(c.thinking || c.text || "");
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
        const thinkingContent = thinkingParts.join("");
        if (thinkingContent) am.reasoning_content = thinkingContent;
        if (toolParts.length > 0) am.tool_calls = toolParts;
        messages.push(am);
      }
    } else {
      // user-side: walk in order. `tool_result` becomes a `role:tool`
      // message; buffered text/image blocks before each tool_result are
      // flushed as a `role:user` message first to preserve order.
      let userBuf = [];
      const flushUser = () => {
        if (userBuf.length === 0) return;
        if (userBuf.every(p => typeof p === "string")) {
          messages.push({ role: "user", content: userBuf.join("") });
        } else {
          const arr = userBuf.map(p => typeof p === "string" ? { type: "text", text: p } : p);
          messages.push({ role: "user", content: arr });
        }
        userBuf = [];
      };
      for (const c of msg.content) {
        if (!c || typeof c !== "object") continue;
        if (c.type === "tool_result") {
          flushUser();
          // Anthropic allows `tool_result.content` to be a string OR an
          // array of content blocks ({type:"text"} / {type:"image"}).
          // Collapse to a plain string when possible (Chat's conventional
          // shape); if it carries images, keep the structured array so
          // the image survives the hop.
          const flat = toolResultContentToChat(c.content);
          const tc = {
            role: "tool",
            tool_call_id: c.tool_use_id || "",
            content: flat,
          };
          if (c.is_error) {
            if (typeof tc.content === "string") tc.content = "[ERROR] " + tc.content;
            else tc.content = [{ type: "text", text: "[ERROR]" }, ...(Array.isArray(tc.content) ? tc.content : [])];
          }
          messages.push(tc);
          continue;
        }
        if (c.type === "text") { userBuf.push(c.text); continue; }
        if (c.type === "image") {
          if (c.source?.type === "base64") {
            userBuf.push({ type: "image_url", image_url: { url: "data:" + c.source.media_type + ";base64," + c.source.data } });
          } else if (c.source?.type === "url") {
            userBuf.push({ type: "image_url", image_url: { url: c.source.url } });
          }
          continue;
        }
        if (c.type === "tool_use") {
          userBuf.push({ type: "text", text: "[tool_use: " + (c.name || "") + " " + JSON.stringify(c.input || {}) + "]" });
          continue;
        }
        userBuf.push(c.text || JSON.stringify(c));
      }
      flushUser();
    }
  }

  const req = {
    model: body.model,
    messages,
    max_tokens: (typeof body.max_tokens === "number" && body.max_tokens > 0) ? body.max_tokens : DEFAULT_MAX_TOKENS,
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
    }
    // `type:"tool"` without a `name` is malformed Anthropic input. Rather
    // than silently dropping the constraint (which would let the model pick
    // any tool or none), preserve the caller's intent of "must use a tool"
    // by mapping to Chat `required`.
    else if (tc.type === "tool") req.tool_choice = "required";
    // Anthropic's `disable_parallel_tool_use` is valid on auto/any/tool; map
    // it to Chat's `parallel_tool_calls:false` regardless of which choice
    // mode was picked so the constraint survives the hop.
    if (tc.disable_parallel_tool_use === true) req.parallel_tool_calls = false;
  }

  applyThinkingToOpenAIRequest(req, body, backend);

  return req;
}

/**
 * Inject the backend-specific thinking parameter into an OpenAI Chat request.
 *
 * Upstream OpenAI-compatible reasoner deployments disagree on wire format:
 *   - vLLM / SGLang serving DeepSeek / Qwen / GLM: `chat_template_kwargs:
 *     {enable_thinking, thinking_budget}` — and responses carry
 *     `reasoning_content` alongside `content`.
 *   - OpenAI o-series (and Azure): `reasoning_effort: "low"|"medium"|"high"`.
 *
 * `backend.thinking_format` selects which field to emit. Missing config
 * defaults to `chat_template_kwargs` — the dominant shape across the
 * open-source reasoner ecosystem we proxy to.
 *
 * When the caller disabled thinking (body.thinking === undefined after
 * normalizeThinking stripped it, or explicit `{type:"disabled"}`), we do
 * NOT touch the request, so providers that default reasoning ON (e.g.
 * GLM-5.1) keep their behavior unless the caller actively opts in/out.
 */
function applyThinkingToOpenAIRequest(req, body, backend) {
  const t = body && body.thinking;
  if (!t || typeof t !== "object") return;
  const format = (backend && backend.thinking_format) || "chat_template_kwargs";
  const budget = typeof t.budget_tokens === "number" ? t.budget_tokens : undefined;
  const enabled = t.type === "enabled" || t.type === "adaptive" || t.enabled === true || budget !== undefined;
  if (!enabled) return;
  if (format === "chat_template_kwargs") {
    const kwargs = { ...(req.chat_template_kwargs || {}), enable_thinking: true };
    if (budget !== undefined) kwargs.thinking_budget = budget;
    req.chat_template_kwargs = kwargs;
    return;
  }
  if (format === "reasoning_effort") {
    req.reasoning_effort = budget !== undefined ? budgetToEffort(budget) : "medium";
    return;
  }
}

// ============================================================
// OpenAI -> Anthropic Response (non-streaming)
// ============================================================

function openaiChatResponseToAnthropic(openaiRes) {
  const choice = openaiRes.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  // DeepSeek / GLM / Qwen reasoner deployments expose chain-of-thought in
  // `message.reasoning_content`. Surface it as an Anthropic thinking block so
  // Claude-format clients (e.g. Claude Code) can render the thinking UI.
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    content.push({ type: "thinking", thinking: msg.reasoning_content });
  }
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
  if (content.length === 0) content.push({ type: "text", text: "(empty)" });

  // Map OpenAI Chat finish_reason → Anthropic stop_reason using only values
  // Anthropic's Messages API documents: end_turn | max_tokens | stop_sequence
  // | tool_use | pause_turn | refusal. Any non-recognized value falls back to
  // `end_turn` rather than being passed through as an undefined enum that
  // would break a strict Anthropic client.
  const fr = choice?.finish_reason;
  let stopReason = "end_turn";
  if (fr === "stop") stopReason = "end_turn";
  else if (fr === "length") stopReason = "max_tokens";
  else if (fr === "tool_calls" || fr === "function_call") stopReason = "tool_use";
  else if (fr === "content_filter") stopReason = "refusal";

  const usage = usageToAnthropicShape(openaiRes.usage);

  return {
    // Match the compact Anthropic id shape (no dashes, ~24 chars) the rest
    // of this module already uses for tool / chat ids — purely for log /
    // replay readability; the value is opaque to clients.
    id: openaiRes.id || "msg_" + crypto.randomUUID().replace(/-/g, "").slice(0, 24),
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
  let stopEmitted = false;
  let thinkingOpen = false;
  let thinkingIndex = -1;
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

  function openThinking() {
    if (thinkingOpen) return "";
    thinkingOpen = true;
    thinkingIndex = nextIndex++;
    return `data: ${JSON.stringify({
      type: "content_block_start", index: thinkingIndex,
      content_block: { type: "thinking", thinking: "" }
    })}\n\n`;
  }

  function closeThinking() {
    if (!thinkingOpen) return "";
    thinkingOpen = false;
    return `data: ${JSON.stringify({ type: "content_block_stop", index: thinkingIndex })}\n\n`;
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
    if (thinkingOpen) {
      parts.push(`data: ${JSON.stringify({ type: "content_block_stop", index: thinkingIndex })}\n\n`);
      thinkingOpen = false;
    }
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
    if (fr === "tool_calls" || fr === "function_call") return "tool_use";
    if (fr === "content_filter") return "refusal";
    return "end_turn";
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
      const hasReasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;

      // Reasoning streams before content; thinking block must close before
      // any text or tool_use block opens in the same chunk.
      if (hasReasoning) {
        if (!thinkingOpen) parts.push(openThinking());
        parts.push(`data: ${JSON.stringify({
          type: "content_block_delta", index: thinkingIndex,
          delta: { type: "thinking_delta", thinking: delta.reasoning_content }
        })}\n\n`);
      }
      if ((hasText || hasToolCalls) && thinkingOpen) parts.push(closeThinking());

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

      if (choice.finish_reason && !stopEmitted) {
        parts.push(closeAll());
        const stop = mapStopReason(choice.finish_reason);
        parts.push(`data: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: stop, stop_sequence: null },
          usage: usageToAnthropicShape(usage)
        })}\n\n`);
        parts.push(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
        stopEmitted = true;
      }

      return parts.join("");
    },
    finalize() {
      if (!started || stopEmitted) return "";
      const parts = [closeAll()];
      parts.push(`data: ${JSON.stringify({
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: usageToAnthropicShape(usage)
      })}\n\n`);
      parts.push(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      stopEmitted = true;
      return parts.join("");
    },
    getUsage() { return usage; }
  };
}

// ============================================================
// OpenAI -> Anthropic Request
// ============================================================

/**
 * Anthropic's Messages API (and Bedrock's pass-through validation) requires
 * every tool's `input_schema` to be a JSON Schema object with `type: "object"`
 * and a `properties` map. Clients built for OpenAI frequently send `{}` or a
 * schema missing `type`, which Bedrock rejects with a 400
 * (`input_schema.type: Field required`). Normalize here so any Chat-shaped
 * tool list survives the conversion.
 */
function normalizeToolInputSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const out = { ...schema };
  if (out.type !== "object") out.type = "object";
  if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) {
    out.properties = {};
  }
  return out;
}

/**
 * Anthropic's Messages API only accepts `user` or `assistant` on
 * `messages[].role`. Any other Chat-side role that survived the system /
 * tool_calls / tool branches above (e.g. an unknown `developer` left over
 * from a bad conversion, or `function`) must be coerced before send, or
 * Bedrock will reject the whole batch.
 */
function toAnthropicRole(role) {
  return role === "assistant" ? "assistant" : "user";
}

/**
 * Pull readable text out of a Chat `content` value, regardless of whether it
 * came in as a plain string, an array of Chat content parts (`{type:"text"}`
 * / `{type:"image_url"}` / ...), or something stranger. Used when flattening a
 * system / developer message into Anthropic's top-level `system` string.
 */
function extractMessageText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content); } catch { return String(content); }
  }
  const out = [];
  for (const p of content) {
    if (!p) continue;
    if (typeof p === "string") { out.push(p); continue; }
    if (typeof p.text === "string") { out.push(p.text); continue; }
    if (p.type === "image_url") { out.push("[image omitted]"); continue; }
    try { out.push(JSON.stringify(p)); } catch {}
  }
  return out.join("");
}

/**
 * Flatten an OpenAI Chat `role:"tool"` content value into a shape suitable for
 * Anthropic's `tool_result.content`. Anthropic accepts either a string or an
 * array of `{type:"text",text}` / `{type:"image",source}` blocks. Chat's tool
 * content is usually a string, but some callers send arrays of parts; preserve
 * them in structured form rather than JSON.stringify'ing the whole payload.
 */
function toolContentForAnthropic(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  const parts = [];
  for (const p of raw) {
    if (p == null) continue;
    if (typeof p === "string") { parts.push({ type: "text", text: p }); continue; }
    if (typeof p !== "object") continue;
    if (p.type === "text" && typeof p.text === "string") { parts.push({ type: "text", text: p.text }); continue; }
    if (p.type === "image_url") {
      const url = p.image_url?.url || "";
      if (url.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) { parts.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }); continue; }
      }
      if (url) { parts.push({ type: "image", source: { type: "url", url } }); continue; }
    }
    if (typeof p.text === "string") { parts.push({ type: "text", text: p.text }); continue; }
    try { parts.push({ type: "text", text: JSON.stringify(p) }); } catch {}
  }
  if (parts.length === 0) return "";
  return parts;
}

/**
 * Translate a Chat-shape content value (string | array-of-parts) into the
 * Anthropic-shape content blocks expected on a user/assistant message that
 * does not carry tool_calls. The caller handles tool_use / tool_result
 * plumbing outside this helper.
 */
function chatContentToAnthropicBlocks(raw) {
  if (raw == null) return [];
  if (typeof raw === "string") {
    return raw === "" ? [] : [{ type: "text", text: raw }];
  }
  if (!Array.isArray(raw)) {
    const t = extractMessageText(raw);
    return t ? [{ type: "text", text: t }] : [];
  }
  const out = [];
  for (const part of raw) {
    if (part == null) continue;
    if (typeof part === "string") { if (part) out.push({ type: "text", text: part }); continue; }
    if (part.type === "text") { if (part.text) out.push({ type: "text", text: part.text }); continue; }
    if (part.type === "image_url") {
      const url = part.image_url?.url || "";
      if (url.startsWith("data:")) {
        const m = url.match(/^data:([^;]+);base64,(.+)$/);
        if (m) { out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }); continue; }
      }
      if (url) out.push({ type: "image", source: { type: "url", url } });
      continue;
    }
    // Unknown part → dump as text JSON so it is at least visible.
    try { out.push({ type: "text", text: JSON.stringify(part) }); } catch {}
  }
  return out;
}

function openaiBodyToAnthropic(body) {
  const messages = [];
  // Anthropic accepts a single top-level `system` string; when the upstream
  // Chat body carries multiple system messages (e.g. Responses `instructions`
  // + a `developer` role message), concatenate rather than overwrite so no
  // directive is silently dropped.
  const systemParts = [];
  const inputMessages = Array.isArray(body.messages) ? body.messages : [];

  let i = 0;
  while (i < inputMessages.length) {
    const msg = inputMessages[i];
    if (!msg || typeof msg !== "object") { i += 1; continue; }

    if (msg.role === "system" || msg.role === "developer") {
      const txt = extractMessageText(msg.content);
      if (txt) systemParts.push(txt);
      i += 1; continue;
    }

    if (msg.role === "assistant") {
      const content = [];
      // reasoning_content (e.g. DeepSeek / GLM / Qwen reasoner output, or
      // passthrough from a previous Anthropic turn) becomes an Anthropic
      // thinking block so multi-turn CoT survives the round-trip.
      if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
        content.push({ type: "thinking", thinking: msg.reasoning_content });
      }
      // Text content may arrive either as a string (common) or as an array of
      // Chat parts (legal per OpenAI, historically seen). Flatten correctly;
      // a plain string shortcut avoids the overhead when it is already one.
      if (typeof msg.content === "string" && msg.content.length > 0) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const b of chatContentToAnthropicBlocks(msg.content)) content.push(b);
      }
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
          content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || "", input });
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(empty)" });
      messages.push({ role: "assistant", content });
      i += 1; continue;
    }

    if (msg.role === "tool") {
      // Anthropic requires all tool_results produced in response to the SAME
      // preceding assistant turn to live in a SINGLE user message. Coalesce
      // a contiguous run of OpenAI tool messages here.
      const block = [];
      while (i < inputMessages.length && inputMessages[i] && inputMessages[i].role === "tool") {
        const tm = inputMessages[i];
        const flat = toolContentForAnthropic(tm.content);
        block.push({ type: "tool_result", tool_use_id: tm.tool_call_id || "", content: flat });
        i += 1;
      }
      messages.push({ role: "user", content: block });
      continue;
    }

    // Regular user / (assistant that somehow reached here with no tool_calls).
    if (typeof msg.content === "string") {
      messages.push({ role: toAnthropicRole(msg.role), content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const content = chatContentToAnthropicBlocks(msg.content);
      messages.push({ role: toAnthropicRole(msg.role), content });
    } else {
      const t = extractMessageText(msg.content);
      if (t) messages.push({ role: toAnthropicRole(msg.role), content: t });
    }
    i += 1;
  }

  const req = { model: body.model, messages, max_tokens: (typeof body.max_tokens === "number" && body.max_tokens > 0) ? body.max_tokens : DEFAULT_MAX_TOKENS };
  if (systemParts.length > 0) req.system = systemParts.join("\n\n");
  if (body.stream !== undefined) req.stream = body.stream;
  if (body.temperature !== undefined) req.temperature = body.temperature;
  if (body.top_p !== undefined) req.top_p = body.top_p;
  if (body.stop) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.tools) {
    req.tools = body.tools.map(t => ({
      name: t.function?.name || t.name || "",
      description: t.function?.description || t.description || "",
      input_schema: normalizeToolInputSchema(t.function?.parameters ?? t.parameters)
    }));
  }
  if (body.tool_choice) {
    if (body.tool_choice === "auto") req.tool_choice = { type: "auto" };
    else if (body.tool_choice === "required") req.tool_choice = { type: "any" };
    else if (body.tool_choice === "none") {
      // Anthropic Messages API does not accept tool_choice:{type:"none"} —
      // the closest semantic is "don't let the model call tools", which we
      // express by stripping the tools array entirely. tool_choice is left
      // unset so Anthropic defaults to auto with no tools available.
      delete req.tools;
    }
    else if (typeof body.tool_choice === "object") {
      const fnName = body.tool_choice.function?.name;
      if (fnName) {
        req.tool_choice = { type: "tool", name: fnName };
      } else {
        // Object-form `{type:"function"}` without a `function.name` would
        // translate to Anthropic `{type:"tool", name:""}`, which Anthropic
        // rejects with a 400. Preserve the caller's "must call a tool"
        // intent by downgrading to `any`.
        req.tool_choice = { type: "any" };
      }
    }
  }
  // Chat's `parallel_tool_calls:false` ⇒ Anthropic's tool_choice.disable_parallel_tool_use.
  // Only valid on Anthropic when tool_choice is set (auto/any/tool); if the
  // caller passed `tool_choice:"none"` we already stripped the tools array
  // so no further flag is meaningful.
  if (body.parallel_tool_calls === false && req.tool_choice && req.tool_choice.type !== undefined) {
    req.tool_choice.disable_parallel_tool_use = true;
  }

  // Map Chat-side reasoning hints back to Anthropic `thinking`. Two shapes are
  // recognized so Responses→Chat→Anthropic and Chat→Anthropic both preserve
  // reasoning intent without any extra wire field:
  //   - OpenAI o-series: `reasoning_effort: "low"|"medium"|"high"|"xhigh"|"max"`
  //   - vLLM / SGLang / DeepSeek / GLM: `chat_template_kwargs.enable_thinking`
  //     with optional `thinking_budget`.
  // We do NOT synthesize thinking when neither hint is present (don't enable
  // reasoning for callers who didn't ask for it).
  const kwargs = (body && typeof body === "object" && body.chat_template_kwargs && typeof body.chat_template_kwargs === "object") ? body.chat_template_kwargs : null;
  const kwargsEnabled = !!(kwargs && kwargs.enable_thinking);
  const kwargsBudget = kwargs && typeof kwargs.thinking_budget === "number" ? kwargs.thinking_budget : undefined;
  if (typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0) {
    req.thinking = { type: "enabled", budget_tokens: effortToBudget(body.reasoning_effort) };
  } else if (kwargsEnabled) {
    req.thinking = { type: "enabled" };
    if (kwargsBudget !== undefined) req.thinking.budget_tokens = kwargsBudget;
    else req.thinking.budget_tokens = effortToBudget("medium");
  }

  // Anthropic enforces `thinking.budget_tokens >= 1024` AND
  // `max_tokens > thinking.budget_tokens`. When the caller's max_tokens is
  // small (or unset → defaulted to 4096 above) and we just injected a budget
  // that violates either rule, clamp before the request leaves the gateway —
  // otherwise Anthropic / Bedrock returns 400
  // "max_tokens must be greater than thinking.budget_tokens".
  //
  // Strategy:
  //   - If budget < 1024, raise to 1024.
  //   - If budget >= max_tokens, lower to max_tokens - 256 (reserves room for
  //     the answer). If that drop would push budget below 1024, drop the
  //     `thinking` block entirely — Anthropic doesn't accept `type:"enabled"`
  //     without a budget, and `adaptive` is a non-portable Bedrock extension.
  if (req.thinking && typeof req.thinking.budget_tokens === "number") {
    const MIN_BUDGET = 1024;
    const ANSWER_ROOM = 256;
    if (req.thinking.budget_tokens < MIN_BUDGET) req.thinking.budget_tokens = MIN_BUDGET;
    if (req.thinking.budget_tokens >= req.max_tokens) {
      const target = req.max_tokens - ANSWER_ROOM;
      if (target >= MIN_BUDGET) {
        req.thinking.budget_tokens = target;
      } else {
        delete req.thinking;
      }
    }
  }

  // Anthropic enforces that every `tool_use` block must be followed by a user
  // message containing a `tool_result` block with a matching `tool_use_id`.
  // Clients (notably Codex and partial-conversation replays) sometimes omit
  // trailing tool_results when a tool call was cancelled, or arrive at a
  // turn boundary mid-tool-call. Without reconciliation Bedrock returns 400
  // ("`tool_use` ids were found without `tool_result` blocks immediately
  // after"). Synthesize placeholder tool_results so the conversation validates.
  reconcileToolUsePairs(req.messages);

  return req;
}

/**
 * Walk an Anthropic-shape message array and ensure every `tool_use` in an
 * assistant turn has a matching `tool_result` in the NEXT user message. If a
 * run of tool_results already exists on the next user message, we append any
 * missing ones; otherwise we insert a fresh user message. Mutates in place.
 *
 * Synthesized placeholders carry a neutral, obviously-artificial string so the
 * model can tell the call was dropped rather than completed successfully.
 *
 * Note on adjacency: this function intentionally only inspects messages[i+1]
 * (the "next" user message). By the time the converter chain reaches us,
 * Responses-only items (`reasoning`, `web_search_call`, etc.) have already
 * been stripped by responsesBodyToOpenAIChat, and openaiBodyToAnthropic
 * collapses every contiguous run of role:tool messages into ONE Anthropic
 * user message. So in practice the next-index lookup is sufficient — but
 * any future converter that introduces non-message blocks between
 * assistant→user must update this assumption rather than rely on it
 * implicitly.
 */
function reconcileToolUsePairs(messages) {
  if (!Array.isArray(messages)) return;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const toolUses = m.content.filter(b => b && b.type === "tool_use" && b.id);
    if (toolUses.length === 0) continue;

    // Which ids are already satisfied by a tool_result in the next user msg?
    const next = messages[i + 1];
    const satisfied = new Set();
    let nextResults = null;
    if (next && next.role === "user" && Array.isArray(next.content)) {
      nextResults = next.content;
      for (const b of nextResults) {
        if (b && b.type === "tool_result" && b.tool_use_id) satisfied.add(b.tool_use_id);
      }
    }

    const missing = toolUses.filter(tu => !satisfied.has(tu.id));
    if (missing.length === 0) continue;

    const placeholders = missing.map(tu => ({
      type: "tool_result",
      tool_use_id: tu.id,
      content: "[tool call was not completed]",
    }));
    if (nextResults) {
      // Prepend so ordering matches the tool_use sequence in the assistant msg
      // (Anthropic does not require order but it keeps logs readable).
      next.content = [...placeholders, ...nextResults];
    } else {
      messages.splice(i + 1, 0, { role: "user", content: placeholders });
    }
  }

  // Reverse pass: any `tool_result` whose id wasn't produced by the prev
  // assistant's tool_use becomes an orphan. Bedrock rejects those; convert to
  // a plain text block so content is preserved but the validator passes.
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!m || m.role !== "user" || !Array.isArray(m.content)) continue;
    if (!m.content.some(b => b && b.type === "tool_result")) continue;

    const prev = messages[i - 1];
    const validIds = new Set();
    if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        if (b && b.type === "tool_use" && b.id) validIds.add(b.id);
      }
    }

    const rebuilt = [];
    for (const b of m.content) {
      if (b && b.type === "tool_result") {
        if (b.tool_use_id && validIds.has(b.tool_use_id)) {
          rebuilt.push(b);
        } else {
          const txt = typeof b.content === "string"
            ? b.content
            : Array.isArray(b.content)
              ? b.content.filter(x => x && x.type === "text").map(x => x.text).join("")
              : "";
          rebuilt.push({ type: "text", text: `[stale tool result ${b.tool_use_id || ""}] ${txt}`.trim() });
        }
      } else {
        rebuilt.push(b);
      }
    }
    m.content = rebuilt;
  }
}

// ============================================================
// Anthropic -> OpenAI Response (non-streaming)
// ============================================================

function anthropicResponseToOpenAIChat(anthropicRes) {
  const content = anthropicRes.content || [];
  const textParts = content.filter(b => b.type === "text").map(b => b.text);
  const thinkingParts = content.filter(b => b.type === "thinking").map(b => b.thinking || b.text || "");
  const toolParts = content.filter(b => b.type === "tool_use");

  // Surface thinking as a dedicated `reasoning_content` field (matches the
  // vLLM / SGLang / DeepSeek / GLM reasoner convention). Keep it OUT of the
  // main `content` string so downstream Responses-format translation doesn't
  // bake "[Thinking]" noise into `output_text`.
  const message = { role: "assistant", content: textParts.join("") };
  if (thinkingParts.length > 0) {
    message.reasoning_content = thinkingParts.join("");
  }
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
    if (sr === "end_turn" || sr === "stop" || sr === "stop_sequence") return "stop";
    if (sr === "max_tokens") return "length";
    // Anthropic `pause_turn` means "the model paused a long-running turn;
    // the client may resubmit to continue". The closest OpenAI semantic is
    // `length` (output truncated, more available) — NOT `stop`, because
    // `stop` signals a complete response and would cause clients to drop
    // the partial output instead of resuming.
    if (sr === "pause_turn") return "length";
    if (sr === "tool_use") return "tool_calls";
    if (sr === "refusal" || sr === "content_filter") return "content_filter";
    return "stop";
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
  // Anthropic content_block indices mix text / thinking / tool_use in a
  // single counter. OpenAI Chat tool_calls[].index is a dense 0-based index
  // into the assistant's tool_calls array ONLY. Map content-block index →
  // tool index so parallel tool calls round-trip with the correct shape.
  const toolIndexByAnthIdx = new Map();
  let nextToolIndex = 0;

  function translate(line) {
    // SSE spec: `data:` may be followed by ": " OR a bare ":" — accept both
    // so upstreams that omit the space (some Bedrock/openai-compatible
    // gateways) still translate cleanly instead of being silently dropped.
    if (!line.startsWith("data:")) return "";
    let payload = line.slice(5);
    if (payload.startsWith(" ")) payload = payload.slice(1);
    payload = payload.trim();
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
        const anthIdx = typeof evt.index === "number" ? evt.index : 0;
        const toolIdx = nextToolIndex;
        toolIndexByAnthIdx.set(anthIdx, toolIdx);
        nextToolIndex += 1;
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, id: block.id, type: "function", function: { name: block.name || "", arguments: "" } }] }, finish_reason: null }]
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
      // Anthropic emits `thinking_delta` inside a thinking content_block.
      // Expose it to downstream Chat consumers as `reasoning_content`, which
      // is the de-facto field used by vLLM / SGLang / DeepSeek / GLM reasoner
      // streams and the same field our non-streaming converter now emits.
      if (delta.type === "thinking_delta" && delta.thinking) {
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { reasoning_content: delta.thinking }, finish_reason: null }]
        })}\n\n`;
      }
      if (delta.type === "input_json_delta" && delta.partial_json) {
        const anthIdx = typeof evt.index === "number" ? evt.index : 0;
        const toolIdx = toolIndexByAnthIdx.has(anthIdx)
          ? toolIndexByAnthIdx.get(anthIdx)
          : 0;
        return `data: ${JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created: now, model,
          choices: [{ index: 0, delta: { tool_calls: [{ index: toolIdx, function: { arguments: delta.partial_json } }] }, finish_reason: null }]
        })}\n\n`;
      }
      return "";
    }

    if (evt.type === "message_delta") {
      parseAnthropicSSEUsage(line, acc);
      const d = evt.delta || {};

      let finishReason = null;
      if (d.stop_reason) {
        const sr = d.stop_reason;
        if (sr === "end_turn" || sr === "stop" || sr === "stop_sequence") finishReason = "stop";
        else if (sr === "tool_use") finishReason = "tool_calls";
        else if (sr === "max_tokens" || sr === "pause_turn") finishReason = "length";
        else if (sr === "refusal" || sr === "content_filter") finishReason = "content_filter";
        else finishReason = "stop";
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

  /**
   * Emit a terminal chunk when the upstream stream errored BEFORE a natural
   * message_delta/stop. Callers use this from their `upstreamBody.on("error")`
   * handler so the downstream Chat client sees a proper finish_reason + DONE
   * instead of a hung connection.
   */
  function finalize(err) {
    const now = Math.floor(Date.now() / 1000);
    const anthUsage = {
      input_tokens: acc.input_tokens,
      output_tokens: acc.output_tokens,
    };
    if (acc.cache_read_tokens > 0) anthUsage.cache_read_input_tokens = acc.cache_read_tokens;
    if (acc.cache_write_tokens > 0) anthUsage.cache_creation_input_tokens = acc.cache_write_tokens;
    const finishReason = err ? "error" : "stop";
    const parts = [];
    parts.push(`data: ${JSON.stringify({
      id: chatId, object: "chat.completion.chunk", created: now, model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: anthropicUsageToOpenAIShape(anthUsage)
    })}\n\n`);
    parts.push("data: [DONE]\n\n");
    return parts.join("");
  }

  return { translate, getAcc() { return acc; }, finalize };
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
  if (!line.startsWith("data:")) return;
  let payload = line.slice(5);
  if (payload.startsWith(" ")) payload = payload.slice(1);
  payload = payload.trim();
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

/**
 * Final-pass sanitizer for an Anthropic Messages request body just before it
 * leaves the gateway. Anthropic enforces several content-shape invariants
 * that our converters _try_ to uphold, but degenerate upstream input (empty
 * tool outputs, whitespace-only text, dangling tool_use without tool_result,
 * etc.) can still produce a body that gets a 400 like:
 *
 *   "messages: text content blocks must contain non-whitespace text"
 *
 * Mutating in place keeps callers simple — every proxy path can call this
 * unconditionally on the object it is about to JSON.stringify.
 *
 * Invariants enforced:
 *   - Every {type:"text"} block has non-whitespace text (whitespace-only or
 *     empty texts are replaced with a single-character placeholder so the
 *     turn is preserved without violating the API rule).
 *   - tool_result.content arrays are similarly cleaned; if cleaning empties
 *     the array, the tool_result falls back to a "(empty)" string.
 *   - tool_use blocks always carry a non-empty id and name and an object
 *     `input` (Anthropic rejects null / array inputs).
 *   - image blocks without a usable source are dropped rather than 400'd.
 *   - Messages whose content array becomes empty after cleaning are dropped.
 *   - Adjacent same-role messages (other than the special user/tool_result
 *     pairing) are coalesced — Anthropic accepts alternation but a stray
 *     duplicate role from a buggy client otherwise rolls up into the next
 *     turn unpredictably.
 *   - Top-level `system` is normalized to a string (drop if empty/whitespace).
 */
function sanitizeAnthropicBody(body) {
  if (!body || typeof body !== "object") return body;

  if (typeof body.system === "string") {
    if (!body.system.trim()) delete body.system;
  } else if (Array.isArray(body.system)) {
    const parts = [];
    for (const s of body.system) {
      if (s == null) continue;
      if (typeof s === "string") { if (s.trim()) parts.push(s); continue; }
      if (s.type === "text" && typeof s.text === "string" && s.text.trim()) parts.push(s.text);
    }
    if (parts.length === 0) delete body.system;
    else body.system = parts.join("\n\n");
  }

  if (!Array.isArray(body.messages)) return body;

  const PLACEHOLDER = "(empty)";
  const cleanText = t => {
    if (typeof t !== "string") return PLACEHOLDER;
    return t.length > 0 && t.trim().length > 0 ? t : PLACEHOLDER;
  };
  const cleanToolResultContent = c => {
    if (typeof c === "string") return c.trim() ? c : PLACEHOLDER;
    if (!Array.isArray(c)) {
      if (c == null) return PLACEHOLDER;
      try { return JSON.stringify(c); } catch { return PLACEHOLDER; }
    }
    const parts = [];
    for (const p of c) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "text") {
        parts.push({ type: "text", text: cleanText(p.text) });
        continue;
      }
      if (p.type === "image" && p.source) { parts.push(p); continue; }
    }
    return parts.length > 0 ? parts : PLACEHOLDER;
  };
  const isValidImage = src => {
    if (!src || typeof src !== "object") return false;
    if (src.type === "base64") return typeof src.media_type === "string" && typeof src.data === "string" && src.data.length > 0;
    if (src.type === "url") return typeof src.url === "string" && src.url.length > 0;
    return false;
  };

  const cleaned = [];
  for (const msg of body.messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = msg.role === "assistant" ? "assistant" : "user";

    let blocks;
    if (typeof msg.content === "string") {
      blocks = [{ type: "text", text: cleanText(msg.content) }];
    } else if (Array.isArray(msg.content)) {
      blocks = [];
      for (const b of msg.content) {
        if (!b || typeof b !== "object") continue;
        if (b.type === "text") {
          blocks.push({ ...b, text: cleanText(b.text) });
          continue;
        }
        if (b.type === "thinking") {
          // Anthropic rejects thinking blocks with empty .thinking; drop in
          // that case rather than substitute, since thinking is optional.
          if (typeof b.thinking === "string" && b.thinking.length > 0) blocks.push(b);
          else if (typeof b.text === "string" && b.text.length > 0) blocks.push({ ...b, thinking: b.text });
          continue;
        }
        if (b.type === "tool_use") {
          const id = typeof b.id === "string" && b.id ? b.id : `toolu_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const name = typeof b.name === "string" && b.name ? b.name : "unknown_tool";
          let input = b.input;
          if (input == null || typeof input !== "object" || Array.isArray(input)) input = {};
          blocks.push({ ...b, id, name, input });
          continue;
        }
        if (b.type === "tool_result") {
          blocks.push({
            ...b,
            tool_use_id: typeof b.tool_use_id === "string" ? b.tool_use_id : "",
            content: cleanToolResultContent(b.content),
          });
          continue;
        }
        if (b.type === "image") {
          if (isValidImage(b.source)) blocks.push(b);
          continue;
        }
        // Unknown block — keep as-is so future Anthropic block types pass
        // through, but only if it has some payload to avoid sending {} that
        // would fail strict validation.
        if (Object.keys(b).length > 1) blocks.push(b);
      }
    } else {
      blocks = [{ type: "text", text: PLACEHOLDER }];
    }

    if (blocks.length === 0) continue;

    if (cleaned.length > 0 && cleaned[cleaned.length - 1].role === role) {
      // Coalesce into the previous same-role message rather than emit two
      // back-to-back turns of the same role.
      const prev = cleaned[cleaned.length - 1];
      const prevContent = Array.isArray(prev.content) ? prev.content : [{ type: "text", text: cleanText(prev.content) }];
      prev.content = prevContent.concat(blocks);
      continue;
    }
    cleaned.push({ role, content: blocks });
  }

  // Anthropic requires the first message to be role "user". If somehow we
  // ended up with a leading assistant turn (e.g. an upstream conversation
  // template that starts with a primer), prepend a minimal user turn.
  if (cleaned.length === 0) {
    cleaned.push({ role: "user", content: [{ type: "text", text: PLACEHOLDER }] });
  } else if (cleaned[0].role !== "user") {
    cleaned.unshift({ role: "user", content: [{ type: "text", text: PLACEHOLDER }] });
  }

  body.messages = cleaned;
  return body;
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
  sanitizeAnthropicBody,
};
