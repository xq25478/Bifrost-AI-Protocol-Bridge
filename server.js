const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Agent: UndiciAgent, request: undiciRequest } = require("undici");

// ============================================================
// Config
// ============================================================

const PORT = 31009;
const TIMEOUT = 300000;
const MAX_BODY_SIZE = 32 * 1024 * 1024;
const LOCAL_KEEP_ALIVE_TIMEOUT = 65000;
const LOCAL_HEADERS_TIMEOUT = 66000;
const BACKENDS_PATH = path.join(__dirname, "backends.json");

const HOP_BY_HOP = new Set([
  "transfer-encoding", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "upgrade"
]);

const DEFAULT_THINKING_EFFORT = "max";
const SUPPORTED_THINKING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// ============================================================
// Logger — structured, levelled, TTY-aware
// ============================================================

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 20;
const LOG_COLORS = { debug: "\x1b[90m", info: "\x1b[0m", warn: "\x1b[33m", error: "\x1b[31m" };
const LOG_RESET = "\x1b[0m";
const COLOR_DIM = "\x1b[90m";
const COLOR_GREEN = "\x1b[32m";
const COLOR_CYAN = "\x1b[36m";

const EVENT_LABEL = {
  recv: "recv",
  route: "route",
  done: "done",
  error: "error",
  count_tokens: "count_tokens",
  system: "system",
};


function colorStatus(status) {
  const s = String(status);
  if (s.startsWith("2")) return COLOR_GREEN + s + LOG_RESET;
  if (s.startsWith("4") || s.startsWith("5")) return "\x1b[31m" + s + LOG_RESET;
  return s;
}

function writelog(entry) {
  const levelNum = LOG_LEVELS[entry.level];
  if (levelNum < LOG_THRESHOLD && entry.rid !== "system") return;
  if (process.stdout.isTTY) {
    const color = LOG_COLORS[entry.level] || "";
    const ts = entry.ts.slice(11, 19);
    const eventLabel = EVENT_LABEL[entry.event] || entry.event;

    const fragments = [`${COLOR_DIM}[${ts}]${LOG_RESET}`];

    if (entry.event) {
      fragments.push(`${COLOR_CYAN}${eventLabel}${LOG_RESET}`);
    }

    if (entry.rid && entry.rid !== "system") {
      fragments.push(`${COLOR_DIM}${entry.rid}${LOG_RESET}`);
    }

    if (entry.method) fragments.push(entry.method);
    if (entry.path) fragments.push(entry.path);

    if (entry.status !== undefined) {
      fragments.push(`status=${colorStatus(entry.status)}`);
    }

    if (entry.elapsed !== undefined) {
      fragments.push(`${COLOR_DIM}elapsed=${entry.elapsed}ms${LOG_RESET}`);
    }

    if (entry.backend) fragments.push(`backend=${entry.backend}`);
    if (entry.model) fragments.push(`model=${entry.model}`);

    if (entry.err) fragments.push(`${color}err=${entry.err}${LOG_RESET}`);

    if (entry.msg) fragments.push(`${color}${entry.msg}${LOG_RESET}`);


    const out = fragments.join(" ");
    if (entry.level === "error" || entry.level === "warn") {
      console.error(out);
    } else {
      console.log(out);
    }
  } else {
    console.log(JSON.stringify(entry));
  }
}

function system(level, msg, extra = {}) {
  writelog({ ts: new Date().toISOString(), level, rid: "system", event: "system", ...extra, msg });
}

function requestlog(rid, method, path) {
  if (!rid) {
    return { on() {}, end() {}, err() {}, mute() {}, _start: 0 };
  }
  const start = Date.now();
  const base = { ts: new Date().toISOString(), rid, method, path, event: "recv" };
  let muted = false;
  const self = {
    _start: start,
    on(event, extra = {}) {
      if (muted) return;
      writelog({ ...base, event, elapsed: Date.now() - start, ...extra });
    },
    end(status, extra = {}) {
      if (muted) return;
      const elapsed = Date.now() - start;
      const sc = String(status)[0];
      if (sc === "2") incMetric("status_2xx");
      else if (sc === "4") incMetric("status_4xx");
      else if (sc === "5") incMetric("status_5xx");
      recordLatency(elapsed);
      writelog({ ...base, event: "done", status, elapsed, ...extra });
    },
    err(status, err, extra = {}) {
      if (muted) return;
      writelog({
        ...base, event: "error", level: "error", status,
        elapsed: Date.now() - start, err: err.message, ...extra
      });
    },
    mute() { muted = true; }
  };
  if (!method || !path) return self;
  writelog(base);
  return self;
}

// ============================================================
// Metrics
// ============================================================

const LATENCY_RING_SIZE = 1000;
const latencyRing = new Int32Array(LATENCY_RING_SIZE);
let latencyLen = 0;
let latencyWrite = 0;

const metrics = {
  requests_total: 0,
  status_2xx: 0, status_4xx: 0, status_5xx: 0,
  upstream_errors: 0,
};

function incMetric(key, n = 1) { metrics[key] += n; }

function recordLatency(ms) {
  latencyRing[latencyWrite] = ms;
  latencyWrite = (latencyWrite + 1) % LATENCY_RING_SIZE;
  if (latencyLen < LATENCY_RING_SIZE) latencyLen++;
}

function metricPercentile(p) {
  if (latencyLen === 0) return 0;
  const arr = latencyRing.slice(0, latencyLen);
  arr.sort();
  return arr[Math.floor(latencyLen * p)] || 0;
}

function metricsSnapshot() {
  return {
    requests: metrics.requests_total,
    status: { "2xx": metrics.status_2xx, "4xx": metrics.status_4xx, "5xx": metrics.status_5xx },
    upstream_errors: metrics.upstream_errors,
    latency_p50: metricPercentile(0.5),
    latency_p95: metricPercentile(0.95),
    latency_p99: metricPercentile(0.99),
  };
}

// ============================================================
// Backend registry
// ============================================================

let backends = [];
let modelIndex = {};
let modelList = [];
let availableModelsStr = "";

const dispatcher = new UndiciAgent({
  connections: 256,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 10_000 },
  bodyTimeout: TIMEOUT,
  headersTimeout: TIMEOUT,
});

function upstreamErrStatus(err) {
  if (!err) return 502;
  if (err.name === "AbortError") return 504;
  const code = err.code;
  if (code === "UND_ERR_ABORTED" || code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return 504;
  return 502;
}

// ============================================================
// In-flight upstream tracking (for shutdown) + circuit breaker
// ============================================================

const inFlightAbortControllers = new Set();

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 10_000;

function isCircuitOpen(backend) {
  return !!(backend.circuitOpenUntil && Date.now() < backend.circuitOpenUntil);
}

function onBackendError(backend) {
  backend.consecutiveErrors = (backend.consecutiveErrors || 0) + 1;
  if (backend.consecutiveErrors >= CIRCUIT_THRESHOLD && !isCircuitOpen(backend)) {
    backend.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    system("warn", `circuit opened for backend ${backend.provider} after ${backend.consecutiveErrors} consecutive errors`,
      { backend: backend.provider });
  }
}

function onBackendSuccess(backend) {
  if (backend.consecutiveErrors || backend.circuitOpenUntil) {
    backend.consecutiveErrors = 0;
    backend.circuitOpenUntil = 0;
  }
}

function recordBackendOutcome(backend, statusCode) {
  if ((statusCode || 0) >= 500) onBackendError(backend);
  else onBackendSuccess(backend);
}

// ============================================================
// Upstream call helper — handles abort, timeout, retry on transient errors
// ============================================================

const RETRYABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNREFUSED", "EAI_AGAIN"
]);

function isTransientConnectError(err) {
  return !!(err && RETRYABLE_CODES.has(err.code));
}

async function doUpstream(url, options, backend) {
  const ac = new AbortController();
  inFlightAbortControllers.add(ac);
  const timeout = setTimeout(() => ac.abort("timeout"), TIMEOUT);
  const finish = () => {
    clearTimeout(timeout);
    inFlightAbortControllers.delete(ac);
  };
  const call = () => undiciRequest(url, { ...options, signal: ac.signal, dispatcher });

  let r;
  try {
    r = await call();
  } catch (err) {
    if (isTransientConnectError(err) && !ac.signal.aborted) {
      try {
        r = await call();
      } catch (err2) {
        finish();
        onBackendError(backend);
        throw err2;
      }
    } else {
      finish();
      onBackendError(backend);
      throw err;
    }
  }
  return { statusCode: r.statusCode, headers: r.headers, body: r.body, finish, signal: ac.signal };
}

function loadBackends() {
  try {
    const raw = fs.readFileSync(BACKENDS_PATH, "utf8");
    const configs = JSON.parse(raw);

    backends = configs.map((cfg, idx) => ({ ...cfg, index: idx }));

    modelIndex = {};
    modelList = [];

    for (const backend of backends) {
      for (let mi = 0; mi < backend.models.length; mi++) {
        const modelId = backend.models[mi];
        if (modelIndex[modelId]) {
          system("warn", `duplicate model id "${modelId}" in ${backend.provider} — first occurrence in ${modelIndex[modelId].backend.provider} wins, skipped`,
            { backend: backend.provider, model: modelId });
          continue;
        }
        modelIndex[modelId] = { backend, modelId };
        modelList.push({
          id: modelId,
          type: "model",
          display_name: modelId,
          created_at: "2026-01-01T00:00:00Z"
        });
      }
    }

    system("info", `loaded ${backends.length} backends, ${modelList.length} models`);
    availableModelsStr = modelList.map(m => m.id).join(", ");
    return true;
  } catch (err) {
    system("error", `failed to load backends: ${err.message}`);
    return false;
  }
}

loadBackends();

// ============================================================
// Thinking normalization
// ============================================================

function normalizeThinkingEffort(value) {
  if (typeof value !== "string") return null;
  const n = value.trim().toLowerCase();
  if (!n) return null;
  return SUPPORTED_THINKING_EFFORTS.has(n) ? n : DEFAULT_THINKING_EFFORT;
}

function normalizeThinking(body) {
  if (!body || typeof body !== "object") return body;

  // thinking.enabled is not supported by AWS Bedrock; convert to adaptive or drop entirely
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

// ============================================================
// Token estimation (keep original logic for count_tokens)
// ============================================================

const TOKEN_ESTIMATE_OVERHEAD = 8;
const TEXT_TOKEN_DIVISOR = 4;
const IMAGE_TOKEN_DIVISOR = 1024;
const DOCUMENT_TOKEN_DIVISOR = 512;

function estimateTextTokens(text) {
  return Math.max(1, Math.ceil(Buffer.byteLength(String(text), "utf8") / TEXT_TOKEN_DIVISOR));
}

function estimateBinaryTokens(data, divisor, minimum) {
  return Math.max(minimum, Math.ceil(String(data).length / divisor));
}

function estimateValueTokens(value, depth = 0) {
  if (depth > 50) return 0;
  if (value == null) return 0;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return estimateTextTokens(value);
  }
  if (Array.isArray(value)) {
    return value.reduce((t, item) => t + estimateValueTokens(item, depth + 1), value.length);
  }
  if (typeof value !== "object") return 0;

  if (value.type === "image" && value.source?.data) {
    return estimateBinaryTokens(value.source.data, IMAGE_TOKEN_DIVISOR, 85);
  }
  if (value.type === "document" && value.source?.data) {
    return estimateBinaryTokens(value.source.data, DOCUMENT_TOKEN_DIVISOR, 128);
  }

  let total = 1;
  const skipKeys = new Set(["model", "max_tokens", "max_output_tokens", "stream", "output_config"]);
  for (const [key, nested] of Object.entries(value)) {
    if (!skipKeys.has(key)) {
      total += estimateValueTokens(nested, depth + 1);
    }
  }
  return total;
}

function estimatePayloadTokens(body) {
  const fields = ["system", "messages", "tools", "tool_choice", "mcp_servers", "container", "context_management", "metadata", "input", "prompt"];
  let total = 0;
  for (const field of fields) {
    if (body[field] !== undefined) total += estimateValueTokens(body[field]);
  }
  return Math.max(1, total + TOKEN_ESTIMATE_OVERHEAD);
}

// ============================================================
// Anthropic <-> OpenAI format converter
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

    if (msg.role === "assistant") {
      const texts = [];
      const toolCalls = [];
      for (const block of msg.content) {
        if (block.type === "text") texts.push(block.text || "");
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id || `call_${toolCalls.length}`,
            type: "function",
            function: {
              name: block.name || "",
              arguments: JSON.stringify(block.input || {})
            }
          });
        }
      }
      const out = { role: "assistant", content: texts.join("") };
      if (toolCalls.length > 0) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }

    if (msg.role === "user") {
      const toolResults = msg.content.filter(b => b.type === "tool_result");
      const others = msg.content.filter(b => b.type !== "tool_result");

      for (const tr of toolResults) {
        let content = tr.content;
        if (Array.isArray(content)) {
          content = content.map(c => c.type === "text" ? c.text : JSON.stringify(c)).join("");
        } else if (typeof content !== "string") {
          content = JSON.stringify(content ?? "");
        }
        messages.push({
          role: "tool",
          tool_call_id: tr.tool_use_id || "",
          content: content || ""
        });
      }

      if (others.length > 0) {
        const parts = others.map(block => {
          if (block.type === "text") return { type: "text", text: block.text || "" };
          if (block.type === "image") {
            const src = block.source || {};
            if (src.type === "base64") {
              return { type: "image_url", image_url: { url: `data:${src.media_type};base64,${src.data}` } };
            }
            if (src.type === "url") {
              return { type: "image_url", image_url: { url: src.url } };
            }
          }
          return { type: "text", text: JSON.stringify(block) };
        });
        const allText = parts.every(p => p.type === "text");
        messages.push({
          role: "user",
          content: allText ? parts.map(p => p.text).join("") : parts
        });
      }
      continue;
    }

    const texts = msg.content.map(b => b.type === "text" ? (b.text || "") : "").join("");
    messages.push({ role: msg.role, content: texts });
  }

  const req = {
    model: body.model,
    messages,
    max_tokens: body.max_tokens || 4096,
    stream: body.stream === true
  };
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
  }
  return req;
}

function openaiChatResponseToAnthropic(openaiRes) {
  const choice = openaiRes.choices?.[0];
  const msg = choice?.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
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

  return {
    id: openaiRes.id || "msg_" + crypto.randomUUID(),
    type: "message",
    role: "assistant",
    model: openaiRes.model || "",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: openaiRes.usage
      ? { input_tokens: openaiRes.usage.prompt_tokens || 0, output_tokens: openaiRes.usage.completion_tokens || 0 }
      : { input_tokens: 0, output_tokens: 0 }
  };
}

// Stateful translator: OpenAI Chat SSE -> Anthropic Messages SSE.
// Tracks open content blocks (one text block + N tool_use blocks) so that
// content_block_start / input_json_delta / content_block_stop events are
// emitted in the right order with consistent indices.
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

      if (typeof delta.content === "string" && delta.content.length > 0) {
        if (!textOpen) parts.push(openText());
        parts.push(`data: ${JSON.stringify({
          type: "content_block_delta", index: textIndex,
          delta: { type: "text_delta", text: delta.content }
        })}\n\n`);
      }

      if (Array.isArray(delta.tool_calls)) {
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
          usage: { output_tokens: usage?.completion_tokens || 0 }
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
        usage: { output_tokens: usage?.completion_tokens || 0 }
      })}\n\n`);
      parts.push(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
      return parts.join("");
    }
  };
}

async function proxyOpenAIChat(req, res, ctx, backend, body) {
  const openaiBody = anthropicBodyToOpenAIChat(body);
  const openaiBuf = Buffer.from(JSON.stringify(openaiBody));

  const backendUrl = new URL("/v1/chat/completions", backend.baseUrl.replace("/v1", ""));

  const headers = {
    "content-type": "application/json",
    "content-length": openaiBuf.length,
    "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
    host: backendUrl.host
  };

  let up;
  try {
    up = await doUpstream(backendUrl, { method: "POST", headers, body: openaiBuf }, backend);
  } catch (err) {
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    return json(res, status, { error: String(err) });
  }

  const { statusCode, body: upstreamBody, finish } = up;

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*"
    });
    const msgId = "msg_" + crypto.randomUUID();
    const model = body.model || "";
    const translator = createOpenAIToAnthropicSSETranslator(msgId, model);
    let buf = null;
    let doneSent = false;

    upstreamBody.on("data", chunk => {
      buf = buf ? Buffer.concat([buf, chunk], buf.length + chunk.length) : chunk;
      const outs = [];
      let nl;
      while ((nl = buf.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buf[nl - 1] === 0x0D ? nl - 1 : nl;
        const line = buf.subarray(0, end);
        buf = buf.subarray(nl + 1);
        if (line.length < 6 ||
            line[0] !== 0x64 || line[1] !== 0x61 || line[2] !== 0x74 ||
            line[3] !== 0x61 || line[4] !== 0x3A || line[5] !== 0x20) continue;
        const d = line.subarray(6).toString("utf8").trim();
        if (!d) continue;
        if (d === "[DONE]") {
          const tail = translator.finalize();
          if (tail) outs.push(tail);
          outs.push("data: [DONE]\n\n");
          doneSent = true;
          continue;
        }
        try {
          const openaiChunk = JSON.parse(d);
          const out = translator.translate(openaiChunk);
          if (out) outs.push(out);
        } catch {}
      }
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      if (!doneSent) {
        const tail = translator.finalize();
        if (tail) res.write(tail);
        res.write("data: [DONE]\n\n");
      }
      res.end();
      recordBackendOutcome(backend, statusCode);
      ctx.end(200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      finish();
      onBackendError(backend);
      incMetric("upstream_errors");
      const status = upstreamErrStatus(err);
      ctx.err(status, err, { backend: backend.provider });
      if (res.headersSent) { res.destroy(); return; }
      json(res, status, { error: String(err) });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      try {
        const openaiResp = JSON.parse(Buffer.concat(responseChunks, responseLen).toString("utf8"));
        const anthropicResp = openaiChatResponseToAnthropic(openaiResp);
        json(res, statusCode || 200, anthropicResp);
      } catch {
        json(res, 502, { error: "Failed to convert OpenAI response to Anthropic format" });
      }
      recordBackendOutcome(backend, statusCode);
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      finish();
      onBackendError(backend);
      incMetric("upstream_errors");
      const status = upstreamErrStatus(err);
      ctx.err(status, err, { backend: backend.provider });
      if (res.headersSent) { res.destroy(); return; }
      json(res, status, { error: String(err) });
    });
  }
}

// proxyOpenAIDirect — pure passthrough: OpenAI client → Gateway → OpenAI backend
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
    else if (body.tool_choice === "none") req.tool_choice = { type: "none" };
    else if (typeof body.tool_choice === "object") req.tool_choice = { type: "tool", name: body.tool_choice.function?.name || "" };
  }
  return req;
}

function anthropicResponseToOpenAIChat(anthropicRes) {
  const content = anthropicRes.content || [];
  const textParts = content.filter(b => b.type === "text").map(b => b.text);
  const toolParts = content.filter(b => b.type === "tool_use");

  const message = { role: "assistant", content: textParts.join("") };
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
    usage: anthropicRes.usage
      ? { prompt_tokens: anthropicRes.usage.input_tokens || 0, completion_tokens: anthropicRes.usage.output_tokens || 0, total_tokens: (anthropicRes.usage.input_tokens || 0) + (anthropicRes.usage.output_tokens || 0) }
      : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  };
}

function anthropicSSEToOpenAISSE(line, chatId, model) {
  if (!line.startsWith("data: ")) return "";
  const payload = line.slice(6).trim();
  if (payload === "[DONE]") return "data: [DONE]\n\n";

  let evt;
  try { evt = JSON.parse(payload); } catch { return ""; }

  const now = Math.floor(Date.now() / 1000);

  if (evt.type === "message_start") {
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
    const d = evt.delta || {};
    const usage = evt.usage || {};
    let finishReason = null;
    if (d.stop_reason) {
      if (d.stop_reason === "end_turn" || d.stop_reason === "stop") finishReason = "stop";
      else if (d.stop_reason === "tool_use") finishReason = "tool_calls";
      else if (d.stop_reason === "max_tokens") finishReason = "length";
      else finishReason = d.stop_reason;
    }
    return `data: ${JSON.stringify({
      id: chatId, object: "chat.completion.chunk", created: now, model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
      usage: { prompt_tokens: 0, completion_tokens: usage.output_tokens || 0, total_tokens: usage.output_tokens || 0 }
    })}\n\n`;
  }

  if (evt.type === "message_stop") {
    return "data: [DONE]\n\n";
  }

  return "";
}

async function proxyAnthropicAsOpenAI(req, res, ctx, backend, parsedBody) {
  const anthropicBody = openaiBodyToAnthropic(parsedBody);
  normalizeThinking(anthropicBody);

  const suffix = "/v1/messages";
  const fullUrl = backend.baseUrl.replace(/\/+$/, "") + suffix;
  const upstreamUrl = new URL(fullUrl);
  if (upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.delete("beta");

  const bodyBuf = Buffer.from(JSON.stringify(anthropicBody));

  const headers = {
    "content-type": "application/json",
    "content-length": bodyBuf.length,
    "anthropic-version": "2023-06-01",
    "x-api-key": resolveApiKey(req, backend.apiKey),
    host: upstreamUrl.host
  };

  let up;
  try {
    up = await doUpstream(upstreamUrl, { method: "POST", headers, body: bodyBuf }, backend);
  } catch (err) {
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    return json(res, status, { error: { message: String(err), type: "upstream_error", code: status } });
  }

  const { statusCode, body: upstreamBody, finish } = up;

  if (anthropicBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "access-control-allow-origin": "*"
    });
    const chatId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const model = anthropicBody.model || "";

    let buffer = null;
    upstreamBody.on("data", chunk => {
      buffer = buffer ? Buffer.concat([buffer, chunk], buffer.length + chunk.length) : chunk;
      const outs = [];
      let nl;
      while ((nl = buffer.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buffer[nl - 1] === 0x0D ? nl - 1 : nl;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        const converted = anthropicSSEToOpenAISSE(line, chatId, model);
        if (converted) outs.push(converted);
      }
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      if (buffer && buffer.length > 0) {
        const end = buffer[buffer.length - 1] === 0x0D ? buffer.length - 1 : buffer.length;
        const line = buffer.subarray(0, end).toString("utf8");
        const converted = anthropicSSEToOpenAISSE(line, chatId, model);
        if (converted) res.write(converted);
      }
      res.end();
      recordBackendOutcome(backend, statusCode);
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      finish();
      onBackendError(backend);
      incMetric("upstream_errors");
      const status = upstreamErrStatus(err);
      ctx.err(status, err, { backend: backend.provider });
      if (res.headersSent) { res.destroy(); return; }
      json(res, status, { error: { message: String(err), type: "upstream_error", code: status } });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      try {
        const anthropicResp = JSON.parse(Buffer.concat(responseChunks, responseLen).toString("utf8"));
        const openaiResp = anthropicResponseToOpenAIChat(anthropicResp);
        json(res, statusCode || 200, openaiResp);
      } catch {
        json(res, 502, { error: "Failed to convert Anthropic response to OpenAI format" });
      }
      recordBackendOutcome(backend, statusCode);
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      finish();
      onBackendError(backend);
      incMetric("upstream_errors");
      const status = upstreamErrStatus(err);
      ctx.err(status, err, { backend: backend.provider });
      if (res.headersSent) { res.destroy(); return; }
      json(res, status, { error: { message: String(err), type: "upstream_error", code: status } });
    });
  }
}

async function proxyOpenAIDirect(req, res, ctx, backend, parsedBody, bodyStr) {
  const backendUrl = new URL("/v1/chat/completions", backend.baseUrl.replace("/v1", ""));
  const bodyBuf = Buffer.from(bodyStr);

  const headers = {
    "content-type": "application/json",
    "content-length": bodyBuf.length,
    "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
    host: backendUrl.host
  };

  let up;
  try {
    up = await doUpstream(backendUrl, { method: "POST", headers, body: bodyBuf }, backend);
  } catch (err) {
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    return json(res, status, { error: String(err) });
  }

  const { statusCode, headers: resHeaders, body: upstreamBody, finish } = up;
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) cleanHeaders[k] = v;
  }
  res.writeHead(statusCode || 502, cleanHeaders);
  res.on("close", () => { finish(); });
  upstreamBody.pipe(res);
  upstreamBody.on("end", () => {
    recordBackendOutcome(backend, statusCode);
    ctx.end(statusCode || 502, { backend: backend.provider });
    finish();
  });
  upstreamBody.on("error", err => {
    finish();
    onBackendError(backend);
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    json(res, status, { error: String(err) });
  });
}

// ============================================================
// HTTP helpers
// ============================================================

function json(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,HEAD,OPTIONS"
  });
  res.end(JSON.stringify(obj));
}

function resolveApiKey(req, backendApiKey) {
  if (backendApiKey) return backendApiKey;
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

async function proxyRequest(req, res, ctx, backend, requestPath, bodyStr) {
  const suffix = requestPath.replace(/^\/anthropic/, "") || "/";
  const fullUrl = backend.baseUrl.replace(/\/+$/, "") + suffix;
  const upstreamUrl = new URL(fullUrl);
  if (upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.delete("beta");

  const bodyBuf = bodyStr ? Buffer.from(bodyStr) : undefined;

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower) || lower === "anthropic-beta" || lower === "content-length") continue;
    headers[k] = v;
  }
  headers.host = upstreamUrl.host;
  headers["x-api-key"] = resolveApiKey(req, backend.apiKey);
  if (bodyBuf) headers["content-length"] = bodyBuf.length;

  let up;
  try {
    up = await doUpstream(upstreamUrl, { method: req.method, headers, body: bodyBuf }, backend);
  } catch (err) {
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    return json(res, status, { error: String(err) });
  }

  const { statusCode, headers: resHeaders, body: upstreamBody, finish } = up;
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) cleanHeaders[k] = v;
  }
  res.writeHead(statusCode || 502, cleanHeaders);
  res.on("close", () => { finish(); });
  upstreamBody.pipe(res);
  upstreamBody.on("end", () => {
    recordBackendOutcome(backend, statusCode);
    ctx.end(statusCode || 502, { backend: backend.provider });
    finish();
  });
  upstreamBody.on("error", err => {
    finish();
    onBackendError(backend);
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    json(res, status, { error: String(err) });
  });
}

// ============================================================
// Main server
// ============================================================

const server = http.createServer((req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const requestPath = requestUrl.pathname;
  const isHealth = (requestPath === "/" || requestPath === "/anthropic") && (req.method === "GET" || req.method === "HEAD");
  const ctx = requestlog(isHealth ? "" : requestId, req.method, req.url);

  if (!isHealth) incMetric("requests_total");

  // CORS
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET,POST,HEAD,OPTIONS"
    });
    res.end();
    ctx.mute();
    return;
  }

  // Health check
  if (req.method === "HEAD" && (requestPath === "/" || requestPath === "/anthropic")) {
    res.writeHead(200);
    res.end();
    ctx.mute();
    return;
  }
  if (req.method === "GET" && (requestPath === "/" || requestPath === "/anthropic")) {
    ctx.end(200);
    return json(res, 200, { ok: true, backends: backends.length, models: modelList.length });
  }

  // Dashboard API (available via Caddy reverse proxy)
  if (req.method === "GET" && requestPath === "/dashboard/api") {
    const from = parseInt(requestUrl.searchParams.get("from") || "0", 10);
    const to = parseInt(requestUrl.searchParams.get("to") || String(Date.now()), 10);
    const totals = (store && store.queryTotals) ? store.queryTotals(from, to) : null;
    const models = (store && store.queryAggregated) ? store.queryAggregated(from, to) : [];
    const body = { totals: totals || {}, models: models || [] };
    if (!store) body._store_unavailable = true;
    ctx.end(200);
    return json(res, 200, body);
  }

  // Dashboard page (available via Caddy reverse proxy)
  if (req.method === "GET" && requestPath === "/dashboard") {
    const { dashboardHtml } = require("./src/dashboard_html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
    ctx.end(200);
    return res.end(dashboardHtml());
  }

  // Metrics endpoint
  if (req.method === "GET" && requestPath === "/anthropic/v1/metrics") {
    ctx.end(200);
    return json(res, 200, metricsSnapshot());
  }

  // Model listing
  if (req.method === "GET" && requestPath === "/anthropic/v1/models") {
    ctx.end(200);
    return json(res, 200, { data: modelList, has_more: false, first_id: modelList[0]?.id || "", last_id: modelList[modelList.length - 1]?.id || "" });
  }

  // Single model detail
  if (req.method === "GET" && requestPath.startsWith("/anthropic/v1/models/")) {
    const modelId = requestPath.slice("/anthropic/v1/models/".length);
    const found = modelIndex[modelId];
    if (found) {
      ctx.end(200, { model: modelId });
      return json(res, 200, { id: modelId, type: "model", display_name: modelId, created_at: "2026-01-01T00:00:00Z" });
    }
    ctx.end(404, { model: modelId });
    return json(res, 404, { error: { type: "not_found", message: "Model not found" } });
  }

  // Only POST beyond this point
  if (req.method !== "POST") {
    ctx.end(405);
    return json(res, 405, { error: { type: "method_not_allowed", message: "Method not allowed" } });
  }

  const bodyChunks = [];
  let bodySize = 0;
  let bodyExceeded = false;
  req.on("data", chunk => {
    if (bodyExceeded) return;
    bodySize += chunk.length;
    if (bodySize > MAX_BODY_SIZE) {
      bodyExceeded = true;
      req.destroy();
      ctx.err(413, new Error("payload too large"));
      if (!res.headersSent) json(res, 413, { error: { type: "invalid_request_error", message: "Request body exceeds 32 MB limit" } });
      else res.destroy();
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on("end", () => {
    const bodyBuf = bodySize === 0 ? null : Buffer.concat(bodyChunks, bodySize);

    // count_tokens
    if (requestPath === "/anthropic/v1/messages/count_tokens") {
      try {
        if (!bodyBuf) throw new Error("empty body");
        const parsed = JSON.parse(bodyBuf);
        normalizeThinking(parsed);
        const response = { input_tokens: estimatePayloadTokens(parsed) };
        ctx.on("count_tokens", { msg: `input_tokens=${response.input_tokens}` });
        ctx.end(200);
        return json(res, 200, response);
      } catch (err) {
        ctx.err(400, err);
        return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
      }
    }

    // OpenAI-native chat/completions: pure passthrough
    if (requestPath === "/anthropic/v1/chat/completions") {
      if (!bodyBuf) {
        ctx.end(400, { msg: "body required" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Request body is required" } });
      }

      let parsedBody;
      try { parsedBody = JSON.parse(bodyBuf); } catch {
        ctx.end(400, { msg: "invalid JSON" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
      }

      const modelId = parsedBody.model;
      const route = modelIndex[modelId];
      if (!route) {
        ctx.end(404, { model: modelId, msg: "not found" });
        return json(res, 404, { error: { type: "not_found", message: `Model "${modelId}" not found. Available: ${availableModelsStr}` } });
      }

      const { backend, modelId: backendModelId } = route;
      parsedBody.model = backendModelId;
      ctx.on("route", { backend: backend.provider, model: modelId });

      if (isCircuitOpen(backend)) {
        ctx.end(503, { backend: backend.provider, msg: "circuit open" });
        return json(res, 503, { error: { type: "backend_unavailable", message: `Backend ${backend.provider} is temporarily unavailable` } });
      }

      if (backend.type === "openai") {
        const bodyStr = JSON.stringify(parsedBody);
        return proxyOpenAIDirect(req, res, ctx, backend, parsedBody, bodyStr);
      }

      return proxyAnthropicAsOpenAI(req, res, ctx, backend, parsedBody);
    }

    // messages endpoint
    if (requestPath.startsWith("/anthropic/v1/messages")) {
      if (!bodyBuf) {
        ctx.end(400, { msg: "body required" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Request body is required" } });
      }

      let parsedBody;
      try { parsedBody = JSON.parse(bodyBuf); } catch {
        ctx.end(400, { msg: "invalid JSON" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
      }

      const modelId = parsedBody.model;
      const route = modelIndex[modelId];

      if (!route) {
        ctx.end(404, { model: modelId, msg: "not found" });
        return json(res, 404, { error: { type: "not_found", message: `Model "${modelId}" not found. Available: ${availableModelsStr}` } });
      }

      const { backend, modelId: backendModelId } = route;

      parsedBody.model = backendModelId;
      normalizeThinking(parsedBody);

      ctx.on("route", { backend: backend.provider, model: modelId });

      if (isCircuitOpen(backend)) {
        ctx.end(503, { backend: backend.provider, msg: "circuit open" });
        return json(res, 503, { error: { type: "backend_unavailable", message: `Backend ${backend.provider} is temporarily unavailable` } });
      }

      if (backend.type === "openai") {
        return proxyOpenAIChat(req, res, ctx, backend, parsedBody);
      }

      proxyRequest(req, res, ctx, backend, requestPath, JSON.stringify(parsedBody));
      return;
    }

    // Unknown path
    ctx.end(404);
    json(res, 404, { error: { type: "not_found", message: "Not found" } });
  });
});

server.keepAliveTimeout = LOCAL_KEEP_ALIVE_TIMEOUT;
server.headersTimeout = LOCAL_HEADERS_TIMEOUT;
server.requestTimeout = TIMEOUT;

server.listen(PORT, "127.0.0.1", () => {
  system("info", `listening on http://127.0.0.1:${PORT} (gateway — API only, not a browser URL)`);
  system("info", `dashboard at http://127.0.0.1:${PORT}/dashboard`);
});

server.on("error", err => {
  system("error", `server error: ${err.message}`);
  if (err.code === "EADDRINUSE" || err.code === "EACCES") process.exit(1);
});

// ============================================================
// Graceful shutdown
// ============================================================

let closing = false;
const SHUTDOWN_DRAIN_MS = 30000;

function shutdown(signal) {
  if (closing) return;
  closing = true;
  system("warn", `${signal} received, draining requests for ${SHUTDOWN_DRAIN_MS / 1000}s...`);
  server.close(() => {
    system("info", "server closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    const pending = inFlightAbortControllers.size;
    system("warn", `drain timeout, aborting ${pending} in-flight upstream requests and forcing exit`);
    for (const ac of inFlightAbortControllers) {
      try { ac.abort("shutdown"); } catch {}
    }
    process.exit(1);
  }, SHUTDOWN_DRAIN_MS);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", err => {
  system("error", `uncaught: ${err.message}`);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", reason => {
  system("error", `unhandledRejection: ${reason?.message || reason}`);
});