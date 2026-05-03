"use strict";

/**
 * OpenAI Responses API <-> OpenAI Chat Completions conversions.
 *
 * Rationale: Responses API is the newer surface; Chat Completions is still the
 * common wire format supported by every OpenAI-compatible backend we care
 * about. Going Responses <-> Chat lets us compose with existing Chat <->
 * Anthropic converters for backends that speak Messages API, without any
 * duplicated protocol glue.
 *
 * Unsupported Responses features (documented, not silently altered):
 *   - store / previous_response_id : the gateway is stateless, conversation
 *     state must be managed client-side
 *   - hosted tools (web_search_preview / file_search / computer_use / code_interpreter)
 *     : dropped from request; backends must not rely on hosted execution
 *   - reasoning summary events : passthrough for openai backends, dropped for
 *     anthropic backends (no equivalent signal)
 */

const crypto = require("crypto");
const { normalizeUsage } = require("./usage_recorder");

// ============================================================
// ID helpers
// ============================================================

function rid(prefix, len = 24) {
  return prefix + "_" + crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

// ============================================================
// Responses -> Chat (request)
// ============================================================

/**
 * Translate an input-item `message` (Responses shape) to a Chat message.
 * Returns null if no renderable content.
 */
function toChatMessage(item, role) {
  if (typeof item.content === "string") {
    return { role, content: item.content };
  }
  if (!Array.isArray(item.content)) return null;

  const parts = [];
  for (const p of item.content) {
    if (!p || typeof p !== "object") continue;
    if (p.type === "input_text" || p.type === "text") {
      parts.push({ type: "text", text: p.text || "" });
    } else if (p.type === "output_text") {
      // A prior assistant turn being echoed back as context.
      parts.push({ type: "text", text: p.text || "" });
    } else if (p.type === "input_image") {
      const url = p.image_url || p.url || "";
      if (!url) continue;
      const img = { url };
      if (p.detail) img.detail = p.detail;
      parts.push({ type: "image_url", image_url: img });
    } else if (p.type === "input_file") {
      // Chat has no generic file part; surface as an inline hint so the model
      // can at least see the filename.
      const hint = p.filename ? `[file: ${p.filename}]` : "[file]";
      parts.push({ type: "text", text: hint });
    } else if (p.type === "refusal") {
      parts.push({ type: "text", text: p.refusal || "" });
    }
  }
  if (parts.length === 0) return { role, content: "" };
  if (parts.every(pp => pp.type === "text")) {
    return { role, content: parts.map(pp => pp.text).join("") };
  }
  return { role, content: parts };
}

function responsesBodyToOpenAIChat(body) {
  const messages = [];

  // Per Responses spec, `instructions` are a high-priority system directive;
  // we materialize them as a leading system message so any Chat-format backend
  // receives them in the conventional position.
  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    messages.push({ role: "system", content: body.instructions });
  }

  // Normalize input → array of items.
  let items = [];
  if (typeof body.input === "string") {
    items = [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }];
  } else if (Array.isArray(body.input)) {
    items = body.input.filter(it => it && typeof it === "object");
  }

  // Walk items; consecutive function_calls fold into a single assistant msg
  // (Chat requires tool_calls on the same message).
  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const t = it.type;
    if (!t || t === "message") {
      const role = it.role || "user";
      const m = toChatMessage(it, role);
      if (m) messages.push(m);
      i += 1; continue;
    }
    if (t === "function_call") {
      const toolCalls = [];
      while (i < items.length && items[i].type === "function_call") {
        const fc = items[i];
        toolCalls.push({
          id: fc.call_id || fc.id || rid("call", 24),
          type: "function",
          function: {
            name: fc.name || "",
            arguments: typeof fc.arguments === "string"
              ? fc.arguments
              : JSON.stringify(fc.arguments || {}),
          },
        });
        i += 1;
      }
      messages.push({ role: "assistant", content: null, tool_calls: toolCalls });
      continue;
    }
    if (t === "function_call_output") {
      const out = typeof it.output === "string"
        ? it.output
        : JSON.stringify(it.output || "");
      messages.push({ role: "tool", tool_call_id: it.call_id || "", content: out });
      i += 1; continue;
    }
    // reasoning, web_search_call, file_search_call, computer_call, etc. —
    // no Chat equivalent, drop silently.
    i += 1;
  }

  const out = { model: body.model, messages };
  if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (typeof body.parallel_tool_calls === "boolean") out.parallel_tool_calls = body.parallel_tool_calls;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      // Responses function tool has a flat shape: {type:"function", name, description, parameters}.
      // Chat wraps function details under a .function sub-object.
      if (t.type === "function" || (t.name && t.parameters)) {
        tools.push({
          type: "function",
          function: {
            name: t.name || t.function?.name || "",
            description: t.description || t.function?.description || "",
            parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
          },
        });
      }
      // Hosted tools dropped — see module docstring.
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto" || tc === "none" || tc === "required") {
      out.tool_choice = tc;
    } else if (typeof tc === "object" && tc.type === "function" && tc.name) {
      out.tool_choice = { type: "function", function: { name: tc.name } };
    }
  }

  if (body.reasoning && typeof body.reasoning.effort === "string") {
    // Passthrough: OpenAI's o-series Chat endpoint accepts reasoning_effort.
    out.reasoning_effort = body.reasoning.effort;
  }

  return out;
}

// ============================================================
// Chat -> Responses (non-streaming response)
// ============================================================

/**
 * Build the `usage` sub-object in Responses shape from a normalized usage.
 * Responses reports `input_tokens` as TOTAL prompt including cached portion
 * (matching Chat's `prompt_tokens`), with the cached breakdown surfaced
 * under `input_tokens_details.cached_tokens`.
 */
function usageToResponsesShape(rawUsage) {
  const norm = normalizeUsage(rawUsage);
  const totalInput = norm.input_tokens + norm.cache_read_tokens;
  const out = {
    input_tokens: totalInput,
    output_tokens: norm.output_tokens,
    total_tokens: totalInput + norm.output_tokens,
  };
  if (norm.cache_read_tokens > 0) {
    out.input_tokens_details = { cached_tokens: norm.cache_read_tokens };
  }
  if (norm.cache_write_tokens > 0) {
    // Non-standard on OpenAI's side; keep extension field so accounting
    // isn't silently lost when the upstream was Anthropic.
    out.cache_creation_input_tokens = norm.cache_write_tokens;
  }
  return out;
}

function mapFinishReasonToStatus(finishReason) {
  if (!finishReason) return { status: "completed", incomplete_details: null };
  if (finishReason === "length") {
    return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  }
  if (finishReason === "content_filter") {
    return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
  }
  return { status: "completed", incomplete_details: null };
}

function openaiChatResponseToResponses(chatResp, reqBody) {
  const choice = chatResp.choices?.[0];
  const msg = choice?.message || {};
  const output = [];
  let outputText = "";

  if (typeof msg.content === "string" && msg.content.length > 0) {
    output.push({
      type: "message",
      id: rid("msg"),
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: msg.content, annotations: [] }],
    });
    outputText = msg.content;
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      output.push({
        type: "function_call",
        id: rid("fc"),
        call_id: tc.id || rid("call"),
        name: tc.function?.name || "",
        arguments: tc.function?.arguments || "",
        status: "completed",
      });
    }
  }

  const { status, incomplete_details } = mapFinishReasonToStatus(choice?.finish_reason);

  return {
    id: rid("resp"),
    object: "response",
    created_at: chatResp.created || Math.floor(Date.now() / 1000),
    status,
    model: chatResp.model || reqBody?.model || "",
    output,
    output_text: outputText,
    usage: usageToResponsesShape(chatResp.usage),
    metadata: reqBody?.metadata || null,
    parallel_tool_calls: reqBody?.parallel_tool_calls !== false,
    temperature: reqBody?.temperature ?? null,
    top_p: reqBody?.top_p ?? null,
    tool_choice: reqBody?.tool_choice || "auto",
    tools: Array.isArray(reqBody?.tools) ? reqBody.tools : [],
    max_output_tokens: reqBody?.max_output_tokens ?? null,
    previous_response_id: null,
    store: false,
    reasoning: reqBody?.reasoning || null,
    incomplete_details,
    error: null,
    instructions: reqBody?.instructions || null,
  };
}

// ============================================================
// Chat -> Responses SSE translator
// ============================================================

/**
 * Build a translator that consumes parsed OpenAI Chat Completions chunk
 * objects (one per call to .translate()) and emits the corresponding
 * OpenAI Responses SSE event bytes.
 *
 * Responses SSE wire format: each event is
 *     event: <type>\ndata: <json>\n\n
 *
 * Each emitted JSON object includes an incrementing `sequence_number`, per
 * OpenAI's published shape. Response-level lifecycle events are gated so they
 * fire exactly once each.
 */
function createOpenAIChatToResponsesSSETranslator(model, reqBody) {
  const responseId = rid("resp");
  let sequence = 0;
  let createdEmitted = false;
  let inProgressEmitted = false;
  let completedEmitted = false;
  let usage = null;
  let nextOutputIndex = 0;
  let msg = null;           // current assistant message item state (or null)
  const toolByChatIdx = new Map();
  const output = [];        // dense array of items for final response

  function sseEvent(eventType, data) {
    const payload = { ...data, sequence_number: sequence };
    sequence += 1;
    return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  function snapshot(status) {
    return {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model,
      output: output.filter(Boolean),
      output_text: collectText(),
      usage: usage ? usageToResponsesShape(usage) : null,
      metadata: reqBody?.metadata || null,
      parallel_tool_calls: reqBody?.parallel_tool_calls !== false,
      temperature: reqBody?.temperature ?? null,
      top_p: reqBody?.top_p ?? null,
      tool_choice: reqBody?.tool_choice || "auto",
      tools: Array.isArray(reqBody?.tools) ? reqBody.tools : [],
      max_output_tokens: reqBody?.max_output_tokens ?? null,
      previous_response_id: null,
      store: false,
      reasoning: reqBody?.reasoning || null,
      incomplete_details: null,
      error: null,
      instructions: reqBody?.instructions || null,
    };
  }

  function collectText() {
    let s = "";
    for (const it of output) {
      if (it && it.type === "message" && Array.isArray(it.content)) {
        for (const p of it.content) {
          if (p && p.type === "output_text") s += p.text || "";
        }
      }
    }
    return s;
  }

  function ensureCreated() {
    if (createdEmitted) return "";
    createdEmitted = true;
    return sseEvent("response.created", { type: "response.created", response: snapshot("in_progress") });
  }
  function ensureInProgress() {
    if (inProgressEmitted) return "";
    inProgressEmitted = true;
    return sseEvent("response.in_progress", { type: "response.in_progress", response: snapshot("in_progress") });
  }

  function openMessage() {
    const item = {
      type: "message",
      id: rid("msg"),
      status: "in_progress",
      role: "assistant",
      content: [],
    };
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    output[outputIndex] = item;
    msg = { id: item.id, outputIndex, contentIndex: 0, textAcc: "", partOpen: false };
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });
  }
  function openOutputTextPart() {
    const part = { type: "output_text", text: "", annotations: [] };
    output[msg.outputIndex].content[msg.contentIndex] = part;
    msg.partOpen = true;
    return sseEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: msg.id,
      output_index: msg.outputIndex,
      content_index: msg.contentIndex,
      part,
    });
  }
  function emitTextDelta(text) {
    msg.textAcc += text;
    output[msg.outputIndex].content[msg.contentIndex].text = msg.textAcc;
    return sseEvent("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: msg.id,
      output_index: msg.outputIndex,
      content_index: msg.contentIndex,
      delta: text,
    });
  }
  function closeMessage() {
    if (!msg) return "";
    const parts = [];
    if (msg.partOpen) {
      const doneText = msg.textAcc;
      const finalPart = { type: "output_text", text: doneText, annotations: [] };
      parts.push(sseEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: msg.id,
        output_index: msg.outputIndex,
        content_index: msg.contentIndex,
        text: doneText,
      }));
      parts.push(sseEvent("response.content_part.done", {
        type: "response.content_part.done",
        item_id: msg.id,
        output_index: msg.outputIndex,
        content_index: msg.contentIndex,
        part: finalPart,
      }));
      msg.partOpen = false;
    }
    const item = output[msg.outputIndex];
    item.status = "completed";
    parts.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: msg.outputIndex,
      item,
    }));
    msg = null;
    return parts.join("");
  }

  function openTool(chatIdx, callId, name) {
    const state = {
      id: rid("fc"),
      outputIndex: nextOutputIndex,
      callId: callId || rid("call"),
      name: name || "",
      argsAcc: "",
    };
    nextOutputIndex += 1;
    const item = {
      type: "function_call",
      id: state.id,
      call_id: state.callId,
      name: state.name,
      arguments: "",
      status: "in_progress",
    };
    output[state.outputIndex] = item;
    toolByChatIdx.set(chatIdx, state);
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: state.outputIndex,
      item,
    });
  }
  function emitToolArgsDelta(chatIdx, delta) {
    const st = toolByChatIdx.get(chatIdx);
    if (!st) return "";
    st.argsAcc += delta;
    output[st.outputIndex].arguments = st.argsAcc;
    return sseEvent("response.function_call_arguments.delta", {
      type: "response.function_call_arguments.delta",
      item_id: st.id,
      output_index: st.outputIndex,
      delta,
    });
  }
  function closeTools() {
    const parts = [];
    for (const st of toolByChatIdx.values()) {
      parts.push(sseEvent("response.function_call_arguments.done", {
        type: "response.function_call_arguments.done",
        item_id: st.id,
        output_index: st.outputIndex,
        arguments: st.argsAcc,
      }));
      output[st.outputIndex].status = "completed";
      parts.push(sseEvent("response.output_item.done", {
        type: "response.output_item.done",
        output_index: st.outputIndex,
        item: output[st.outputIndex],
      }));
    }
    toolByChatIdx.clear();
    return parts.join("");
  }

  return {
    translate(chunk) {
      if (!chunk || typeof chunk !== "object") return "";
      const parts = [];
      if (!createdEmitted) {
        parts.push(ensureCreated());
        parts.push(ensureInProgress());
      }
      if (chunk.usage) usage = chunk.usage;

      if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) {
        return parts.join("");
      }
      const choice = chunk.choices[0];
      const delta = choice.delta || {};
      const finishReason = choice.finish_reason;

      const hasToolCalls = Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
      const hasText = typeof delta.content === "string" && delta.content.length > 0;

      if (hasText) {
        if (!msg) parts.push(openMessage());
        if (!msg.partOpen) parts.push(openOutputTextPart());
        parts.push(emitTextDelta(delta.content));
      }

      if (hasToolCalls) {
        if (msg) parts.push(closeMessage());
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolByChatIdx.has(idx)) {
            parts.push(openTool(idx, tc.id, tc.function?.name));
          } else if (tc.function?.name) {
            const st = toolByChatIdx.get(idx);
            st.name = tc.function.name;
            output[st.outputIndex].name = tc.function.name;
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            parts.push(emitToolArgsDelta(idx, args));
          }
        }
      }

      if (finishReason) {
        if (msg) parts.push(closeMessage());
        if (toolByChatIdx.size > 0) parts.push(closeTools());
        // response.completed is fired in finalize() — wait for possible
        // trailing usage-only chunk so the final snapshot has totals.
      }

      return parts.join("");
    },

    finalize(err) {
      if (completedEmitted) return "";
      completedEmitted = true;
      const parts = [];
      if (!createdEmitted) parts.push(ensureCreated());
      if (msg) parts.push(closeMessage());
      if (toolByChatIdx.size > 0) parts.push(closeTools());
      const status = err ? "failed" : "completed";
      const snap = snapshot(status);
      if (err) snap.error = { message: err.message || String(err), type: "upstream_error" };
      parts.push(sseEvent(err ? "response.failed" : "response.completed", {
        type: err ? "response.failed" : "response.completed",
        response: snap,
      }));
      return parts.join("");
    },

    getUsage() { return usage; },
  };
}

module.exports = {
  responsesBodyToOpenAIChat,
  openaiChatResponseToResponses,
  createOpenAIChatToResponsesSSETranslator,
  usageToResponsesShape,
  // exposed for tests
  _toChatMessage: toChatMessage,
};
