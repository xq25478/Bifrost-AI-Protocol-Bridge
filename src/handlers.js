"use strict";

const crypto = require("crypto");
const {
  anthropicBodyToOpenAIChat,
  openaiChatResponseToAnthropic,
  createOpenAIToAnthropicSSETranslator,
  openaiBodyToAnthropic,
  anthropicResponseToOpenAIChat,
  createAnthropicToOpenAISSETranslator,
  parseAnthropicSSEUsage,
} = require("./converters");
const {
  doUpstream, upstreamErrStatus, onBackendError, onBackendSuccess, resolveApiKey,
} = require("./backend");
const { incMetric } = require("./metrics");
const { HOP_BY_HOP } = require("./config");
const { normalizeThinking } = require("./thinking");
const { json } = require("./http_utils");
const { normalizeUsage } = require("./usage_recorder");

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

async function proxyOpenAIChat(req, res, ctx, backend, body) {
  const openaiBody = anthropicBodyToOpenAIChat(body);
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
    res.on("close", () => {
      if (typeof ctx.flushOnClose === "function") ctx.flushOnClose();
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
      const finalUsage = translator.getUsage();
      if (finalUsage) {
        ctx.attachUsage(normalizeUsage(finalUsage), {
          model: body.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      onBackendSuccess(backend);
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
        ctx.attachUsage(normalizeUsage(openaiResp.usage), {
          model: body.model || "",
          stream: 0,
          duration_ms: Date.now() - ctx._start
        });
        json(res, statusCode || 200, anthropicResp);
      } catch {
        json(res, 502, { error: "Failed to convert OpenAI response to Anthropic format" });
      }
      onBackendSuccess(backend);
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

async function proxyAnthropicAsOpenAI(req, res, ctx, backend, parsedBody) {
  const anthropicBody = openaiBodyToAnthropic(parsedBody);
  normalizeThinking(anthropicBody);

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
    res.on("close", () => {
      if (typeof ctx.flushOnClose === "function") ctx.flushOnClose();
    });
    const chatId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const model = anthropicBody.model || "";

    let buffer = null;
    const translator = createAnthropicToOpenAISSETranslator(chatId, model);

    upstreamBody.on("data", chunk => {
      buffer = buffer ? Buffer.concat([buffer, chunk], buffer.length + chunk.length) : chunk;
      const outs = [];
      let nl;
      while ((nl = buffer.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buffer[nl - 1] === 0x0D ? nl - 1 : nl;
        const line = buffer.subarray(0, end).toString("utf8");
        buffer = buffer.subarray(nl + 1);
        const converted = translator.translate(line);
        if (converted) outs.push(converted);
      }
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      if (buffer && buffer.length > 0) {
        const end = buffer[buffer.length - 1] === 0x0D ? buffer.length - 1 : buffer.length;
        const line = buffer.subarray(0, end).toString("utf8");
        const converted = translator.translate(line);
        if (converted) res.write(converted);
      }
      res.end();
      const acc = translator.getAcc();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      onBackendSuccess(backend);
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
        ctx.attachUsage(normalizeUsage(anthropicResp.usage), {
          model: anthropicResp.model || anthropicBody.model || "",
          stream: 0,
          duration_ms: Date.now() - ctx._start
        });
        const openaiResp = anthropicResponseToOpenAIChat(anthropicResp);
        json(res, statusCode || 200, openaiResp);
      } catch {
        json(res, 502, { error: "Failed to convert Anthropic response to OpenAI format" });
      }
      onBackendSuccess(backend);
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
    incMetric("upstream_errors");
    const status = upstreamErrStatus(err);
    ctx.err(status, err, { backend: backend.provider });
    if (res.headersSent) { res.destroy(); return; }
    return json(res, status, { error: String(err) });
  }

  const isStream = parsedBody.stream === true;
  const { statusCode, headers: resHeaders, body: upstreamBody, finish } = up;
  const cleanHeaders = {};
  for (const [k, v] of Object.entries(resHeaders)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) cleanHeaders[k] = v;
  }
  res.writeHead(statusCode || 502, cleanHeaders);
  res.on("close", () => {
    finish();
    if (typeof ctx.flushOnClose === "function") ctx.flushOnClose();
  });

  if (isStream) {
    let buf = null;
    let acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };

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
            line[3] !== 0x61 || line[4] !== 0x3A || line[5] !== 0x20) {
          continue;
        }
        const d = line.subarray(6).toString("utf8").trim();
        if (!d) continue;
        if (d === "[DONE]") continue;
        try {
          const chunkObj = JSON.parse(d);
          if (chunkObj.usage) {
            // merge — don't replace, in case a partial usage chunk arrives early
            const u = normalizeUsage(chunkObj.usage);
            if (u.input_tokens > 0) acc.input_tokens = u.input_tokens;
            if (u.output_tokens > 0) acc.output_tokens = u.output_tokens;
            if (u.cache_read_tokens > 0) acc.cache_read_tokens = u.cache_read_tokens;
            if (u.cache_write_tokens > 0) acc.cache_write_tokens = u.cache_write_tokens;
          }
        } catch {}
        outs.push(line.toString("utf8") + "\n");
      }
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      res.end();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: parsedBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      onBackendSuccess(backend);
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
      onBackendSuccess(backend);
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

  const bodyBuf = bodyStr ? Buffer.from(bodyStr) : undefined;
  if (bodyBuf && typeof ctx.attachBody === "function") ctx.attachBody(bodyBuf);

  let isStream = false;
  if (bodyStr) {
    try {
      const parsed = JSON.parse(bodyStr);
      isStream = parsed.stream === true;
    } catch {}
  }

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
    up = await doUpstream(upstreamUrl, { method: req.method, headers, body: bodyBuf }, backend, ctx);
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
  res.on("close", () => {
    finish();
    if (typeof ctx.flushOnClose === "function") ctx.flushOnClose();
  });

  if (isStream) {
    let buf = null;
    let acc = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
    let modelName = "";


    upstreamBody.on("data", chunk => {
      buf = buf ? Buffer.concat([buf, chunk], buf.length + chunk.length) : chunk;
      const outs = [];
      let nl;
      while ((nl = buf.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buf[nl - 1] === 0x0D ? nl - 1 : nl;
        const line = buf.subarray(0, end).toString("utf8");
        buf = buf.subarray(nl + 1);
        parseAnthropicSSEUsage(line, acc);
        outs.push(line + "\n");
      }
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      res.end();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: modelName || backend.models?.[0] || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start
        });
      }
      onBackendSuccess(backend);
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
      onBackendSuccess(backend);
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
}

module.exports = {
  proxyOpenAIChat,
  proxyAnthropicAsOpenAI,
  proxyOpenAIDirect,
  proxyRequest,
  // exposed for unit tests
  _injectStreamOptions: injectStreamOptions,
};