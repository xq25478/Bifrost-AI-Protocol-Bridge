"use strict";

/**
 * OpenAI Responses API <-> OpenAI Chat Completions conversions.
 *
 * Rationale: Responses API is the newer surface; Chat Completions is still the
 * common wire format supported by every OpenAI-compatible backend we care
 * about. Anthropic Messages has its own direct converter in
 * converters_responses_anthropic.js so Responses items do not have to pass
 * through Chat when the upstream backend speaks Anthropic.
 *
 * Unsupported Responses features (documented, not silently altered):
 *   - store / previous_response_id : the gateway is stateless, conversation
 *     state must be managed client-side
 *   - hosted tools (web_search_preview / file_search / computer_use / code_interpreter)
 *     : dropped from request; backends must not rely on hosted execution
 *   - reasoning input items : dropped while downgrading request history to
 *     Chat, except for reasoning.effort which maps to reasoning_effort
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

/**
 * Flatten a Responses `function_call_output.output` value into a plain string
 * suitable for Chat's `tool` message content. The spec allows `output` to be
 * either a string, or an array of content parts (mirroring `message.content`),
 * where parts may be `{type:"output_text",text}` or `{type:"output_image",...}`.
 * Chat's `tool` role content is string-only, so we extract text parts and
 * leave a `[image omitted]` breadcrumb for image parts rather than silently
 * JSON-stringifying the whole structure (which the model then has to "parse").
 */
function flattenToolOutput(raw) {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (!Array.isArray(raw)) {
    try { return JSON.stringify(raw); } catch { return String(raw); }
  }
  const pieces = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    if (typeof p.text === "string") { pieces.push(p.text); continue; }
    if (p.type === "output_text" || p.type === "text" || p.type === "input_text") {
      pieces.push(typeof p.text === "string" ? p.text : "");
      continue;
    }
    if (p.type === "output_image" || p.type === "input_image" || p.type === "image") {
      pieces.push("[image omitted]");
      continue;
    }
    try { pieces.push(JSON.stringify(p)); } catch { pieces.push(""); }
  }
  return pieces.join("");
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

  // Fold contiguous assistant-origin items (message / function_call, plus
  // interleaved reasoning which we skip but that must NOT split the run)
  // into a single Chat assistant message. Chat requires tool_calls to ride on
  // the same assistant turn as its text content.
  function makeToolCall(fc) {
    return {
      id: fc.call_id || fc.id || rid("call", 24),
      type: "function",
      function: {
        name: fc.name || "",
        arguments: typeof fc.arguments === "string"
          ? fc.arguments
          : JSON.stringify(fc.arguments || {}),
      },
    };
  }

  // Pre-scan: index every function_call_output by its call_id so we can
  // emit the output immediately after its matching function_call, even when
  // Codex interleaves reasoning / other messages between the two. Anthropic
  // requires `tool_use` and `tool_result` to live in adjacent messages, so
  // we rebuild the order rather than echoing Codex's input sequence.
  const outputsByCallId = new Map();
  for (const it of items) {
    if (it && it.type === "function_call_output" && typeof it.call_id === "string" && it.call_id) {
      if (!outputsByCallId.has(it.call_id)) {
        outputsByCallId.set(it.call_id, { item: it, consumed: false });
      }
    }
  }

  // Emit a `role:tool` message for a function_call, pairing with its captured
  // output (consuming the map entry) or synthesizing an empty result when no
  // output exists. This guarantees every tool_call has a paired tool output
  // immediately after it in the Chat message stream.
  function emitToolResult(call) {
    const id = call.call_id || call.id || "";
    const entry = id ? outputsByCallId.get(id) : null;
    if (entry && !entry.consumed) {
      entry.consumed = true;
      messages.push({ role: "tool", tool_call_id: id, content: flattenToolOutput(entry.item.output) });
    } else {
      messages.push({ role: "tool", tool_call_id: id, content: "" });
    }
  }

  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const t = it.type;

    // Responses `reasoning` items are assistant-origin metadata between
    // function_call chunks; drop them but do NOT break the assistant run,
    // otherwise contiguous function_calls get fragmented into multiple
    // assistant messages and the tool-call ordering breaks.
    if (t === "reasoning" || t === "web_search_call" || t === "file_search_call" ||
        t === "computer_call" || t === "code_interpreter_call") {
      i += 1; continue;
    }

    if (t === "function_call_output") {
      // Outputs are emitted alongside their matching call above; anything
      // still visible here is either (a) already consumed, or (b) orphaned
      // (no matching call). Either way it must be dropped so we never
      // produce a tool_result without a preceding tool_use.
      i += 1; continue;
    }

    if (!t || t === "message") {
      // Responses API introduced `developer` as the successor to `system`.
      // Chat-format backends (and Anthropic-via-Chat) only know user/assistant
      // /system/tool, so collapse developer → system here.
      let role = it.role || "user";
      if (role === "developer") role = "system";

      if (role === "assistant") {
        // Merge this assistant message with any contiguous function_call items
        // that follow (separated at most by reasoning noise), so text and
        // tool_calls live on the same Chat assistant message.
        const textMsg = toChatMessage(it, "assistant");
        const calls = [];
        let j = i + 1;
        while (j < items.length) {
          const nt = items[j].type;
          if (nt === "reasoning" || nt === "web_search_call" || nt === "file_search_call" ||
              nt === "computer_call" || nt === "code_interpreter_call") { j += 1; continue; }
          if (nt === "function_call") { calls.push(items[j]); j += 1; continue; }
          break;
        }
        const merged = { role: "assistant", content: textMsg ? textMsg.content : null };
        if (calls.length > 0) {
          merged.tool_calls = calls.map(makeToolCall);
          // Chat requires content to be string or null when tool_calls are
          // present; keep textMsg's string content, otherwise use null.
          if (typeof merged.content !== "string") merged.content = null;
        }
        messages.push(merged);
        for (const call of calls) emitToolResult(call);
        i = j; continue;
      }

      const m = toChatMessage(it, role);
      if (m) messages.push(m);
      i += 1; continue;
    }

    if (t === "function_call") {
      // An assistant turn that consists ONLY of tool calls (no leading text
      // message in the same turn). Fold a run of them — tolerating reasoning
      // interleaved — into a single assistant message, then emit each
      // matching output immediately after (consuming from outputsByCallId).
      const calls = [];
      while (i < items.length) {
        const nt = items[i].type;
        if (nt === "reasoning" || nt === "web_search_call" || nt === "file_search_call" ||
            nt === "computer_call" || nt === "code_interpreter_call") { i += 1; continue; }
        if (nt !== "function_call") break;
        calls.push(items[i]);
        i += 1;
      }
      messages.push({ role: "assistant", content: null, tool_calls: calls.map(makeToolCall) });
      for (const call of calls) emitToolResult(call);
      continue;
    }

    // Unknown item type — drop silently.
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
        const fnObj = {
          name: t.name || t.function?.name || "",
          description: t.description || t.function?.description || "",
          parameters: t.parameters || t.function?.parameters || { type: "object", properties: {} },
        };
        // OpenAI Chat Completions accepts `strict` on function tools for
        // structured-outputs JSON schema enforcement. Responses API exposes it
        // at the top-level tool object; carry it through so schema strictness
        // isn't silently dropped on the downstream Chat backend.
        if (typeof t.strict === "boolean") fnObj.strict = t.strict;
        else if (typeof t.function?.strict === "boolean") fnObj.strict = t.function.strict;
        tools.push({ type: "function", function: fnObj });
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

  // Chat-side reasoner deployments (vLLM / SGLang / DeepSeek / GLM) surface
  // chain-of-thought in `message.reasoning_content`; Responses clients expect
  // a dedicated `reasoning` output item with `summary:[{type:"summary_text"}]`.
  // Emit it BEFORE the message item so the assembled `output` array reflects
  // the natural "thought then answer" order.
  if (typeof msg.reasoning_content === "string" && msg.reasoning_content.length > 0) {
    output.push({
      type: "reasoning",
      id: rid("rs"),
      summary: [{ type: "summary_text", text: msg.reasoning_content }],
      status: "completed",
    });
  }

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
  // Reasoning item state — opens when the first `delta.reasoning_content`
  // arrives, closes before any text message or tool_calls are produced.
  let reasoning = null;     // { id, outputIndex, summaryIndex, textAcc, partOpen }
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

  function openReasoning() {
    const item = {
      type: "reasoning",
      id: rid("rs"),
      status: "in_progress",
      summary: [],
    };
    const outputIndex = nextOutputIndex;
    nextOutputIndex += 1;
    output[outputIndex] = item;
    reasoning = { id: item.id, outputIndex, summaryIndex: 0, textAcc: "", partOpen: false };
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });
  }
  function openReasoningSummaryPart() {
    const part = { type: "summary_text", text: "" };
    output[reasoning.outputIndex].summary[reasoning.summaryIndex] = part;
    reasoning.partOpen = true;
    return sseEvent("response.reasoning_summary_part.added", {
      type: "response.reasoning_summary_part.added",
      item_id: reasoning.id,
      output_index: reasoning.outputIndex,
      summary_index: reasoning.summaryIndex,
      part,
    });
  }
  function emitReasoningDelta(text) {
    reasoning.textAcc += text;
    output[reasoning.outputIndex].summary[reasoning.summaryIndex].text = reasoning.textAcc;
    return sseEvent("response.reasoning_summary_text.delta", {
      type: "response.reasoning_summary_text.delta",
      item_id: reasoning.id,
      output_index: reasoning.outputIndex,
      summary_index: reasoning.summaryIndex,
      delta: text,
    });
  }
  function closeReasoning() {
    if (!reasoning) return "";
    const parts = [];
    if (reasoning.partOpen) {
      const doneText = reasoning.textAcc;
      const finalPart = { type: "summary_text", text: doneText };
      parts.push(sseEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: reasoning.outputIndex,
        summary_index: reasoning.summaryIndex,
        text: doneText,
      }));
      parts.push(sseEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: reasoning.outputIndex,
        summary_index: reasoning.summaryIndex,
        part: finalPart,
      }));
      reasoning.partOpen = false;
    }
    const item = output[reasoning.outputIndex];
    item.status = "completed";
    parts.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoning.outputIndex,
      item,
    }));
    reasoning = null;
    return parts.join("");
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
      // Track whether callId is a synthetic placeholder so a later chunk
      // that reveals the real upstream id can overwrite it.
      callId: callId || rid("call"),
      callIdSynthetic: !callId,
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
      const hasReasoning = typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0;

      if (hasReasoning) {
        if (!reasoning) parts.push(openReasoning());
        if (!reasoning.partOpen) parts.push(openReasoningSummaryPart());
        parts.push(emitReasoningDelta(delta.reasoning_content));
      }
      // Reasoning must be closed before any user-visible output (text or tool)
      // so the `output` array follows the canonical reasoning-then-answer order.
      if ((hasText || hasToolCalls) && reasoning) parts.push(closeReasoning());

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
          } else {
            const st = toolByChatIdx.get(idx);
            if (tc.function?.name) {
              st.name = tc.function.name;
              output[st.outputIndex].name = tc.function.name;
            }
            // Backfill the real upstream call id if it was missing in the
            // first chunk. Prevents the emitted `function_call_output` in a
            // downstream tool-result round-trip from referencing a gateway
            // -generated synthetic id the real backend doesn't know.
            if (tc.id && st.callIdSynthetic) {
              st.callId = tc.id;
              st.callIdSynthetic = false;
              output[st.outputIndex].call_id = tc.id;
            }
          }
          const args = tc.function?.arguments;
          if (typeof args === "string" && args.length > 0) {
            parts.push(emitToolArgsDelta(idx, args));
          }
        }
      }

      if (finishReason) {
        if (reasoning) parts.push(closeReasoning());
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
      if (reasoning) parts.push(closeReasoning());
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
