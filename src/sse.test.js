"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { createSSEParser, isSSEDataLine, sseDataPayload } = require("./sse");

describe("sse - createSSEParser", () => {
  it("emits complete lines from a single chunk", () => {
    const parser = createSSEParser();
    const lines = [];
    parser.feed(Buffer.from("line1\nline2\n"), l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["line1", "line2"]);
  });

  it("handles CRLF line endings", () => {
    const parser = createSSEParser();
    const lines = [];
    parser.feed(Buffer.from("line1\r\nline2\r\n"), l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["line1", "line2"]);
  });

  it("buffers across chunk boundaries", () => {
    const parser = createSSEParser();
    const lines = [];
    parser.feed(Buffer.from("par"), l => lines.push(l.toString()));
    parser.feed(Buffer.from("tial\nsecond"), l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["partial"]);
    parser.feed(Buffer.from("-end\n"), l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["partial", "second-end"]);
  });

  it("emits tail via flush when no trailing newline", () => {
    const parser = createSSEParser();
    const lines = [];
    parser.feed(Buffer.from("final"), l => lines.push(l.toString()));
    parser.flush(l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["final"]);
  });

  it("flush is idempotent after a clean end", () => {
    const parser = createSSEParser();
    const lines = [];
    parser.feed(Buffer.from("line\n"), l => lines.push(l.toString()));
    parser.flush(l => lines.push(l.toString()));
    assert.deepStrictEqual(lines, ["line"]);
  });
});

describe("sse - data-line helpers", () => {
  it("isSSEDataLine recognizes 'data: ' prefix", () => {
    assert.strictEqual(isSSEDataLine(Buffer.from("data: {}")), true);
    assert.strictEqual(isSSEDataLine(Buffer.from("event: x")), false);
    assert.strictEqual(isSSEDataLine(Buffer.from("data:no-space")), false);
    assert.strictEqual(isSSEDataLine(Buffer.from("")), false);
    assert.strictEqual(isSSEDataLine(Buffer.from("data: ")), true);
  });

  it("sseDataPayload returns trimmed JSON payload", () => {
    assert.strictEqual(sseDataPayload(Buffer.from("data: hello")), "hello");
    assert.strictEqual(sseDataPayload(Buffer.from("data: {\"a\":1}")), '{"a":1}');
    assert.strictEqual(sseDataPayload(Buffer.from("data:  spaced  ")), "spaced");
  });
});
