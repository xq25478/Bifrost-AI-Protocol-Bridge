"use strict";

/**
 * Responses API handlers.
 *
 * Two entry points mirror the existing handler split:
 *
 *   proxyResponsesAsOpenAI(...)      Responses client  -> OpenAI (Chat) backend
 *   proxyResponsesAsAnthropic(...)   Responses client  -> Anthropic backend
 *
 * Both translate the inbound Responses request into OpenAI Chat Completions
 * (the common canonical form), hand off to the existing upstream plumbing,
 * and wrap the returning stream/non-stream with a Chat -> Responses converter.
 */

const {
  responsesBodyToOpenAIChat,
  openaiChatResponseToResponses,
  createOpenAIChatToResponsesSSETranslator,
} = require("./converters_responses");
const {
  openaiBodyToAnthropic,
  anthropicResponseToOpenAIChat,
  createAnthropicToOpenAISSETranslator,
  sanitizeAnthropicBody,
} = require("./converters");
const {
  doUpstream, upstreamErrStatus, resolveApiKey,
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
  _startSSEHeartbeat: startSSEHeartbeat,
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
  const chatBody = responsesBodyToOpenAIChat(reqBody);
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
      format: "openai", label: "Responses→OpenAI-Chat",
    });
  }

  if (reqBody.stream) {
    return streamChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode, abort);
  }
  return bufferChatToResponses(res, req, ctx, backend, reqBody, upstreamBody, finish, statusCode);
}

/**
 * Responses → Chat → Anthropic (forward) → Anthropic → Chat → Responses.
 * The two-stage translation reuses existing Chat<->Anthropic converters so
 * we don't duplicate tool-call / image / system-prompt handling.
 */
async function proxyResponsesAsAnthropic(req, res, ctx, backend, reqBody) {
  const chatBody = responsesBodyToOpenAIChat(reqBody);
  const anthropicBody = openaiBodyToAnthropic(chatBody);
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
      format: "openai", label: "Responses→Anthropic",
    });
  }

  if (anthropicBody.stream) {
    // Compose two SSE translators: Anthropic SSE -> Chat SSE -> Responses SSE.
    const crypto = require("crypto");
    const chatId = "chatcmpl-" + crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    const anthToChat = createAnthropicToOpenAISSETranslator(chatId, reqBody.model || anthropicBody.model || "");
    const chatToResponses = createOpenAIChatToResponsesSSETranslator(reqBody.model || "", reqBody);

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      ...corsHeaders(req),
    });
    attachClientDisconnect(res, ctx, abort);

    const parser = createSSEParser();
    const heartbeat = startSSEHeartbeat(res);

    function pipeChatSSEToResponses(chatSSEStr) {
      if (!chatSSEStr) return "";
      // chatSSEStr may contain multiple "data: ...\n\n" blocks; split and feed
      // each JSON payload (skip [DONE], which has no object form).
      const out = [];
      const blocks = chatSSEStr.split("\n\n");
      for (const b of blocks) {
        const line = b.trim();
        // Accept both `data: ...` and `data:...` (the space is optional per
        // the SSE spec); the upstream translator emits the former, but
        // matching both keeps this resilient if that ever changes.
        if (!line.startsWith("data:")) continue;
        let d = line.slice(5);
        if (d.startsWith(" ")) d = d.slice(1);
        d = d.trim();
        if (!d || d === "[DONE]") continue;
        try {
          const chunkObj = JSON.parse(d);
          const sse = chatToResponses.translate(chunkObj);
          if (sse) out.push(sse);
        } catch {}
      }
      return out.join("");
    }

    upstreamBody.on("data", chunk => {
      if (typeof ctx.markTTFT === "function") ctx.markTTFT();
      const outs = [];
      parser.feed(chunk, line => {
        const chatSSE = anthToChat.translate(line.toString("utf8"));
        const respSSE = pipeChatSSEToResponses(chatSSE);
        if (respSSE) outs.push(respSSE);
      });
      if (outs.length > 0) { res.write(outs.join("")); heartbeat.touch(); }
    });
    upstreamBody.on("end", () => {
      parser.flush(line => {
        const chatSSE = anthToChat.translate(line.toString("utf8"));
        const respSSE = pipeChatSSEToResponses(chatSSE);
        if (respSSE) res.write(respSSE);
      });
      const tail = chatToResponses.finalize();
      if (tail) res.write(tail);
      heartbeat.stop();
      res.end();
      const acc = anthToChat.getAcc();
      if (acc.input_tokens || acc.output_tokens) {
        ctx.attachUsage(acc, {
          model: reqBody.model || anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      ctx.end(statusCode || 200, { backend: backend.provider });
      finish();
    });
    upstreamBody.on("error", err => {
      heartbeat.stop();
      // Persist partial usage before we error out: input_tokens are reported
      // by Anthropic in `message_start`, which often arrives before the
      // stream breaks. Losing them silently makes post-mortem diagnosis
      // harder and distorts dashboard totals.
      const acc = anthToChat.getAcc();
      if (acc && (acc.input_tokens || acc.output_tokens)) {
        ctx.attachUsage(acc, {
          model: reqBody.model || anthropicBody.model || "",
          stream: 1,
          duration_ms: Date.now() - ctx._start,
        });
      }
      const tail = chatToResponses.finalize(err);
      if (tail) {
        try { res.write(tail); } catch {}
      }
      sendUpstreamError({ err, ctx, backend, res, req, finish });
    });
    return;
  }

  // Non-streaming Anthropic → Chat → Responses.
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
      const chatResp = anthropicResponseToOpenAIChat(anthropicResp);
      const responsesResp = openaiChatResponseToResponses(chatResp, reqBody);
      json(res, statusCode || 200, responsesResp, req);
    } catch (convErr) {
      convertOk = false;
      json(res, 502, { error: { message: "Failed to convert Anthropic response to Responses format", type: "upstream_error" } }, req);
      incMetric("upstream_errors");
      ctx.err(502, convErr, { backend: backend.provider });
    }
    if (convertOk) {
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
  const heartbeat = startSSEHeartbeat(res);

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
    if (outs.length > 0) { res.write(outs.join("")); heartbeat.touch(); }
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
    heartbeat.stop();
    res.end();
    const finalUsage = translator.getUsage();
    if (finalUsage) {
      ctx.attachUsage(normalizeUsage(finalUsage), {
        model: reqBody.model || "",
        stream: 1,
        duration_ms: Date.now() - ctx._start,
      });
    }
    ctx.end(statusCode || 200, { backend: backend.provider });
    finish();
  });
  upstreamBody.on("error", err => {
    heartbeat.stop();
    try {
      const tail = translator.finalize(err);
      if (tail) res.write(tail);
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
      incMetric("upstream_errors");
      ctx.err(502, convErr, { backend: backend.provider });
    }
    if (convertOk) {
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
