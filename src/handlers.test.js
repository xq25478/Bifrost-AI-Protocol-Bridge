"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

const { _injectStreamOptions: injectStreamOptions } = require("./handlers");

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
