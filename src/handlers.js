"use strict";

const crypto = require("crypto");
const { PassThrough } = require("stream");
const {
  anthropicBodyToOpenAIChat,
  openaiChatResponseToAnthropic,
  createOpenAIToAnthropicSSETranslator,
  openaiBodyToAnthropic,
  anthropicResponseToOpenAIChat,
  createAnthropicToOpenAISSETranslator,
  parseAnthropicSSEUsage,
  sanitizeAnthropicBody,
} = require("./converters");
const {
  doUpstream, upstreamErrStatus, resolveApiKey,
} = require("./backend");
const { incMetric } = require("./metrics");
const { HOP_BY_HOP } = require("./config");
const { normalizeThinking } = require("./thinking");
const { json, corsHeaders } = require("./http_utils");
const { normalizeUsage } = require("./usage_recorder");
const { createSSEParser, isSSEDataLine, sseDataPayload } = require("./sse");

/**
 * Shared upstream-error handler. Used after `await doUpstream(...)` throws,
 * and from `upstreamBody.on("error", ...)` where stream cleanup is needed.
 */
function sendUpstreamError({ err, ctx, backend, res, req, finish, format }) {
  if (finish) {
    finish();
  }
  incMetric("upstream_errors");
  const status = upstreamErrStatus(err);
  ctx.err(status, err, { backend: backend.provider });
  if (res.headersSent) {
    // Headers already sent means we're mid-stream. Emit a protocol-appropriate
    // error event + terminator so the client sees a clean end instead of a
    // dangling socket half-close.
    if (res.writableEnded) return;
    const rawCT = (typeof res.getHeader === "function") ? res.getHeader("content-type") : "";
    const contentType = String(rawCT || "").toLowerCase();
    const isSSE = contentType.includes("text/event-stream");
    if (isSSE) {
      try {
        if (format === "responses") {
          const payload = JSON.stringify({
            type: "response.failed",
            sequence_number: -1,
            response: { error: { message: String(err), type: "upstream_error", code: status } },
          });
          res.write(`event: response.failed\ndata: ${payload}\n\n`);
        } else if (format === "anthropic") {
          const payload = JSON.stringify({
            type: "error",
            error: { type: "upstream_error", message: String(err) },
          });
          res.write(`event: error\ndata: ${payload}\n\n`);
        } else {
          // OpenAI Chat SSE: no error event; emit a synthetic chunk + [DONE].
          const payload = JSON.stringify({
            error: { message: String(err), type: "upstream_error", code: status },
          });
          res.write(`data: ${payload}\n\n`);
          res.write("data: [DONE]\n\n");
        }
        res.end();
        return;
      } catch {
        try { res.destroy(); } catch {}
        return;
      }
    }
    try { res.destroy(); } catch {}
    return;
  }
  const body = format === "anthropic"
    ? { error: { message: String(err), type: "upstream_error", code: status } }
    : format === "responses"
      ? { error: { message: String(err), type: "upstream_error", code: status } }
      : { error: String(err) };
  json(res, status, body, req);
}

/**
 * When the upstream returns a 4xx/5xx status, the body is a structured error
 * (JSON or plain text), not a stream of model output. Buffer it, log a
 * truncated copy, and surface to the caller in the format they expect — so
 * client-side error messages match the real upstream rejection (e.g.
 * "tool_choice required without tools") instead of a silent empty stream or a
 * generic 502.
 *
 * Handles both streaming and non-streaming entry points: the shared shape is
 * "we have an open upstream body, status>=400, no headers sent yet". Returns
 * true when it took ownership of the response, false otherwise.
 */
function relayUpstreamErrorBody({ statusCode, upstreamBody, ctx, backend, res, req, finish, format, label }) {
  if (statusCode < 400) return false;
  const chunks = [];
  let len = 0;
  upstreamBody.on("data", c => { chunks.push(c); len += c.length; });
  upstreamBody.on("end", () => {
    const rawBody = Buffer.concat(chunks, len).toString("utf8");
    const { system } = require("./logger");
    system("warn", `upstream ${statusCode} body (${label || "passthrough"}): ${rawBody.slice(0, 4000)}`,
      { backend: backend.provider, rid: ctx.rid });
    let parsed;
    try { parsed = JSON.parse(rawBody); } catch {}
    if (!res.headersSent) {
      const body = format === "anthropic"
        ? (parsed && parsed.error ? parsed : { error: { message: rawBody, type: "upstream_error", code: statusCode } })
        : (parsed && parsed.error ? parsed : { error: { message: rawBody, type: "upstream_error", code: statusCode } });
      json(res, statusCode, body, req);
    } else {
      // Headers already sent (e.g. SSE writeHead(200) raced ahead). Best we
      // can do is destroy so the client sees a broken stream rather than a
      // hung "completed" response.
      try { res.destroy(); } catch {}
    }
    incMetric("upstream_errors");
    ctx.end(statusCode, { backend: backend.provider });
    if (finish) finish();
  });
  upstreamBody.on("error", err => sendUpstreamError({ err, ctx, backend, res, req, finish, format }));
  return true;
}

function injectStreamOptions(bodyStr) {
  try {
    const obj = JSON.parse(bodyStr);
    if (obj.stream && !obj.stream_options) {
      obj.stream_options = { include_usage: true };
      return JSON.stringify(obj);
    }
  } catch {}
  return bodyStr;
}


/**
 * Wire a client-disconnect hook onto `res`. When the client closes the TCP
 * connection before the upstream response has finished streaming, we abort
 * the upstream request so the backend stops consuming bandwidth/quota. The
 * abort signal surfaces through `upstreamBody.on("error")` → `sendUpstreamError`
 * for normal bookkeeping.
 */
function attachClientDisconnect(res, ctx, abort) {
  res.on("close", () => {
    if (!res.writableEnded && typeof abort === "function") {
      abort("client_disconnected");
    }
    if (typeof ctx.flushOnClose === "function") ctx.flushOnClose();
  });
}

/**
 * SSE keepalive watchdog. Long extended-thinking turns can produce no
 * visible bytes for tens of seconds (Anthropic emits `ping` events but
 * intermediate proxies / corporate LBs / browsers still treat the
 * connection as idle and may close it after ~30s of silence — manifesting
 * to the user as the response being cut short).
 *
 * We send a single SSE comment line (`:keepalive\n\n`) every `intervalMs`
 * if no data has been written by the upstream pipeline since the last
 * heartbeat. Comment lines are silently ignored by all SSE parsers per
 * spec, so they don't pollute the event stream.
 *
 * Returns a `{ touch, stop }` pair: callers must invoke `touch()` on every
 * `res.write(...)` of real upstream data so a heartbeat isn't queued
 * needlessly, and `stop()` from their `end`/`error` handlers to drop the
 * timer. The heartbeat also stops automatically when `res` closes.
 */
function startSSEHeartbeat(res, intervalMs = 15_000) {
  // Initialize so the very first scheduled tick fires a heartbeat immediately
  // (rather than waiting a full intervalMs of silence first). This matters
  // when an intermediate proxy / browser closes idle SSE connections at a
  // threshold close to intervalMs — without an opening heartbeat the connection
  // can be torn down before the upstream produces its first byte.
  let lastActivity = Date.now() - intervalMs;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    if (res.writableEnded || res.destroyed) { stopped = true; return; }
    if (Date.now() - lastActivity >= intervalMs) {
      try { res.write(": keepalive\n\n"); lastActivity = Date.now(); } catch {}
    }
  };
  const handle = setInterval(tick, intervalMs);
  // Keep the timer from holding the event loop open during shutdown.
  if (typeof handle.unref === "function") handle.unref();
  res.on("close", () => { stopped = true; clearInterval(handle); });
  return {
    touch() { lastActivity = Date.now(); },
    stop() { stopped = true; clearInterval(handle); },
  };
}

function ctxMeta(ctx, backend, model, stream, endpoint, clientFormat) {
  return {
    model: model || "",
    backend: (backend && backend.provider) || "",
    endpoint: endpoint || "",
    client_format: clientFormat || "",
    stream: stream ? 1 : 0,
    duration_ms: Date.now() - ctx._start,
  };
}

/**
 * Sidecar SSE consumer used by passthrough paths. We pipe `upstreamBody`
 * verbatim into `res` (preserving every SSE byte and event boundary) while
 * cloning the same chunks into a PassThrough that runs a parser purely for
 * token-usage extraction. This avoids the historical hazard of re-emitting
 * SSE lines manually with hand-rolled `\n` separators, where any change in
 * the line splitter would silently break event grouping.
 *
 * `onLine(lineBuf)` runs once per SSE line (Buffer, no trailing CR/LF). The
 * caller is responsible for parsing `data:`/`event:` and accumulating usage.
 * Errors thrown from `onLine` are swallowed so a malformed upstream chunk
 * cannot poison the response pipe.
 */
function teeUsageWatcher(upstreamBody, onLine) {
  const tap = new PassThrough();
  upstreamBody.on("data", chunk => { try { tap.write(chunk); } catch {} });
  upstreamBody.on("end", () => { try { tap.end(); } catch {} });
  upstreamBody.on("error", () => { try { tap.destroy(); } catch {} });
  const parser = createSSEParser();
  tap.on("data", chunk => {
    parser.feed(chunk, line => { try { onLine(line); } catch {} });
  });
  tap.on("end", () => {
    parser.flush(line => { try { onLine(line); } catch {} });
  });
  return tap;
}

async function proxyOpenAIChat(req, res, ctx, backend, body) {
  const openaiBody = anthropicBodyToOpenAIChat(body, backend);
  // Inject stream_options so the upstream OpenAI-compatible backend includes
  // usage data in streaming responses (needed for token accounting).
  const openaiBodyStr = injectStreamOptions(JSON.stringify(openaiBody));
  const openaiBuf = Buffer.from(openaiBodyStr);
  if (typeof ctx.attachBody === "function") ctx.attachBody(openaiBuf);

  const backendUrl = new URL("/v1/chat/completions", backend.baseUrl.replace("/v1", ""));

  const headers = {
    "content-type": "application/json",
    "content-length": openaiBuf.length,
    "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
    host: backendUrl.host
  };

  let up;
  try {
    up = await doUpstream(backendUrl, { method: "POST", headers, body: openaiBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req, format: "anthropic" });
  }

  const { statusCode, body: upstreamBody, finish, abort } = up;

  if (statusCode >= 400) {
    return relayUpstreamErrorBody({
      statusCode, upstreamBody, ctx, backend, res, req, finish,
      format: "anthropic", label: "Anthropic→OpenAI-Chat",
    });
  }

  if (body.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(req),
    });
    attachClientDisconnect(res, ctx, abort);
    const msgId = "msg_" + crypto.randomUUID();
    const model = body.model || "";
    const translator = createOpenAIToAnthropicSSETranslator(msgId, model);
    const parser = createSSEParser();
    let doneSent = false;
    const heartbeat = startSSEHeartbeat(res);

    upstreamBody.on("data", chunk => {
      if (typeof ctx.markTTFT === "function") ctx.markTTFT();
      const outs = [];
      parser.feed(chunk, line => {
        if (!isSSEDataLine(line)) return;
        const d = sseDataPayload(line);
        if (!d) return;
        if (d === "[DONE]") {
          const tail = translator.finalize();
          if (tail) outs.push(tail);
          // No `data: [DONE]\n\n` — Anthropic's SSE protocol terminates on
          // `event: message_stop`, which `translator.finalize()` already
          // emitted (or was emitted earlier when the upstream's
          // `finish_reason` chunk arrived). Adding [DONE] confuses strict
          // Anthropic clients.
          doneSent = true;
          return;
        }
        try {
          const openaiChunk = JSON.parse(d);
          const out = translator.translate(openaiChunk);
          if (out) outs.push(out);
        } catch {}
      });
      if (outs.length > 0) { res.write(outs.join("")); heartbeat.touch(); }
    });
    upstreamBody.on("end", () => {
      // Flush any trailing line that arrived without a terminating newline.
      // Some upstreams close the stream right after `data: ...[DONE]\n` (or
      // after the final chunk with no newline at all) — without flushing we
      // would silently drop the last SSE event, which can manifest as the
      // last sentence / finish_reason being lost ("output cut short").
      parser.flush(line => {
        if (!isSSEDataLine(line)) return;
        const d = sseDataPayload(line);
        if (!d) return;
        if (d === "[DONE]") {
          const tail = translator.finalize();
          if (tail) res.write(tail);
          doneSent = true;
          return;
        }
        try {
          const openaiChunk = JSON.parse(d);
          const out = translator.translate(openaiChunk);
          if (out) res.write(out);
        } catch {}
      });
      if (!doneSent) {
        const tail = translator.finalize();
        if (tail) res.write(tail);
        // NOTE: do NOT emit `data: [DONE]\n\n` here — this stream is being
        // delivered to an Anthropic-shape client, whose protocol terminates
        // on `event: message_stop` (already produced by translator.finalize)
        // and has no `[DONE]` sentinel. Writing one was harmless on lenient
        // SDKs but confused stricter Anthropic clients.
      }
      heartbeat.stop();
      res.end();
      const finalUsage = translator.getUsage();
      if (finalUsage) {
        ctx.attachUsage(normalizeUsage(finalUsage), {
          model: body.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      ctx.end(200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      heartbeat.stop();
      const partial = translator.getUsage && translator.getUsage();
      if (partial) {
        const n = normalizeUsage(partial);
        if (n.input_tokens || n.output_tokens) {
          ctx.attachUsage(n, {
            model: body.model || "",
            stream: 1,
            duration_ms: Date.now() - ctx._start,
          });
        }
      }
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "anthropic" });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      let convertOk = true;
      try {
        const openaiResp = JSON.parse(Buffer.concat(responseChunks, responseLen).toString("utf8"));
        const anthropicResp = openaiChatResponseToAnthropic(openaiResp);
        ctx.attachUsage(normalizeUsage(openaiResp.usage), {
          model: body.model || "",
          stream: 0,
          duration_ms: Date.now() - ctx._start
        });
        json(res, statusCode || 200, anthropicResp, req);
      } catch (convErr) {
        convertOk = false;
        json(res, 502, { error: "Failed to convert OpenAI response to Anthropic format" }, req);
        incMetric("upstream_errors");
        ctx.err(502, convErr, { backend: backend.provider });
      }
      if (convertOk) {
        ctx.end(statusCode || 200, { backend: backend.provider });
      }
      finish();
    });
    upstreamBody.on("error", err => {
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "anthropic" });
    });
  }
}

async function proxyAnthropicAsOpenAI(req, res, ctx, backend, parsedBody) {
  const anthropicBody = openaiBodyToAnthropic(parsedBody);
  normalizeThinking(anthropicBody, backend);
  sanitizeAnthropicBody(anthropicBody);

  const suffix = "/v1/messages";
  const fullUrl = backend.baseUrl.replace(/\/+$/, "") + suffix;
  const upstreamUrl = new URL(fullUrl);
  if (upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.delete("beta");

  const bodyBuf = Buffer.from(JSON.stringify(anthropicBody));
  if (typeof ctx.attachBody === "function") ctx.attachBody(bodyBuf);

  const headers = {
    "content-type": "application/json",
    "content-length": bodyBuf.length,
    "anthropic-version": "2023-06-01",
    "x-api-key": resolveApiKey(req, backend.apiKey),
    host: upstreamUrl.host
  };

  let up;
  try {
    up = await doUpstream(upstreamUrl, { method: "POST", headers, body: bodyBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req, format: "openai" });
  }

  const { statusCode, body: upstreamBody, finish, abort } = up;

  if (statusCode >= 400) {
    return relayUpstreamErrorBody({
      statusCode, upstreamBody, ctx, backend, res, req, finish,
      format: "openai", label: "OpenAI→Anthropic",
    });
  }

  if (anthropicBody.stream) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(req),
    });
    attachClientDisconnect(res, ctx, abort);
    const chatId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const model = anthropicBody.model || "";

    const parser = createSSEParser();
    const translator = createAnthropicToOpenAISSETranslator(chatId, model);
    const heartbeat = startSSEHeartbeat(res);

    upstreamBody.on("data", chunk => {
      if (typeof ctx.markTTFT === "function") ctx.markTTFT();
      const outs = [];
      parser.feed(chunk, line => {
        const converted = translator.translate(line.toString("utf8"));
        if (converted) outs.push(converted);
      });
      if (outs.length > 0) { res.write(outs.join("")); heartbeat.touch(); }
    });
    upstreamBody.on("end", () => {
      parser.flush(line => {
        const converted = translator.translate(line.toString("utf8"));
        if (converted) res.write(converted);
      });
      heartbeat.stop();
      res.end();
      const acc = translator.getAcc();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      heartbeat.stop();
      const acc = translator.getAcc && translator.getAcc();
      if (acc && (acc.input_tokens || acc.output_tokens)) {
        ctx.attachUsage(acc, {
          model: anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "openai" });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      let convertOk = true;
      try {
        const anthropicResp = JSON.parse(Buffer.concat(responseChunks, responseLen).toString("utf8"));
        ctx.attachUsage(normalizeUsage(anthropicResp.usage), {
          model: anthropicResp.model || anthropicBody.model || "",
          stream: 0,
          duration_ms: Date.now() - ctx._start
        });
        const openaiResp = anthropicResponseToOpenAIChat(anthropicResp);
        json(res, statusCode || 200, openaiResp, req);
      } catch (convErr) {
        convertOk = false;
        json(res, 502, { error: "Failed to convert Anthropic response to OpenAI format" }, req);
        incMetric("upstream_errors");
        ctx.err(502, convErr, { backend: backend.provider });
      }
      if (convertOk) {
        ctx.end(statusCode || 200, { backend: backend.provider });
      }
      finish();
    });
    upstreamBody.on("error", err => {
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "openai" });
    });
  }
}

async function proxyOpenAIDirect(req, res, ctx, backend, parsedBody, bodyStr) {
  const injectedStr = injectStreamOptions(bodyStr);
  const bodyBuf = Buffer.from(injectedStr);
  if (typeof ctx.attachBody === "function") ctx.attachBody(bodyBuf);

  const backendUrl = new URL("/v1/chat/completions", backend.baseUrl.replace("/v1", ""));

  const headers = {
    "content-type": "application/json",
    "content-length": bodyBuf.length,
    "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
    host: backendUrl.host
  };

  let up;
  try {
    up = await doUpstream(backendUrl, { method: "POST", headers, body: bodyBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req, format: "openai" });
  }

  const isStream = parsedBody.stream === true;
  const { statusCode, headers: resHeaders, body: upstreamBody, finish, abort } = up;
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // Upstream content-length is only valid when we forward the body byte-
    // for-byte. We mutate streaming responses (line-buffered parsing,
    // possible usage rewrite) and some buffered paths, so the advertised
    // length can no longer be trusted — drop it and let Node chunk-encode.
    if (lk === "content-length") continue;
    cleanHeaders[k] = v;
  }
  res.writeHead(statusCode || 502, cleanHeaders);
  attachClientDisconnect(res, ctx, abort);

  if (isStream) {
    // Passthrough path: forward upstream SSE bytes verbatim (via .pipe) so
    // every event boundary / blank line / trailing newline arrives exactly
    // as the backend sent it. A sidecar parser taps the same stream to
    // extract usage without touching the on-the-wire bytes.
    const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    const heartbeat = startSSEHeartbeat(res);
    let ttftMarked = false;

    teeUsageWatcher(upstreamBody, line => {
      if (!isSSEDataLine(line)) return;
      const d = sseDataPayload(line);
      if (!d || d === "[DONE]") return;
      try {
        const chunkObj = JSON.parse(d);
        if (chunkObj.usage) {
          const u = normalizeUsage(chunkObj.usage);
          if (typeof u.input_tokens === "number") acc.input_tokens = u.input_tokens;
          if (typeof u.output_tokens === "number") acc.output_tokens = u.output_tokens;
          if (typeof u.cache_read_tokens === "number") acc.cache_read_tokens = u.cache_read_tokens;
          if (typeof u.cache_write_tokens === "number") acc.cache_write_tokens = u.cache_write_tokens;
        }
      } catch {}
    });

    upstreamBody.on("data", chunk => {
      if (!ttftMarked && typeof ctx.markTTFT === "function") { ctx.markTTFT(); ttftMarked = true; }
      // Forward the upstream chunk verbatim — no line-splitting, no manual
      // newline reconstruction. This preserves every SSE boundary byte the
      // backend produced.
      try { res.write(chunk); heartbeat.touch(); } catch {}
    });
    upstreamBody.on("end", () => {
      heartbeat.stop();
      try { res.end(); } catch {}
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: parsedBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      ctx.end(statusCode || 502, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      heartbeat.stop();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: parsedBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "openai" });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      const buf = Buffer.concat(responseChunks, responseLen);
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        const norm = normalizeUsage(parsed.usage);
        if (norm.input_tokens || norm.output_tokens) {
          ctx.attachUsage(norm, {
            model: parsedBody.model || parsed.model || "",
            stream: 0,
            duration_ms: Date.now() - ctx._start
          });
        }
      } catch {}
      res.end(buf);
      ctx.end(statusCode || 502, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "openai" });
    });
  }
}

/**
 * Anthropic client → Anthropic backend: proxied passthrough.
 * Captures token usage from both stream (Anthropic SSE) and non-stream (JSON body).
 */
async function proxyRequest(req, res, ctx, backend, requestPath, bodyStr) {
  const suffix = requestPath.replace(/^\/anthropic/, "") || "/";
  const fullUrl = backend.baseUrl.replace(/\/+$/, "") + suffix;
  const upstreamUrl = new URL(fullUrl);
  if (upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.delete("beta");

  // Anthropic-direct passthrough still needs the same body-shape sanitation
  // we apply to converted bodies. ClaudeCode (and other Anthropic-native
  // clients) occasionally produce messages with whitespace-only text blocks,
  // empty tool_result contents, or dangling thinking blocks; Anthropic's
  // strict 400 ("text content blocks must contain non-whitespace text")
  // surfaces as an intermittent failure that is otherwise hard to diagnose.
  // We only rewrite the request body for /v1/messages POSTs that parse as
  // JSON with a messages array; every other request passes through verbatim.
  let bodyBuf = bodyStr ? Buffer.from(bodyStr) : undefined;
  let isStream = false;
  if (bodyStr) {
    try {
      const parsed = JSON.parse(bodyStr);
      isStream = parsed.stream === true;
      if (suffix.includes("/v1/messages") && Array.isArray(parsed.messages)) {
        sanitizeAnthropicBody(parsed);
        const rewritten = JSON.stringify(parsed);
        if (rewritten !== bodyStr) bodyBuf = Buffer.from(rewritten);
      }
    } catch {}
  }
  if (bodyBuf && typeof ctx.attachBody === "function") ctx.attachBody(bodyBuf);

  // Only a tight allow-list of client headers survives into the upstream
  // request. In particular, the client's Authorization / Cookie / User-Agent
  // must NOT leak to the upstream provider — we inject the backend-specific
  // x-api-key ourselves, and anything else would either confuse the upstream
  // (dual credentials) or leak local identity to a third party.
  const ANTH_PASSTHROUGH_HEADERS = new Set([
    "accept",
    "accept-encoding",
    "anthropic-version",
    "content-type",
  ]);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lower = k.toLowerCase();
    if (ANTH_PASSTHROUGH_HEADERS.has(lower)) headers[k] = v;
  }
  if (!Object.keys(headers).some(k => k.toLowerCase() === "anthropic-version")) {
    headers["anthropic-version"] = "2023-06-01";
  }
  headers.host = upstreamUrl.host;
  headers["x-api-key"] = resolveApiKey(req, backend.apiKey);
  if (bodyBuf) headers["content-length"] = bodyBuf.length;

  let up;
  try {
    up = await doUpstream(upstreamUrl, { method: req.method, headers, body: bodyBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req, format: "anthropic" });
  }

  const { statusCode, headers: resHeaders, body: upstreamBody, finish, abort } = up;
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    // Upstream content-length is only valid when we forward the body byte-
    // for-byte. We mutate streaming responses (line-buffered parsing,
    // possible usage rewrite) and some buffered paths, so the advertised
    // length can no longer be trusted — drop it and let Node chunk-encode.
    if (lk === "content-length") continue;
    cleanHeaders[k] = v;
  }
  res.writeHead(statusCode || 502, cleanHeaders);
  attachClientDisconnect(res, ctx, abort);

  if (isStream) {
    // Anthropic-direct passthrough: forward upstream SSE bytes verbatim and
    // run a sidecar parser over a tee'd copy purely for usage extraction.
    const acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, model: "" };
    const heartbeat = startSSEHeartbeat(res);
    let ttftMarked = false;

    teeUsageWatcher(upstreamBody, line => {
      parseAnthropicSSEUsage(line.toString("utf8"), acc);
    });

    upstreamBody.on("data", chunk => {
      if (!ttftMarked && typeof ctx.markTTFT === "function") { ctx.markTTFT(); ttftMarked = true; }
      try { res.write(chunk); heartbeat.touch(); } catch {}
    });
    upstreamBody.on("end", () => {
      heartbeat.stop();
      try { res.end(); } catch {}
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: acc.model || backend.models?.[0] || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      ctx.end(statusCode || 502, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      heartbeat.stop();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: acc.model || backend.models?.[0] || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "anthropic" });
    });
  } else {
    const responseChunks = [];
    let responseLen = 0;
    upstreamBody.on("data", chunk => { responseChunks.push(chunk); responseLen += chunk.length; });
    upstreamBody.on("end", () => {
      const buf = Buffer.concat(responseChunks, responseLen);
      try {
        const parsed = JSON.parse(buf.toString("utf8"));
        const norm = normalizeUsage(parsed.usage);
        if (norm.input_tokens || norm.output_tokens) {
          ctx.attachUsage(norm, {
            model: parsed.model || "",
            stream: 0,
            duration_ms: Date.now() - ctx._start
          });
        }
      } catch {}
      res.end(buf);
      ctx.end(statusCode || 502, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      sendUpstreamError({ err, ctx, backend, res, req, finish, format: "anthropic" });
    });
  }
}

module.exports = {
  proxyOpenAIChat,
  proxyAnthropicAsOpenAI,
  proxyOpenAIDirect,
  proxyRequest,
  // exposed for unit tests
  _injectStreamOptions: injectStreamOptions,
  // exposed for other handler modules
  _relayUpstreamErrorBody: relayUpstreamErrorBody,
  _sendUpstreamError: sendUpstreamError,
  _attachClientDisconnect: attachClientDisconnect,
  _startSSEHeartbeat: startSSEHeartbeat,
};
