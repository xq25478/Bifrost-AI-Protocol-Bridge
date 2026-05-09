"use strict";

/**
 * Responses API handlers.
 *
 * Two entry points mirror the existing handler split:
 *
 *   proxyResponsesAsOpenAI(...)      Responses client  -> OpenAI (Chat) backend
 *   proxyResponsesAsAnthropic(...)   Responses client  -> Anthropic backend
 *
 * OpenAI-compatible backends still use Chat Completions as their common wire
 * shape. Anthropic backends use direct Responses<->Messages conversion so item
 * and content-block semantics do not pass through an unrelated protocol.
 */

const {
  responsesBodyToOpenAIChat,
  openaiChatResponseToResponses,
  createOpenAIChatToResponsesSSETranslator,
} = require("./converters_responses");
const {
  responsesBodyToAnthropic,
  anthropicResponseToResponses,
  createAnthropicToResponsesSSETranslator,
} = require("./converters_responses_anthropic");
const {
  doUpstream, upstreamErrStatus, onBackendError, onBackendSuccess, resolveApiKey,
} = require("./backend");
const { incMetric } = require("./metrics");
const { normalizeThinking } = require("./thinking");
const { json, corsHeaders } = require("./http_utils");
const { normalizeUsage } = require("./usage_recorder");
const { createSSEParser, isSSEDataLine, sseDataPayload } = require("./sse");
const {
  _relayUpstreamErrorBody: relayUpstreamErrorBody,
  _sendUpstreamError: rawSendUpstreamError,
  _attachClientDisconnect: attachClientDisconnect,
} = require("./handlers");

function sendUpstreamError({ err, ctx, backend, res, req, finish }) {
  rawSendUpstreamError({ err, ctx, backend, res, req, finish, format: "responses" });
}

function injectStreamOptions(obj) {
  if (obj.stream && !obj.stream_options) {
    obj.stream_options = { include_usage: true };
  }
  return obj;
}

/**
 * Responses → OpenAI Chat (forward) → OpenAI Chat response → Responses.
 */
async function proxyResponsesAsOpenAI(req, res, ctx, backend, reqBody) {
  const chatBody = responsesBodyToOpenAIChat(reqBody, backend);
  injectStreamOptions(chatBody);
  const chatBuf = Buffer.from(JSON.stringify(chatBody));
  if (typeof ctx.attachBody === "function") ctx.attachBody(chatBuf);

  const backendUrl = new URL("/v1/chat/completions", backend.baseUrl.replace("/v1", ""));
  const headers = {
    "content-type": "application/json",
    "content-length": chatBuf.length,
    "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
    host: backendUrl.host,
  };

  let up;
  try {
    up = await doUpstream(backendUrl, { method: "POST", headers, body: chatBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req });
  }
  const { statusCode, body: upstreamBody, finish, abort } = up;

  if (statusCode >= 400) {
    return relayUpstreamErrorBody({
      statusCode, upstreamBody, ctx, backend, res, req, finish,
      format: "responses", label: "Responses→OpenAI-Chat",
    });
  }

  if (reqBody.stream) {
    return streamChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode, abort);
  }
  return bufferChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode);
}

/**
 * Responses → Anthropic (forward) → Responses.
 * Uses the direct Responses<->Anthropic converters so Responses items and
 * Anthropic content blocks do not lose shape through an intermediate protocol.
 */
async function proxyResponsesAsAnthropic(req, res, ctx, backend, reqBody) {
  const anthropicBody = responsesBodyToAnthropic(reqBody);
  normalizeThinking(anthropicBody, backend);

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
    host: upstreamUrl.host,
  };

  let up;
  try {
    up = await doUpstream(upstreamUrl, { method: "POST", headers, body: bodyBuf }, backend, ctx);
  } catch (err) {
    return sendUpstreamError({ err, ctx, backend, res, req });
  }
  const { statusCode, body: upstreamBody, finish, abort } = up;

  if (statusCode >= 400) {
    return relayUpstreamErrorBody({
      statusCode, upstreamBody, ctx, backend, res, req, finish,
      format: "responses", label: "Responses→Anthropic",
    });
  }

  if (anthropicBody.stream) {
    const translator = createAnthropicToResponsesSSETranslator(reqBody.model || anthropicBody.model || "", reqBody);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(req),
    });
    attachClientDisconnect(res, ctx, abort);

    const parser = createSSEParser();

    upstreamBody.on("data", chunk => {
      if (typeof ctx.markTTFT === "function") ctx.markTTFT();
      const outs = [];
      parser.feed(chunk, line => {
        const sse = translator.translate(line.toString("utf8"));
        if (sse) outs.push(sse);
      });
      if (outs.length > 0) res.write(outs.join(""));
    });
    upstreamBody.on("end", () => {
      parser.flush(line => {
        const sse = translator.translate(line.toString("utf8"));
        if (sse) res.write(sse);
      });
      const tail = translator.finalize();
      if (tail) res.write(tail);
      res.end();
      const acc = translator.getUsage();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: reqBody.model || anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      onBackendSuccess(backend);
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      // Persist partial usage before we error out: input_tokens are reported
      // by Anthropic in `message_start`, which often arrives before the
      // stream breaks. Losing them silently makes post-mortem diagnosis
      // harder and distorts dashboard totals.
      const acc = translator.getUsage();
      if (acc && (acc.input_tokens || acc.output_tokens)) {
        ctx.attachUsage(acc, {
          model: reqBody.model || anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      const tail = translator.finalize(err);
      if (tail) {
        try { res.write(tail); } catch {}
      }
      // End the SSE stream now that the failure event was written; this lets
      // sendUpstreamError see `res.writableEnded === true` and skip emitting
      // a duplicate `response.failed` event.
      try { res.end(); } catch {}
      sendUpstreamError({ err, ctx, backend, res, req, finish });
    });
    return;
  }

  // Non-streaming Anthropic → Responses.
  const chunks = [];
  let len = 0;
  upstreamBody.on("data", c => { chunks.push(c); len += c.length; });
  upstreamBody.on("end", () => {
    const rawBody = Buffer.concat(chunks, len).toString("utf8");
    if (statusCode >= 400 && process.env.DEBUG_UPSTREAM_BODY === "1") {
      const { system } = require("./logger");
      system("warn", `upstream ${statusCode} body (Responses→Anthropic): ${rawBody.slice(0, 2000)}`, { backend: backend.provider, rid: ctx.rid });
    }
    let convertOk = true;
    try {
      const anthropicResp = JSON.parse(rawBody);
      ctx.attachUsage(normalizeUsage(anthropicResp.usage), {
        model: anthropicResp.model || anthropicBody.model || reqBody.model || "",
        stream: 0,
        duration_ms: Date.now() - ctx._start,
      });
      const responsesResp = anthropicResponseToResponses(anthropicResp, reqBody);
      json(res, statusCode || 200, responsesResp, req);
    } catch (convErr) {
      convertOk = false;
      json(res, 502, { error: { message: "Failed to convert Anthropic response to Responses format", type: "upstream_error" } }, req);
      onBackendError(backend);
      incMetric("upstream_errors");
      ctx.err(502, convErr, { backend: backend.provider });
    }
    if (convertOk) {
      onBackendSuccess(backend);
      ctx.end(statusCode || 200, { backend: backend.provider });
    }
    finish();
  });
  upstreamBody.on("error", err => {
    sendUpstreamError({ err, ctx, backend, res, req, finish });
  });
}

// ------------------------------------------------------------
// Shared Chat-response handlers for proxyResponsesAsOpenAI
// ------------------------------------------------------------

function streamChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode, abort) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    ...corsHeaders(req),
  });
  attachClientDisconnect(res, ctx, abort);

  const translator = createOpenAIChatToResponsesSSETranslator(reqBody.model || "", reqBody);
  const parser = createSSEParser();

  upstreamBody.on("data", chunk => {
    if (typeof ctx.markTTFT === "function") ctx.markTTFT();
    const outs = [];
    parser.feed(chunk, line => {
      if (!isSSEDataLine(line)) return;
      const d = sseDataPayload(line);
      if (!d || d === "[DONE]") return;
      try {
        const chatChunk = JSON.parse(d);
        const sse = translator.translate(chatChunk);
        if (sse) outs.push(sse);
      } catch {}
    });
    if (outs.length > 0) res.write(outs.join(""));
  });
  upstreamBody.on("end", () => {
    parser.flush(line => {
      if (!isSSEDataLine(line)) return;
      const d = sseDataPayload(line);
      if (!d || d === "[DONE]") return;
      try {
        const chatChunk = JSON.parse(d);
        const sse = translator.translate(chatChunk);
        if (sse) res.write(sse);
      } catch {}
    });
    const tail = translator.finalize();
    if (tail) res.write(tail);
    res.end();
    const finalUsage = translator.getUsage();
    if (finalUsage) {
      ctx.attachUsage(normalizeUsage(finalUsage), {
        model: reqBody.model || "",
        stream: 1,
        duration_ms: Date.now() - ctx._start,
      });
    }
    onBackendSuccess(backend);
    ctx.end(statusCode || 200, { backend: backend.provider });
    finish();
  });
  upstreamBody.on("error", err => {
    try {
      const tail = translator.finalize(err);
      if (tail) {
        res.write(tail);
        // We just wrote a `response.failed` SSE event; close the stream so
        // sendUpstreamError observes `res.writableEnded` and doesn't emit a
        // second `response.failed` (which would surface as a duplicate event
        // with `sequence_number:-1` to the client).
        try { res.end(); } catch {}
      }
    } catch {}
    sendUpstreamError({ err, ctx, backend, res, req, finish });
  });
}

function bufferChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode) {
  const chunks = [];
  let len = 0;
  upstreamBody.on("data", c => { chunks.push(c); len += c.length; });
  upstreamBody.on("end", () => {
    let convertOk = true;
    try {
      const chatResp = JSON.parse(Buffer.concat(chunks, len).toString("utf8"));
      ctx.attachUsage(normalizeUsage(chatResp.usage), {
        model: reqBody.model || chatResp.model || "",
        stream: 0,
        duration_ms: Date.now() - ctx._start,
      });
      const responsesResp = openaiChatResponseToResponses(chatResp, reqBody);
      json(res, statusCode || 200, responsesResp, req);
    } catch (convErr) {
      convertOk = false;
      json(res, 502, { error: { message: "Failed to convert OpenAI response to Responses format", type: "upstream_error" } }, req);
      onBackendError(backend);
      incMetric("upstream_errors");
      ctx.err(502, convErr, { backend: backend.provider });
    }
    if (convertOk) {
      onBackendSuccess(backend);
      ctx.end(statusCode || 200, { backend: backend.provider });
    }
    finish();
  });
  upstreamBody.on("error", err => {
    sendUpstreamError({ err, ctx, backend, res, req, finish });
  });
}

module.exports = {
  proxyResponsesAsOpenAI,
  proxyResponsesAsAnthropic,
};
