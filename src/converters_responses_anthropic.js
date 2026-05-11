"use strict";

const { DEFAULT_MAX_TOKENS } = require("./config");

/**
 * Direct OpenAI Responses API <-> Anthropic Messages conversions.
 *
 * This module intentionally does not route through Chat Completions. Responses
 * output items map naturally to Anthropic content blocks:
 *   - message/output_text <-> text
 *   - reasoning           <-> thinking
 *   - function_call       <-> tool_use
 *   - function_call_output<-> tool_result
 */

const crypto = require("crypto");
const { effortToBudget } = require("./thinking");
const { normalizeUsage } = require("./usage_recorder");
const { usageToResponsesShape } = require("./converters_responses");

function rid(prefix, len = 24) {
  return prefix + "_" + crypto.randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

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

function imageSourceFromUrl(url) {
  if (!url || typeof url !== "string") return null;
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (m) return { type: "base64", media_type: m[1], data: m[2] };
    return null;
  }
  return { type: "url", url };
}

function stringifyUnknown(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function extractResponseText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringifyUnknown(content);
  const out = [];
  for (const p of content) {
    if (p == null) continue;
    if (typeof p === "string") { out.push(p); continue; }
    if (typeof p.text === "string") { out.push(p.text); continue; }
    if (typeof p.refusal === "string") { out.push(p.refusal); continue; }
    if (p.filename) { out.push(`[file: ${p.filename}]`); continue; }
    if (p.type === "input_image" || p.type === "output_image" || p.type === "image") {
      out.push("[image omitted]");
      continue;
    }
    out.push(stringifyUnknown(p));
  }
  return out.join("");
}

function responsesContentToAnthropicBlocks(content) {
  if (content == null) return [];
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    const text = extractResponseText(content);
    return text ? [{ type: "text", text }] : [];
  }

  const blocks = [];
  for (const p of content) {
    if (p == null) continue;
    if (typeof p === "string") { if (p) blocks.push({ type: "text", text: p }); continue; }
    if (p.type === "input_text" || p.type === "output_text" || p.type === "text") {
      if (p.text) blocks.push({ type: "text", text: p.text });
      continue;
    }
    if (p.type === "refusal") {
      if (p.refusal) blocks.push({ type: "text", text: p.refusal });
      continue;
    }
    if (p.type === "input_image" || p.type === "output_image" || p.type === "image") {
      const source = imageSourceFromUrl(p.image_url || p.url || "");
      if (source) blocks.push({ type: "image", source });
      continue;
    }
    if (p.type === "input_file") {
      blocks.push({ type: "text", text: p.filename ? `[file: ${p.filename}]` : "[file]" });
      continue;
    }
    blocks.push({ type: "text", text: stringifyUnknown(p) });
  }
  return blocks;
}

function blocksToAnthropicContent(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return "";
  if (blocks.every(b => b && b.type === "text")) {
    return blocks.map(b => b.text || "").join("");
  }
  return blocks;
}

function parseToolInput(raw) {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toolOutputToAnthropicContent(raw) {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (!Array.isArray(raw)) return stringifyUnknown(raw);

  const blocks = [];
  for (const p of raw) {
    if (p == null) continue;
    if (typeof p === "string") { blocks.push({ type: "text", text: p }); continue; }
    if (p.type === "output_text" || p.type === "input_text" || p.type === "text") {
      blocks.push({ type: "text", text: p.text || "" });
      continue;
    }
    if (p.type === "output_image" || p.type === "input_image" || p.type === "image") {
      const source = imageSourceFromUrl(p.image_url || p.url || "");
      if (source) blocks.push({ type: "image", source });
      else blocks.push({ type: "text", text: "[image omitted]" });
      continue;
    }
    blocks.push({ type: "text", text: stringifyUnknown(p) });
  }
  if (blocks.length === 0) return "";
  if (blocks.every(b => b.type === "text")) return blocks.map(b => b.text || "").join("");
  return blocks;
}

function makeToolUse(call) {
  return {
    type: "tool_use",
    id: call.call_id || call.id || rid("toolu", 16),
    name: call.name || "",
    input: parseToolInput(call.arguments),
  };
}

function responsesBodyToAnthropic(body) {
  const messages = [];
  const systemParts = [];

  if (typeof body.instructions === "string" && body.instructions.length > 0) {
    systemParts.push(body.instructions);
  }

  let items = [];
  if (typeof body.input === "string") {
    items = [{ type: "message", role: "user", content: [{ type: "input_text", text: body.input }] }];
  } else if (Array.isArray(body.input)) {
    items = body.input.filter(it => it && typeof it === "object");
  }

  const outputsByCallId = new Map();
  for (const it of items) {
    if (it.type === "function_call_output" && typeof it.call_id === "string" && it.call_id) {
      if (!outputsByCallId.has(it.call_id)) {
        outputsByCallId.set(it.call_id, { item: it, consumed: false });
      }
    }
  }

  function skipAssistantNoise(t) {
    return t === "reasoning" || t === "web_search_call" || t === "file_search_call" ||
      t === "computer_call" || t === "code_interpreter_call";
  }

  function emitToolResults(calls) {
    if (!calls.length) return;
    const content = [];
    for (const call of calls) {
      const id = call.call_id || call.id || "";
      const entry = id ? outputsByCallId.get(id) : null;
      if (entry && !entry.consumed) {
        entry.consumed = true;
        content.push({
          type: "tool_result",
          tool_use_id: id,
          content: toolOutputToAnthropicContent(entry.item.output),
        });
      } else {
        content.push({ type: "tool_result", tool_use_id: id, content: "" });
      }
    }
    messages.push({ role: "user", content });
  }

  let i = 0;
  while (i < items.length) {
    const it = items[i];
    const t = it.type;

    if (skipAssistantNoise(t) || t === "function_call_output") {
      i += 1; continue;
    }

    if (!t || t === "message") {
      let role = it.role || "user";
      if (role === "developer" || role === "system") {
        const text = extractResponseText(it.content);
        if (text) systemParts.push(text);
        i += 1; continue;
      }
      if (role !== "assistant") role = "user";

      if (role === "assistant") {
        const content = responsesContentToAnthropicBlocks(it.content);
        const calls = [];
        let j = i + 1;
        while (j < items.length) {
          const nt = items[j].type;
          if (skipAssistantNoise(nt)) { j += 1; continue; }
          if (nt === "function_call") { calls.push(items[j]); j += 1; continue; }
          break;
        }
        for (const call of calls) content.push(makeToolUse(call));
        // Drop fully-empty assistant turns rather than synthesize a
        // `[{type:"text", text:""}]` block — Anthropic rejects empty content.
        if (content.length === 0) { i = j; continue; }
        messages.push({ role: "assistant", content });
        emitToolResults(calls);
        i = j; continue;
      }

      const blocks = responsesContentToAnthropicBlocks(it.content);
      // Skip empty user items: Anthropic rejects messages with no content
      // ("messages: text content blocks must contain non-empty text").
      if (blocks.length === 0) { i += 1; continue; }
      messages.push({ role: "user", content: blocksToAnthropicContent(blocks) });
      i += 1; continue;
    }

    if (t === "function_call") {
      const calls = [];
      while (i < items.length) {
        const nt = items[i].type;
        if (skipAssistantNoise(nt)) { i += 1; continue; }
        if (nt !== "function_call") break;
        calls.push(items[i]);
        i += 1;
      }
      messages.push({ role: "assistant", content: calls.map(makeToolUse) });
      emitToolResults(calls);
      continue;
    }

    i += 1;
  }

  const out = {
    model: body.model,
    messages,
    max_tokens: (typeof body.max_output_tokens === "number" && body.max_output_tokens > 0) ? body.max_output_tokens : DEFAULT_MAX_TOKENS,
  };
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  if (typeof body.stream === "boolean") out.stream = body.stream;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== "object") continue;
      if (t.type === "function" || (t.name && t.parameters)) {
        tools.push({
          name: t.name || t.function?.name || "",
          description: t.description || t.function?.description || "",
          input_schema: normalizeToolInputSchema(t.parameters || t.function?.parameters),
        });
      }
    }
    if (tools.length > 0) out.tools = tools;
  }

  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (tc === "auto") out.tool_choice = { type: "auto" };
    else if (tc === "required") out.tool_choice = { type: "any" };
    else if (tc === "none") delete out.tools;
    else if (typeof tc === "object" && tc.type === "function" && tc.name) {
      out.tool_choice = { type: "tool", name: tc.name };
    }
  }
  if (body.parallel_tool_calls === false && Array.isArray(out.tools) && out.tools.length > 0) {
    if (!out.tool_choice) out.tool_choice = { type: "auto" };
    out.tool_choice.disable_parallel_tool_use = true;
  }

  if (body.reasoning && typeof body.reasoning.effort === "string") {
    out.thinking = { type: "enabled", budget_tokens: effortToBudget(body.reasoning.effort) };
  }

  return out;
}

function responseBase(reqBody, model, output, outputText, usage, statusDetails) {
  return {
    id: rid("resp"),
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: statusDetails.status,
    model: model || reqBody?.model || "",
    output,
    output_text: outputText,
    usage: usageToResponsesShape(usage),
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
    incomplete_details: statusDetails.incomplete_details,
    error: null,
    instructions: reqBody?.instructions || null,
  };
}

function mapAnthropicStopToResponsesStatus(stopReason) {
  if (stopReason === "max_tokens" || stopReason === "model_context_window_exceeded") {
    return { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  }
  if (stopReason === "refusal") {
    return { status: "incomplete", incomplete_details: { reason: "content_filter" } };
  }
  return { status: "completed", incomplete_details: null };
}

function appendTextOutput(output, text) {
  if (!text) return;
  const last = output[output.length - 1];
  if (last && last.type === "message" && Array.isArray(last.content)) {
    const part = last.content[last.content.length - 1];
    if (part && part.type === "output_text") {
      part.text += text;
      return;
    }
  }
  output.push({
    type: "message",
    id: rid("msg"),
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  });
}

function anthropicResponseToResponses(anthropicRes, reqBody) {
  const output = [];
  let outputText = "";
  const content = Array.isArray(anthropicRes.content) ? anthropicRes.content : [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "thinking" && (block.thinking || block.text)) {
      output.push({
        type: "reasoning",
        id: rid("rs"),
        summary: [{ type: "summary_text", text: block.thinking || block.text || "" }],
        status: "completed",
      });
      continue;
    }
    if (block.type === "text") {
      const text = block.text || "";
      outputText += text;
      appendTextOutput(output, text);
      continue;
    }
    if (block.type === "tool_use") {
      output.push({
        type: "function_call",
        id: rid("fc"),
        call_id: block.id || rid("call"),
        name: block.name || "",
        arguments: JSON.stringify(block.input || {}),
        status: "completed",
      });
    }
  }

  const statusDetails = mapAnthropicStopToResponsesStatus(anthropicRes.stop_reason);
  return responseBase(reqBody, anthropicRes.model, output, outputText, anthropicRes.usage, statusDetails);
}

function createAnthropicToResponsesSSETranslator(model, reqBody) {
  const responseId = rid("resp");
  let sequence = 0;
  let createdEmitted = false;
  let inProgressEmitted = false;
  let finalEmitted = false;
  let nextOutputIndex = 0;
  let upstreamModel = model || "";
  let stopReason = null;
  const output = [];
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
  let hasUsage = false;
  let msg = null;
  let reasoning = null;
  const blockType = new Map();
  const tools = new Map();

  function usageRaw() {
    const raw = { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens };
    if (usage.cache_read_tokens > 0) raw.cache_read_input_tokens = usage.cache_read_tokens;
    if (usage.cache_write_tokens > 0) raw.cache_creation_input_tokens = usage.cache_write_tokens;
    return raw;
  }
  function collectText() {
    let text = "";
    for (const item of output) {
      if (item && item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (part && part.type === "output_text") text += part.text || "";
        }
      }
    }
    return text;
  }
  function snapshot(status, incompleteDetails = null) {
    return {
      id: responseId,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status,
      model: upstreamModel || model || reqBody?.model || "",
      output: output.filter(Boolean),
      output_text: collectText(),
      usage: hasUsage ? usageToResponsesShape(usageRaw()) : null,
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
      incomplete_details: incompleteDetails,
      error: null,
      instructions: reqBody?.instructions || null,
    };
  }
  function sseEvent(eventType, data) {
    const payload = { ...data, sequence_number: sequence };
    sequence += 1;
    return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
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
  function lifecycle() {
    return ensureCreated() + ensureInProgress();
  }
  function updateUsage(evt) {
    const u = evt.type === "message_start" ? evt.message?.usage || {} : evt.usage || {};
    if (typeof u.input_tokens === "number") { usage.input_tokens = u.input_tokens; hasUsage = true; }
    if (typeof u.output_tokens === "number") { usage.output_tokens = u.output_tokens; hasUsage = true; }
    if (typeof u.cache_read_input_tokens === "number") { usage.cache_read_tokens = u.cache_read_input_tokens; hasUsage = true; }
    if (typeof u.cache_creation_input_tokens === "number") { usage.cache_write_tokens = u.cache_creation_input_tokens; hasUsage = true; }
  }

  function openMessage() {
    const item = { type: "message", id: rid("msg"), status: "in_progress", role: "assistant", content: [] };
    const outputIndex = nextOutputIndex++;
    output[outputIndex] = item;
    msg = { id: item.id, outputIndex, nextContentIndex: 0, contentIndex: -1, textAcc: "", partOpen: false };
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });
  }
  function openTextPart() {
    if (!msg) return "";
    const contentIndex = msg.nextContentIndex++;
    msg.contentIndex = contentIndex;
    msg.textAcc = "";
    msg.partOpen = true;
    const part = { type: "output_text", text: "", annotations: [] };
    output[msg.outputIndex].content[contentIndex] = part;
    return sseEvent("response.content_part.added", {
      type: "response.content_part.added",
      item_id: msg.id,
      output_index: msg.outputIndex,
      content_index: contentIndex,
      part,
    });
  }
  function emitTextDelta(text) {
    if (!msg || !msg.partOpen) return "";
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
  function closeTextPart() {
    if (!msg || !msg.partOpen) return "";
    const part = { type: "output_text", text: msg.textAcc, annotations: [] };
    const out =
      sseEvent("response.output_text.done", {
        type: "response.output_text.done",
        item_id: msg.id,
        output_index: msg.outputIndex,
        content_index: msg.contentIndex,
        text: msg.textAcc,
      }) +
      sseEvent("response.content_part.done", {
        type: "response.content_part.done",
        item_id: msg.id,
        output_index: msg.outputIndex,
        content_index: msg.contentIndex,
        part,
      });
    msg.partOpen = false;
    return out;
  }
  function closeMessage() {
    if (!msg) return "";
    const parts = [closeTextPart()];
    output[msg.outputIndex].status = "completed";
    parts.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: msg.outputIndex,
      item: output[msg.outputIndex],
    }));
    msg = null;
    return parts.join("");
  }

  function openReasoning() {
    const item = { type: "reasoning", id: rid("rs"), status: "in_progress", summary: [] };
    const outputIndex = nextOutputIndex++;
    output[outputIndex] = item;
    reasoning = { id: item.id, outputIndex, summaryIndex: 0, textAcc: "", partOpen: false };
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });
  }
  function openReasoningPart() {
    if (!reasoning) return "";
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
    if (!reasoning || !reasoning.partOpen) return "";
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
      const part = { type: "summary_text", text: reasoning.textAcc };
      parts.push(sseEvent("response.reasoning_summary_text.done", {
        type: "response.reasoning_summary_text.done",
        item_id: reasoning.id,
        output_index: reasoning.outputIndex,
        summary_index: reasoning.summaryIndex,
        text: reasoning.textAcc,
      }));
      parts.push(sseEvent("response.reasoning_summary_part.done", {
        type: "response.reasoning_summary_part.done",
        item_id: reasoning.id,
        output_index: reasoning.outputIndex,
        summary_index: reasoning.summaryIndex,
        part,
      }));
      reasoning.partOpen = false;
    }
    output[reasoning.outputIndex].status = "completed";
    parts.push(sseEvent("response.output_item.done", {
      type: "response.output_item.done",
      output_index: reasoning.outputIndex,
      item: output[reasoning.outputIndex],
    }));
    reasoning = null;
    return parts.join("");
  }

  function openTool(anthIdx, block) {
    const item = {
      type: "function_call",
      id: rid("fc"),
      call_id: block.id || rid("call"),
      name: block.name || "",
      arguments: "",
      status: "in_progress",
    };
    const outputIndex = nextOutputIndex++;
    output[outputIndex] = item;
    tools.set(anthIdx, { id: item.id, outputIndex, argsAcc: "" });
    return sseEvent("response.output_item.added", {
      type: "response.output_item.added",
      output_index: outputIndex,
      item,
    });
  }
  function emitToolDelta(anthIdx, delta) {
    const st = tools.get(anthIdx);
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
  function closeTool(anthIdx) {
    const st = tools.get(anthIdx);
    if (!st) return "";
    const parts = [];
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
    tools.delete(anthIdx);
    return parts.join("");
  }
  function closeAllOpen() {
    const parts = [];
    if (reasoning) parts.push(closeReasoning());
    if (msg) parts.push(closeMessage());
    for (const idx of Array.from(tools.keys())) parts.push(closeTool(idx));
    return parts.join("");
  }

  function translate(line) {
    if (!line || typeof line !== "string" || !line.startsWith("data: ")) return "";
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") return "";
    let evt;
    try { evt = JSON.parse(payload); } catch { return ""; }
    const type = evt.type;
    const parts = [];

    if (type === "message_start") {
      if (evt.message?.model) upstreamModel = evt.message.model;
      updateUsage(evt);
      parts.push(lifecycle());
      return parts.join("");
    }
    if (type === "ping") return "";
    if (type === "error") {
      const message = evt.error?.message || "Anthropic stream error";
      return finalize(new Error(message));
    }

    parts.push(lifecycle());

    if (type === "content_block_start") {
      const idx = typeof evt.index === "number" ? evt.index : 0;
      const block = evt.content_block || {};
      blockType.set(idx, block.type || "");
      if (block.type === "thinking") {
        if (msg) parts.push(closeMessage());
        if (!reasoning) parts.push(openReasoning());
        if (!reasoning.partOpen) parts.push(openReasoningPart());
        if (block.thinking) parts.push(emitReasoningDelta(block.thinking));
      } else if (block.type === "text") {
        if (reasoning) parts.push(closeReasoning());
        if (!msg) parts.push(openMessage());
        if (!msg.partOpen) parts.push(openTextPart());
        if (block.text) parts.push(emitTextDelta(block.text));
      } else if (block.type === "tool_use") {
        if (reasoning) parts.push(closeReasoning());
        if (msg) parts.push(closeMessage());
        parts.push(openTool(idx, block));
        if (block.input && Object.keys(block.input).length > 0) {
          parts.push(emitToolDelta(idx, JSON.stringify(block.input)));
        }
      }
      return parts.join("");
    }

    if (type === "content_block_delta") {
      const idx = typeof evt.index === "number" ? evt.index : 0;
      const delta = evt.delta || {};
      if (delta.type === "thinking_delta" && delta.thinking) {
        if (!reasoning) parts.push(openReasoning());
        if (!reasoning.partOpen) parts.push(openReasoningPart());
        parts.push(emitReasoningDelta(delta.thinking));
      } else if (delta.type === "text_delta" && delta.text) {
        if (!msg) parts.push(openMessage());
        if (!msg.partOpen) parts.push(openTextPart());
        parts.push(emitTextDelta(delta.text));
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        if (!tools.has(idx)) {
          parts.push(openTool(idx, { id: rid("call"), name: "" }));
        }
        parts.push(emitToolDelta(idx, delta.partial_json));
      }
      return parts.join("");
    }

    if (type === "content_block_stop") {
      const idx = typeof evt.index === "number" ? evt.index : 0;
      const bt = blockType.get(idx);
      if (bt === "thinking") parts.push(closeReasoning());
      else if (bt === "text") parts.push(closeTextPart());
      else if (bt === "tool_use") parts.push(closeTool(idx));
      blockType.delete(idx);
      return parts.join("");
    }

    if (type === "message_delta") {
      updateUsage(evt);
      if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      parts.push(closeAllOpen());
      return parts.join("");
    }

    if (type === "message_stop") {
      parts.push(finalize());
      return parts.join("");
    }

    return parts.join("");
  }

  function finalize(err) {
    if (finalEmitted) return "";
    finalEmitted = true;
    const parts = [];
    if (!createdEmitted) parts.push(lifecycle());
    parts.push(closeAllOpen());
    if (err) {
      const snap = snapshot("failed");
      snap.error = { message: err.message || String(err), type: "upstream_error" };
      parts.push(sseEvent("response.failed", { type: "response.failed", response: snap }));
    } else {
      const statusDetails = mapAnthropicStopToResponsesStatus(stopReason);
      const snap = snapshot(statusDetails.status, statusDetails.incomplete_details);
      const eventType = statusDetails.status === "incomplete" ? "response.incomplete" : "response.completed";
      parts.push(sseEvent(eventType, { type: eventType, response: snap }));
    }
    return parts.join("");
  }

  return {
    translate,
    finalize,
    getUsage() { return normalizeUsage(usageRaw()); },
  };
}

module.exports = {
  responsesBodyToAnthropic,
  anthropicResponseToResponses,
  createAnthropicToResponsesSSETranslator,
  // exposed for tests
  _responsesContentToAnthropicBlocks: responsesContentToAnthropicBlocks,
};
