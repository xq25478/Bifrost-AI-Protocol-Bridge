"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

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
