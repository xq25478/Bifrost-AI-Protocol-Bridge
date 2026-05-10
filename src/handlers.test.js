"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const {
  _injectStreamOptions: injectStreamOptions,
  _normalizeAnthropicToolReferences: normalizeAnthropicToolReferences,
} = require("./handlers");

describe("handlers - injectStreamOptions", () => {
  it("adds include_usage when stream=true and stream_options absent", () => {
    const out = injectStreamOptions(JSON.stringify({ model: "x", stream: true, messages: [] }));
    const obj = JSON.parse(out);
    assert.deepStrictEqual(obj.stream_options, { include_usage: true });
    assert.strictEqual(obj.stream, true);
  });

  it("preserves caller-provided stream_options", () => {
    const orig = { model: "x", stream: true, stream_options: { include_usage: false } };
    const out = injectStreamOptions(JSON.stringify(orig));
    assert.strictEqual(out, JSON.stringify(orig));
  });

  it("noop for stream=false", () => {
    const orig = { model: "x", stream: false };
    const out = injectStreamOptions(JSON.stringify(orig));
    assert.strictEqual(out, JSON.stringify(orig));
  });

  it("noop for stream missing", () => {
    const orig = { model: "x" };
    const out = injectStreamOptions(JSON.stringify(orig));
    assert.strictEqual(out, JSON.stringify(orig));
  });

  it("returns input unchanged when JSON parse fails", () => {
    const bogus = "not-json";
    assert.strictEqual(injectStreamOptions(bogus), bogus);
  });
});

describe("handlers - Anthropic passthrough headers", () => {
  function loadHandlersCapturingUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const origDoUpstream = backend.doUpstream;
    let captured = null;
    backend.doUpstream = async (url, options, backendCfg, ctx) => {
      captured = { url, options, backendCfg, ctx };
      return {
        statusCode,
        headers: { "content-type": "application/json", connection: "close" },
        body: upstreamBody,
        finish: () => {},
        abort: () => {},
      };
    };
    const handlers = require("./handlers");
    return {
      handlers,
      captured: () => captured,
      restore() {
        backend.doUpstream = origDoUpstream;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function makeFakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res._status = 0;
    res._headers = {};
    res._chunks = [];
    res._ended = false;
    res._endedPromise = new Promise(resolve => { res._resolveEnd = resolve; });
    res.writeHead = (status, headers) => {
      res.headersSent = true;
      res._status = status;
      res._headers = headers || {};
    };
    res.write = (chunk) => {
      res._chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
      return true;
    };
    res.end = (chunk) => {
      if (chunk) res.write(chunk);
      res._ended = true;
      res._resolveEnd();
    };
    res.destroy = () => {
      res._ended = true;
      res._resolveEnd();
    };
    return res;
  }

  function makeCtx() {
    return {
      rid: "test",
      _start: Date.now(),
      on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, attachBody() {},
      markUpstream() {}, markTTFT() {}, flushOnClose() {},
    };
  }

  it("forwards anthropic-beta while still stripping local credentials", async () => {
    const upstream = new EventEmitter();
    const { handlers, captured, restore } = loadHandlersCapturingUpstream(upstream);
    try {
      const req = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tool-search-2025-10-19,files-api-2025-04-14",
          authorization: "Bearer local-client-token",
          cookie: "sid=local",
        },
      };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = {
        provider: "P",
        baseUrl: "http://upstream.example/anthropic",
        apiKey: "sk-upstream",
        type: "anthropic",
      };
      const body = JSON.stringify({ model: "claude", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });

      await handlers.proxyRequest(req, res, ctx, backendCfg, "/anthropic/v1/messages", body);
      const call = captured();
      assert.ok(call, "expected doUpstream to be called");
      assert.strictEqual(call.options.headers["anthropic-beta"], req.headers["anthropic-beta"]);
      assert.strictEqual(call.options.headers["anthropic-version"], "2023-06-01");
      assert.strictEqual(call.options.headers["x-api-key"], "sk-upstream");
      assert.strictEqual(call.options.headers.authorization, undefined);
      assert.strictEqual(call.options.headers.cookie, undefined);

      upstream.emit("data", Buffer.from("{}"));
      upstream.emit("end");
      await res._endedPromise;
      assert.strictEqual(res._status, 200);
      assert.ok(res._ended);
    } finally {
      restore();
    }
  });

  it("fills missing tool_reference.tool_name from matching tool_use before passthrough", async () => {
    const upstream = new EventEmitter();
    const { handlers, captured, restore } = loadHandlersCapturingUpstream(upstream);
    try {
      const req = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tool-search-2025-10-19",
        },
      };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = {
        provider: "P",
        baseUrl: "http://upstream.example/anthropic",
        apiKey: "sk-upstream",
        type: "anthropic",
      };
      const body = JSON.stringify({
        model: "claude",
        max_tokens: 8,
        tools: [{ name: "Edit", defer_loading: true, input_schema: { type: "object", properties: {} } }],
        messages: [
          { role: "assistant", content: [{ type: "tool_use", id: "toolu_edit", name: "Edit", input: {} }] },
          { role: "user", content: [{
            type: "tool_result",
            tool_use_id: "toolu_edit",
            content: [
              { type: "tool_reference" },
              { type: "tool_reference", tool_reference: {} },
            ],
          }] },
        ],
      });

      await handlers.proxyRequest(req, res, ctx, backendCfg, "/anthropic/v1/messages", body);
      const forwarded = JSON.parse(captured().options.body.toString("utf8"));
      const resultContent = forwarded.messages[1].content[0].content;
      assert.strictEqual(resultContent[0].tool_name, "Edit");
      assert.strictEqual(resultContent[1].tool_name, "Edit");
      assert.strictEqual(resultContent[1].tool_reference.tool_name, "Edit");

      upstream.emit("data", Buffer.from("{}"));
      upstream.emit("end");
      await res._endedPromise;
    } finally {
      restore();
    }
  });
});

describe("handlers - normalizeAnthropicToolReferences", () => {
  it("uses the sole top-level tool as fallback when history lacks the tool_use", () => {
    const body = {
      tools: [{ name: "Read", defer_loading: true }],
      messages: [{ role: "user", content: [{
        type: "tool_result",
        tool_use_id: "missing",
        content: [{ type: "tool_reference" }],
      }] }],
    };
    normalizeAnthropicToolReferences(body);
    assert.strictEqual(body.messages[0].content[0].content[0].tool_name, "Read");
  });
});

describe("handlers - proxyOpenAIDirect streaming SSE framing", () => {
  // Stub backend.doUpstream BEFORE handlers.js captures it via destructuring.
  // Tests reload handlers.js against a fresh require cache to pick up the stub.
  function loadHandlersWithMockUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const origDoUpstream = backend.doUpstream;
    backend.doUpstream = async () => ({
      statusCode,
      headers: { "content-type": "text/event-stream" },
      body: upstreamBody,
      finish: () => {},
    });
    const handlers = require("./handlers");
    return {
      handlers,
      restore() {
        backend.doUpstream = origDoUpstream;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function makeFakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res._chunks = [];
    res._ended = false;
    res.writeHead = (_status, _headers) => { res.headersSent = true; };
    res.write = (chunk) => { res._chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); return true; };
    res.end = (chunk) => { if (chunk) res._chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk); res._ended = true; };
    res.destroy = () => { res._ended = true; };
    return res;
  }

  function makeCtx() {
    return {
      _start: Date.now(),
      on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, attachBody() {},
      markUpstream() {}, markTTFT() {}, flushOnClose() {},
    };
  }

  it("preserves blank-line separators and [DONE] from OpenAI upstream", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const parsedBody = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };

      const p = handlers.proxyOpenAIDirect(req, res, ctx, backendCfg, parsedBody, JSON.stringify(parsedBody));
      // let the async doUpstream resolve and handlers attach listeners
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(
        'data: {"id":"c1","choices":[{"delta":{"content":"hel"}}]}\n\n' +
        'data: {"id":"c1","choices":[{"delta":{"content":"lo"}}]}\n\n'
      ));
      upstream.emit("data", Buffer.from(
        'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n' +
        'data: [DONE]\n\n'
      ));
      upstream.emit("end");
      await p;

      const body = res._chunks.join("");
      // Each event must be terminated by a blank line (\n\n) per SSE spec
      assert.match(body, /data: \{"id":"c1".*"hel".*\}\n\n/);
      assert.match(body, /data: \{"id":"c1".*"lo".*\}\n\n/);
      // [DONE] must be forwarded, not dropped
      assert.match(body, /data: \[DONE\]\n\n/);
      // No two data: lines should be adjacent without a blank line between them
      assert.doesNotMatch(body, /data: [^\n]*\ndata: /);
      assert.ok(res._ended, "response should be ended");
    } finally {
      restore();
    }
  });

  it("captures upstream usage into ctx.attachUsage", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      let captured = null;
      const ctx = { ...makeCtx(), attachUsage(u) { captured = u; } };
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const parsedBody = { model: "m", stream: true, messages: [] };

      const p = handlers.proxyOpenAIDirect(req, res, ctx, backendCfg, parsedBody, JSON.stringify(parsedBody));
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(
        'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":42,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":30}}}\n\n' +
        'data: [DONE]\n\n'
      ));
      upstream.emit("end");
      await p;

      assert.ok(captured, "attachUsage should have been called");
      // OpenAI's prompt_tokens INCLUDES cached; normalizeUsage splits it
      assert.strictEqual(captured.input_tokens, 12);
      assert.strictEqual(captured.output_tokens, 7);
      assert.strictEqual(captured.cache_read_tokens, 30);
    } finally {
      restore();
    }
  });
});

describe("handlers - proxyOpenAIChat conversion failures", () => {
  function loadHandlersWithMockUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const origDoUpstream = backend.doUpstream;
    const origOnSuccess = backend.onBackendSuccess;
    const origOnError = backend.onBackendError;
    const hits = { success: 0, error: 0 };
    backend.doUpstream = async () => ({
      statusCode,
      headers: { "content-type": "application/json" },
      body: upstreamBody,
      finish: () => {},
      abort: () => {},
    });
    backend.onBackendSuccess = () => { hits.success += 1; };
    backend.onBackendError = () => { hits.error += 1; };
    const handlers = require("./handlers");
    return {
      handlers, hits,
      restore() {
        backend.doUpstream = origDoUpstream;
        backend.onBackendSuccess = origOnSuccess;
        backend.onBackendError = origOnError;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function makeFakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res._status = 0;
    res._chunks = [];
    res._ended = false;
    res.writeHead = (status) => { res.headersSent = true; res._status = status; };
    res.write = (chunk) => { res._chunks.push(String(chunk)); return true; };
    res.end = (chunk) => { if (chunk) res._chunks.push(String(chunk)); res._ended = true; };
    res.destroy = () => { res._ended = true; };
    res.getHeader = () => "";
    return res;
  }

  function makeCtx() {
    const errs = [];
    const ends = [];
    return {
      rid: "test",
      _start: Date.now(),
      on() {}, mute() {}, attachUsage() {}, attachBody() {},
      markUpstream() {}, markTTFT() {}, flushOnClose() {},
      end(status) { ends.push(status); },
      err(status, e) { errs.push([status, e && e.message]); },
      _errs: errs, _ends: ends,
    };
  }

  it("records backend error + ctx.err(502) when upstream body is not valid JSON", async () => {
    const upstream = new EventEmitter();
    const { handlers, hits, restore } = loadHandlersWithMockUpstream(upstream, 200);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "P", baseUrl: "http://127/v1", apiKey: "k", type: "openai" };
      const body = { model: "m", stream: false, messages: [{ role: "user", content: "hi" }] };
      const p = handlers.proxyOpenAIChat(req, res, ctx, backendCfg, body);
      await new Promise(r => setImmediate(r));
      upstream.emit("data", Buffer.from("<<<not-json>>>"));
      upstream.emit("end");
      await p;

      // Response must be 502 (conversion failure), not upstream's 200.
      assert.strictEqual(res._status, 502);
      // Should have NOT called onBackendSuccess.
      assert.strictEqual(hits.success, 0, "onBackendSuccess must not fire on convert failure");
      assert.strictEqual(hits.error, 1, "onBackendError should fire exactly once");
      // ctx.err should have been invoked with 502.
      assert.deepStrictEqual(ctx._errs.map(e => e[0]), [502]);
      // ctx.end must not have been called with the upstream 200.
      assert.deepStrictEqual(ctx._ends, []);
    } finally {
      restore();
    }
  });
});

describe("handlers - proxyOpenAIChat streaming termination", () => {
  function loadHandlersWithMockUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const origDoUpstream = backend.doUpstream;
    backend.doUpstream = async () => ({
      statusCode,
      headers: { "content-type": "text/event-stream" },
      body: upstreamBody,
      finish: () => {},
      abort: () => {},
    });
    const handlers = require("./handlers");
    return {
      handlers,
      restore() {
        backend.doUpstream = origDoUpstream;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function makeFakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res._chunks = [];
    res._ended = false;
    res.writeHead = () => { res.headersSent = true; };
    res.write = (c) => { res._chunks.push(String(c)); return true; };
    res.end = (c) => { if (c) res._chunks.push(String(c)); res._ended = true; };
    res.destroy = () => { res._ended = true; };
    res.getHeader = () => "text/event-stream";
    return res;
  }
  function makeCtx() {
    return {
      rid: "test", _start: Date.now(),
      on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, attachBody() {},
      markUpstream() {}, markTTFT() {}, flushOnClose() {},
    };
  }

  it("Anthropic-format SSE never emits a literal `data: [DONE]` terminator", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream, 200);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "P", baseUrl: "http://127/v1", apiKey: "k", type: "openai" };
      const body = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
      const p = handlers.proxyOpenAIChat(req, res, ctx, backendCfg, body);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(
        'data: {"id":"c","choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"id":"c","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
        'data: [DONE]\n\n'
      ));
      upstream.emit("end");
      await p;

      const out = res._chunks.join("");
      // The Anthropic SSE wire never includes `data: [DONE]`; `message_stop`
      // is the canonical terminator. We must not emit OpenAI-style [DONE] to
      // strict Anthropic clients.
      assert.doesNotMatch(out, /data:\s*\[DONE\]/);
      assert.match(out, /"type":"message_stop"/);
      assert.ok(res._ended);
    } finally {
      restore();
    }
  });
});
