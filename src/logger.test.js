"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { redactBodySample } = require("./logger");

describe("logger - redactBodySample", () => {
  it("redacts sk- API keys", () => {
    const out = redactBodySample(JSON.stringify({ msg: "hi", k: "sk-abcdef0123456789" }));
    assert.match(out, /sk-abcd\[redacted\]/);
    assert.doesNotMatch(out, /sk-abcdef0123456789/);
  });

  it("redacts pk- API keys", () => {
    const out = redactBodySample(JSON.stringify({ k: "pk-6f09bd31-622a-4f59" }));
    assert.match(out, /pk-6f09\[redacted\]/);
  });

  it("redacts authorization JSON field", () => {
    const out = redactBodySample(JSON.stringify({ authorization: "Bearer secret_token_xxx" }));
    assert.match(out, /"authorization"\s*:\s*"\[redacted\]"/);
  });

  it("redacts Bearer prefix in raw text", () => {
    const out = redactBodySample("Authorization: Bearer abcdef.ghi-123");
    assert.match(out, /Bearer \[redacted\]/);
    assert.doesNotMatch(out, /abcdef\.ghi-123/);
  });

  it("truncates long inputs", () => {
    const big = "x".repeat(5000);
    const out = redactBodySample(big);
    assert.ok(out.length <= 1024 + 20);
    assert.match(out, /\.\.\.\(truncated\)/);
  });

  it("accepts a Buffer", () => {
    const out = redactBodySample(Buffer.from("hello"));
    assert.strictEqual(out, "hello");
  });

  it("returns empty string for null", () => {
    assert.strictEqual(redactBodySample(null), "");
  });
});
