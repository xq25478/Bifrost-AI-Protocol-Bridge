"use strict";

const http = require("http");
const crypto = require("crypto");
const { system, requestlog } = require("./src/logger");
const { incMetric, metricsSnapshot } = require("./src/metrics");
const {
  backends, modelIndex, modelList, availableModelsStr,
  loadBackends, isCircuitOpen, abortAllInFlight,
  doUpstream, upstreamErrStatus, resolveApiKey,
  onBackendError, onBackendSuccess,
} = require("./src/backend");
const { normalizeThinking } = require("./src/thinking");
const { json } = require("./src/http_utils");
const {
  proxyOpenAIChat, proxyAnthropicAsOpenAI,
  proxyOpenAIDirect, proxyRequest,
} = require("./src/handlers");
const {
  PORT, MAX_BODY_SIZE, LOCAL_KEEP_ALIVE_TIMEOUT,
  LOCAL_HEADERS_TIMEOUT, TIMEOUT, SHUTDOWN_DRAIN_MS,
} = require("./src/config");

let store = null;
try { store = require("./src/store"); } catch {}

loadBackends();
if (store && typeof store.open === "function") {
  store.open();
  setInterval(() => { if (store && store.prune) store.prune(); }, 3600_000);
}

// ---- Dashboard server (separate port, no risk of gateway route conflict) ----
const DASHBOARD_PORT = PORT + 1;

const dashboardServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const dp = requestUrl.pathname;

  if (req.method === "GET" && dp === "/") {
    const { dashboardHtml } = require("./src/dashboard_html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
    res.end(dashboardHtml());
    return;
  }


  if (req.method === "GET" && dp === "/api") {
    const from = parseInt(requestUrl.searchParams.get("from") || "0", 10);
    const to = parseInt(requestUrl.searchParams.get("to") || String(Date.now()), 10);
    const totals = (store && store.queryTotals) ? store.queryTotals(from, to) : null;
    const models = (store && store.queryAggregated) ? store.queryAggregated(from, to) : [];
    const body = { totals: totals || {}, models: models || [] };
    if (!store) body._store_unavailable = true;
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    res.end(JSON.stringify(body));
    return;
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,HEAD,OPTIONS" });
    res.end();
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

dashboardServer.listen(DASHBOARD_PORT, "127.0.0.1", () => {
  system("info", "dashboard at http://127.0.0.1:" + DASHBOARD_PORT + " — open in your browser");
});

// ================================================================
// Gateway server
// ================================================================

const server = http.createServer((req, res) => {
  const requestId = crypto.randomUUID().slice(0, 8);
  const requestUrl = new URL(req.url, "http://127.0.0.1");
  const requestPath = requestUrl.pathname;
  const isHealth = (requestPath === "/" || requestPath === "/anthropic") && (req.method === "GET" || req.method === "HEAD");
  const ctx = requestlog(isHealth ? "" : requestId, req.method, req.url);

  if (!isHealth) incMetric("requests_total");

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

  if (req.method === "HEAD" && (requestPath === "/" || requestPath === "/anthropic")) {
    res.writeHead(200);
    res.end();
    ctx.mute();
    return;
  }
  if (req.method === "GET" && (requestPath === "/" || requestPath === "/anthropic")) {
    ctx.end(200);
    // Browser visiting the gateway port — show a hint
    const accept = req.headers.accept || "";
    if (accept.includes("text/html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(`<!DOCTYPE html><html><body style="background:#0d1117;color:#c9d1d9;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center;font-size:14px">
<div><h1 style="font-size:20px;font-weight:600;margin-bottom:8px;color:#58a6ff">OpenProxyRouter</h1>
<p style="color:#8b949e">Gateway is running</p>
<a href="/dashboard" style="display:inline-block;margin-top:12px;padding:8px 20px;background:#238636;color:#fff;border-radius:6px;text-decoration:none;font-weight:500">Open Dashboard →</a>
<p style="margin-top:20px;color:#5c6375;font-size:12px">This is the API proxy port — not a browser URL</p></div></body></html>`);
    }
    return json(res, 200, { ok: true, backends: backends().length, models: modelList().length });
  }

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

  if (req.method === "GET" && requestPath === "/dashboard") {
    const { dashboardHtml } = require("./src/dashboard_html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "access-control-allow-origin": "*" });
    ctx.end(200);
    return res.end(dashboardHtml());
  }


  if (req.method === "GET" && requestPath === "/anthropic/v1/metrics") {
    ctx.end(200);
    return json(res, 200, metricsSnapshot());
  }

  if (req.method === "GET" && requestPath === "/anthropic/v1/models") {
    ctx.end(200);
    return json(res, 200, {
      data: modelList(),
      has_more: false,
      first_id: modelList()[0]?.id || "",
      last_id: modelList()[modelList().length - 1]?.id || ""
    });
  }

  if (req.method === "GET" && requestPath.startsWith("/anthropic/v1/models/")) {
    const modelId = requestPath.slice("/anthropic/v1/models/".length);
    const found = modelIndex()[modelId];
    if (found) {
      ctx.end(200, { model: modelId });
      return json(res, 200, { id: modelId, type: "model", display_name: modelId, created_at: "2026-01-01T00:00:00Z" });
    }
    ctx.end(404, { model: modelId });
    return json(res, 404, { error: { type: "not_found", message: "Model not found" } });
  }

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

    if (requestPath === "/anthropic/v1/messages/count_tokens") {
      if (!bodyBuf) {
        ctx.end(400, { msg: "body required" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Request body is required" } });
      }

      let parsedBody;
      try { parsedBody = JSON.parse(bodyBuf); } catch {
        ctx.end(400, { msg: "invalid JSON" });
        return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
      }

      normalizeThinking(parsedBody);

      const modelId = parsedBody.model;
      const route = modelIndex()[modelId];
      if (!route) {
        ctx.end(404, { model: modelId, msg: "not found" });
        return json(res, 404, { error: { type: "not_found", message: `Model "${modelId}" not found. Available: ${availableModelsStr()}` } });
      }

      const { backend, modelId: backendModelId } = route;
      parsedBody.model = backendModelId;

      if (backend.type !== "anthropic") {
        ctx.end(501, { backend: backend.provider, model: modelId, msg: "count_tokens unsupported" });
        return json(res, 501, { error: { type: "not_implemented", message: `count_tokens is only supported for Anthropic-type backends; model "${modelId}" is routed to ${backend.provider} (${backend.type})` } });
      }

      if (isCircuitOpen(backend)) {
        ctx.end(503, { backend: backend.provider, msg: "circuit open" });
        return json(res, 503, { error: { type: "backend_unavailable", message: `Backend ${backend.provider} is temporarily unavailable` } });
      }

      ctx.on("route", { backend: backend.provider, model: modelId });

      (async () => {
        if (backend.type === "anthropic") {
          // Anthropic backend: forward to native count_tokens endpoint
          const upstreamUrl = new URL(backend.baseUrl.replace(/\/+$/, "") + "/v1/messages/count_tokens");
          if (upstreamUrl.searchParams.has("beta")) upstreamUrl.searchParams.delete("beta");

          const reqBodyBuf = Buffer.from(JSON.stringify(parsedBody));
          const upstreamHeaders = {
            "content-type": "application/json",
            "content-length": reqBodyBuf.length,
            "anthropic-version": "2023-06-01",
            "x-api-key": resolveApiKey(req, backend.apiKey),
            host: upstreamUrl.host,
          };

          let up;
          try {
            up = await doUpstream(upstreamUrl, { method: "POST", headers: upstreamHeaders, body: reqBodyBuf }, backend);
          } catch (err) {
            incMetric("upstream_errors");
            onBackendError(backend);
            const status = upstreamErrStatus(err);
            ctx.err(status, err, { backend: backend.provider });
            if (res.headersSent) { res.destroy(); return; }
            return json(res, status, { error: { type: "upstream_error", message: String(err), code: status } });
          }

          const { statusCode, body: upstreamBody, finish } = up;
          const chunks = [];
          let totalLen = 0;
          upstreamBody.on("data", chunk => { chunks.push(chunk); totalLen += chunk.length; });
          upstreamBody.on("end", () => {
            const buf = Buffer.concat(chunks, totalLen);
            let parsedResp;
            try {
              parsedResp = JSON.parse(buf.toString("utf8"));
            } catch {
              onBackendError(backend);
              ctx.err(502, new Error("invalid upstream response"), { backend: backend.provider });
              finish();
              if (res.headersSent) { res.destroy(); return; }
              return json(res, 502, { error: { type: "upstream_error", message: "Invalid count_tokens response from upstream" } });
            }
            const inputTokens = typeof parsedResp.input_tokens === "number" ? parsedResp.input_tokens : 0;
            ctx.on("count_tokens", { backend: backend.provider, model: modelId, msg: `input_tokens=${inputTokens}` });
            onBackendSuccess(backend);
            ctx.end(statusCode || 200, { backend: backend.provider });
            finish();
            return json(res, statusCode || 200, parsedResp);
          });
          upstreamBody.on("error", err => {
            finish();
            onBackendError(backend);
            incMetric("upstream_errors");
            const status = upstreamErrStatus(err);
            ctx.err(status, err, { backend: backend.provider });
            if (res.headersSent) { res.destroy(); return; }
            return json(res, status, { error: { type: "upstream_error", message: String(err), code: status } });
          });
        } else {
          // OpenAI-compatible backend: send a minimal chat completion to get usage.prompt_tokens
          const openaiBody = anthropicBodyToOpenAIChat(parsedBody);
          openaiBody.stream = false;
          openaiBody.max_tokens = 1;
          const reqBodyBuf = Buffer.from(JSON.stringify(openaiBody));
          const upstreamUrl = new URL("/v1/chat/completions", backend.baseUrl.replace(/\/v1\/?$/, ""));
          const upstreamHeaders = {
            "content-type": "application/json",
            "content-length": reqBodyBuf.length,
            "authorization": `Bearer ${resolveApiKey(req, backend.apiKey)}`,
            host: upstreamUrl.host,
          };

          let up;
          try {
            up = await doUpstream(upstreamUrl, { method: "POST", headers: upstreamHeaders, body: reqBodyBuf }, backend);
          } catch (err) {
            incMetric("upstream_errors");
            onBackendError(backend);
            const status = upstreamErrStatus(err);
            ctx.err(status, err, { backend: backend.provider });
            if (res.headersSent) { res.destroy(); return; }
            return json(res, status, { error: { type: "upstream_error", message: String(err), code: status } });
          }

          const { statusCode, body: upstreamBody, finish } = up;
          const chunks = [];
          let totalLen = 0;
          upstreamBody.on("data", chunk => { chunks.push(chunk); totalLen += chunk.length; });
          upstreamBody.on("end", () => {
            const buf = Buffer.concat(chunks, totalLen);
            let parsedResp;
            try {
              parsedResp = JSON.parse(buf.toString("utf8"));
            } catch {
              onBackendError(backend);
              ctx.err(502, new Error("invalid upstream response"), { backend: backend.provider });
              finish();
              if (res.headersSent) { res.destroy(); return; }
              return json(res, 502, { error: { type: "upstream_error", message: "Invalid count_tokens response from upstream" } });
            }
            const inputTokens = (parsedResp.usage && typeof parsedResp.usage.prompt_tokens === "number")
              ? parsedResp.usage.prompt_tokens : 0;
            ctx.on("count_tokens", { backend: backend.provider, model: modelId, msg: `input_tokens=${inputTokens}` });
            onBackendSuccess(backend);
            ctx.end(statusCode || 200, { backend: backend.provider });
            finish();
            return json(res, 200, { input_tokens: inputTokens });
          });
          upstreamBody.on("error", err => {
            finish();
            onBackendError(backend);
            incMetric("upstream_errors");
            const status = upstreamErrStatus(err);
            ctx.err(status, err, { backend: backend.provider });
            if (res.headersSent) { res.destroy(); return; }
            return json(res, status, { error: { type: "upstream_error", message: String(err), code: status } });
          });
        }
      })();
      return;
    }

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
      const route = modelIndex()[modelId];
      if (!route) {
        ctx.end(404, { model: modelId, msg: "not found" });
        return json(res, 404, { error: { type: "not_found", message: `Model "${modelId}" not found. Available: ${availableModelsStr()}` } });
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
      const route = modelIndex()[modelId];

      if (!route) {
        ctx.end(404, { model: modelId, msg: "not found" });
        return json(res, 404, { error: { type: "not_found", message: `Model "${modelId}" not found. Available: ${availableModelsStr()}` } });
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

let closing = false;

function shutdown(signal) {
  if (closing) return;
  closing = true;
  system("warn", `${signal} received, draining requests for ${SHUTDOWN_DRAIN_MS / 1000}s...`);
  dashboardServer.close(() => {});
  server.close(() => {
    if (store && store.close) store.close();
    system("info", "server closed cleanly");
    process.exit(0);
  });
  setTimeout(() => {
    const pending = require("./src/backend").getInFlightAbortControllers().size;
    system("warn", `drain timeout, aborting ${pending} in-flight upstream requests and forcing exit`);
    abortAllInFlight("shutdown");
    if (store && store.close) store.close();
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