"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");

describe("handlers_responses - proxyResponsesAsOpenAI", () => {
  function loadHandlersWithMockUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers_responses");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const orig = backend.doUpstream;
    backend.doUpstream = async () => ({
      statusCode,
      headers: { "content-type": "text/event-stream" },
      body: upstreamBody,
      finish: () => {},
    });
    const handlers = require("./handlers_responses");
    return {
      handlers,
      restore() {
        backend.doUpstream = orig;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function loadHandlersWithFailingUpstream(err) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers_responses");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const orig = backend.doUpstream;
    backend.doUpstream = async () => { throw err; };
    const handlers = require("./handlers_responses");
    return {
      handlers,
      restore() {
        backend.doUpstream = orig;
        delete require.cache[handlersPath];
        delete require.cache[backendPath];
      },
    };
  }

  function makeFakeRes() {
    const res = new EventEmitter();
    res.headersSent = false;
    res._chunks = [];
    res._status = null;
    res._ended = false;
    res.writeHead = (s) => { res.headersSent = true; res._status = s; };
    res.write = (c) => { res._chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c); return true; };
    res.end = (c) => { if (c) res._chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c); res._ended = true; };
    res.destroy = () => { res._ended = true; };
    return res;
  }

  function makeCtx(extras = {}) {
    return {
      _start: Date.now(),
      on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, attachBody() {},
      markUpstream() {}, markTTFT() {}, flushOnClose() {},
      ...extras,
    };
  }

  function parseSSEEvents(body) {
    return body.split("\n\n").filter(b => b.trim()).map(b => {
      const event = b.match(/^event: (.+)$/m)?.[1];
      const data = b.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
  }

  it("streams OpenAI Chat chunks back as Responses SSE events", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = { model: "gpt-4o", input: "hi", stream: true };

      const p = handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" world"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
        'data: [DONE]\n\n'
      ));
      upstream.emit("end");
      await p;

      const body = res._chunks.join("");
      const events = parseSSEEvents(body);
      const types = events.map(e => e.event);
      assert.ok(types.includes("response.created"));
      assert.ok(types.includes("response.output_text.delta"));
      assert.ok(types.includes("response.completed"));
      const completed = events.find(e => e.event === "response.completed");
      assert.strictEqual(completed.data.response.output_text, "Hello world");
      assert.deepStrictEqual(completed.data.response.usage, {
        input_tokens: 3, output_tokens: 2, total_tokens: 5,
      });
    } finally {
      restore();
    }
  });

  it("wraps a non-streaming Chat response as a Responses object", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = { model: "gpt-4o", input: "hi", stream: false };

      const p = handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(JSON.stringify({
        id: "cmpl_x", model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      })));
      upstream.emit("end");
      await p;

      const body = res._chunks.join("");
      const resp = JSON.parse(body);
      assert.strictEqual(resp.object, "response");
      assert.strictEqual(resp.status, "completed");
      assert.strictEqual(resp.output_text, "ok");
      assert.deepStrictEqual(resp.usage, { input_tokens: 5, output_tokens: 1, total_tokens: 6 });
    } finally {
      restore();
    }
  });

  it("captures cached_tokens into usage.input_tokens_details", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      let attached = null;
      const ctx = makeCtx({ attachUsage(u) { attached = u; } });
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = { model: "gpt-4o", input: "hi", stream: false };

      const p = handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(JSON.stringify({
        id: "cmpl_x", model: "gpt-4o",
        choices: [{ message: { role: "assistant", content: "cached reply" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 80 } },
      })));
      upstream.emit("end");
      await p;

      const resp = JSON.parse(res._chunks.join(""));
      assert.strictEqual(resp.usage.input_tokens, 100);
      assert.deepStrictEqual(resp.usage.input_tokens_details, { cached_tokens: 80 });
      // OpenAI prompt_tokens already INCLUDES cached — normalizer splits it
      assert.strictEqual(attached.input_tokens, 20);
      assert.strictEqual(attached.cache_read_tokens, 80);
    } finally {
      restore();
    }
  });

  it("renders response.failed when upstream body errors mid-stream", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = { model: "gpt-4o", input: "hi", stream: true };

      const p = handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
      upstream.emit("error", new Error("socket reset"));
      await p;

      const body = res._chunks.join("");
      const events = parseSSEEvents(body);
      assert.ok(events.some(e => e.event === "response.failed"), "response.failed event should be emitted");
      const failed = events.find(e => e.event === "response.failed");
      assert.strictEqual(failed.data.response.status, "failed");
    } finally {
      restore();
    }
  });

  it("returns an error JSON when upstream connect throws before headers", async () => {
    const err = Object.assign(new Error("econnrefused"), { code: "ECONNREFUSED" });
    const { handlers, restore } = loadHandlersWithFailingUpstream(err);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = { model: "gpt-4o", input: "hi" };

      await handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);

      const body = res._chunks.join("");
      const parsed = JSON.parse(body);
      assert.ok(parsed.error);
      assert.ok(/econnrefused/i.test(parsed.error.message));
    } finally {
      restore();
    }
  });

  it("forwards parallel_tool_calls=false to the Chat body", async () => {
    const upstream = new EventEmitter();
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers_responses");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const orig = backend.doUpstream;
    let capturedBody = null;
    backend.doUpstream = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body.toString("utf8"));
      return { statusCode: 200, headers: {}, body: upstream, finish: () => {} };
    };
    const handlers = require("./handlers_responses");
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "http://127.0.0.1/v1", apiKey: "k", type: "openai" };
      const reqBody = {
        model: "gpt-4o",
        input: "hi",
        stream: false,
        parallel_tool_calls: false,
        max_output_tokens: 50,
      };

      const p = handlers.proxyResponsesAsOpenAI(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));
      upstream.emit("data", Buffer.from('{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}'));
      upstream.emit("end");
      await p;

      assert.strictEqual(capturedBody.parallel_tool_calls, false);
      assert.strictEqual(capturedBody.max_tokens, 50);
      assert.strictEqual(capturedBody.max_output_tokens, undefined);
    } finally {
      backend.doUpstream = orig;
      delete require.cache[handlersPath];
      delete require.cache[backendPath];
    }
  });
});

describe("handlers_responses - proxyResponsesAsAnthropic", () => {
  function loadHandlersWithMockUpstream(upstreamBody, statusCode = 200) {
    const backendPath = require.resolve("./backend");
    const handlersPath = require.resolve("./handlers_responses");
    delete require.cache[handlersPath];
    const backend = require("./backend");
    const orig = backend.doUpstream;
    backend.doUpstream = async () => ({
      statusCode,
      headers: { "content-type": "text/event-stream" },
      body: upstreamBody,
      finish: () => {},
    });
    const handlers = require("./handlers_responses");
    return {
      handlers,
      restore() {
        backend.doUpstream = orig;
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
    res.write = (c) => { res._chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c); return true; };
    res.end = (c) => { if (c) res._chunks.push(Buffer.isBuffer(c) ? c.toString("utf8") : c); res._ended = true; };
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
  function parseSSEEvents(body) {
    return body.split("\n\n").filter(b => b.trim()).map(b => {
      const event = b.match(/^event: (.+)$/m)?.[1];
      const data = b.match(/^data: (.+)$/m)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
  }

  it("translates a non-streaming Anthropic Messages response to Responses", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "https://api.anthropic.com", apiKey: "k", type: "anthropic" };
      const reqBody = { model: "claude-3-5-sonnet", input: "hi", stream: false };

      const p = handlers.proxyResponsesAsAnthropic(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-3-5-sonnet",
        content: [{ type: "text", text: "Hello!" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 3 },
      })));
      upstream.emit("end");
      await p;

      const resp = JSON.parse(res._chunks.join(""));
      assert.strictEqual(resp.object, "response");
      assert.strictEqual(resp.output_text, "Hello!");
      assert.strictEqual(resp.usage.input_tokens, 10);
      assert.strictEqual(resp.usage.output_tokens, 3);
    } finally {
      restore();
    }
  });

  it("translates Anthropic SSE stream to Responses events end-to-end", async () => {
    const upstream = new EventEmitter();
    const { handlers, restore } = loadHandlersWithMockUpstream(upstream);
    try {
      const req = { headers: {}, method: "POST" };
      const res = makeFakeRes();
      const ctx = makeCtx();
      const backendCfg = { provider: "test", baseUrl: "https://api.anthropic.com", apiKey: "k", type: "anthropic" };
      const reqBody = { model: "claude-3-5-sonnet", input: "hi", stream: true };

      const p = handlers.proxyResponsesAsAnthropic(req, res, ctx, backendCfg, reqBody);
      await new Promise(r => setImmediate(r));

      upstream.emit("data", Buffer.from(
        'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-3-5-sonnet","usage":{"input_tokens":8,"output_tokens":0}}}\n\n' +
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n' +
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"there"}}\n\n' +
        'data: {"type":"content_block_stop","index":0}\n\n' +
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n' +
        'data: {"type":"message_stop"}\n\n'
      ));
      upstream.emit("end");
      await p;

      const body = res._chunks.join("");
      const events = parseSSEEvents(body);
      const types = events.map(e => e.event);
      assert.ok(types.includes("response.created"));
      assert.ok(types.includes("response.output_text.delta"));
      assert.ok(types.includes("response.completed"));
      const completed = events.find(e => e.event === "response.completed");
      assert.strictEqual(completed.data.response.output_text, "Hi there");
    } finally {
      restore();
    }
  });
});

