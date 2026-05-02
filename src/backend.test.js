"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { backends, modelIndex, modelList, availableModelsStr, resolveApiKey, isCircuitOpen, onBackendError, onBackendSuccess, upstreamErrStatus, resetForTest } = require("./backend");

function makeBackend(provider, type) {
  return { provider, type, index: 0, baseUrl: "https://api.example.com", apiKey: "sk-test", models: ["model-a"] };
}

describe("backend - resolveApiKey", () => {
  it("uses backend apiKey when provided", () => {
    const req = { headers: {} };
    assert.strictEqual(resolveApiKey(req, "sk-provided"), "sk-provided");
  });

  it("falls back to Authorization header", () => {
    const req = { headers: { authorization: "Bearer sk-from-header" } };
    assert.strictEqual(resolveApiKey(req, ""), "sk-from-header");
  });

  it("supports mixed-case Authorization header", () => {
    const req = { headers: { Authorization: "Bearer sk-Mixed" } };
    assert.strictEqual(resolveApiKey(req, ""), "sk-Mixed");
  });

  it("returns empty string when no key is available", () => {
    const req = { headers: {} };
    assert.strictEqual(resolveApiKey(req, ""), "");
  });
});

describe("backend - circuit breaker", () => {
  it("circuit is closed by default", () => {
    const b = makeBackend("provider-x", "anthropic");
    assert.strictEqual(isCircuitOpen(b), false);
  });

  it("opens after threshold consecutive errors", () => {
    const b = makeBackend("provider-x", "anthropic");
    const { CIRCUIT_THRESHOLD } = require("./config");
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      assert.strictEqual(isCircuitOpen(b), false);
      onBackendError(b);
    }
    assert.strictEqual(isCircuitOpen(b), true);
  });

  it("resets on success", () => {
    const b = makeBackend("provider-x", "anthropic");
    const { CIRCUIT_THRESHOLD } = require("./config");
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      onBackendError(b);
    }
    assert.strictEqual(isCircuitOpen(b), true);
    onBackendSuccess(b);
    assert.strictEqual(isCircuitOpen(b), false);
    assert.strictEqual(b.consecutiveErrors, 0);
  });

  it("circuit auto-resets after timeout", () => {
    const b = makeBackend("provider-x", "anthropic");
    const { CIRCUIT_THRESHOLD } = require("./config");
    for (let i = 0; i < CIRCUIT_THRESHOLD; i++) {
      onBackendError(b);
    }
    assert.strictEqual(isCircuitOpen(b), true);
    b.circuitOpenUntil = Date.now() - 1000;
    assert.strictEqual(isCircuitOpen(b), false);
  });
});

describe("backend - upstreamErrStatus", () => {
  it("returns 502 for null error", () => {
    assert.strictEqual(upstreamErrStatus(null), 502);
  });

  it("returns 504 for AbortError", () => {
    assert.strictEqual(upstreamErrStatus({ name: "AbortError" }), 504);
  });

  it("returns 504 for undici timeout errors", () => {
    assert.strictEqual(upstreamErrStatus({ code: "UND_ERR_BODY_TIMEOUT" }), 504);
    assert.strictEqual(upstreamErrStatus({ code: "UND_ERR_HEADERS_TIMEOUT" }), 504);
    assert.strictEqual(upstreamErrStatus({ code: "UND_ERR_CONNECT_TIMEOUT" }), 504);
    assert.strictEqual(upstreamErrStatus({ code: "UND_ERR_ABORTED" }), 504);
  });

  it("returns 502 for other errors", () => {
    assert.strictEqual(upstreamErrStatus({ code: "UND_ERR_DISPATCHER_DESTROYED" }), 502);
    assert.strictEqual(upstreamErrStatus({ message: "unknown" }), 502);
  });
});

describe("backend - validateBackends", () => {
  const { validateBackends } = require("./backend");

  it("rejects non-array root", () => {
    assert.strictEqual(validateBackends(null).ok, false);
    assert.strictEqual(validateBackends({}).ok, false);
    assert.strictEqual(validateBackends("x").ok, false);
  });

  it("rejects empty array", () => {
    const r = validateBackends([]);
    assert.strictEqual(r.ok, false);
    assert.match(r.errors[0], /at least one/);
  });

  it("rejects unknown type", () => {
    const r = validateBackends([{ type: "bedrock", provider: "p", baseUrl: "https://x", models: ["m"] }]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /type must be/.test(e)));
  });

  it("rejects bad URL", () => {
    const r = validateBackends([{ type: "openai", provider: "p", baseUrl: "not-a-url", models: ["m"] }]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /baseUrl/.test(e)));
  });

  it("rejects empty models", () => {
    const r = validateBackends([{ type: "openai", provider: "p", baseUrl: "https://x", models: [] }]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /non-empty array/.test(e)));
  });

  it("rejects non-string model entries", () => {
    const r = validateBackends([{ type: "openai", provider: "p", baseUrl: "https://x", models: [42, ""] }]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /non-empty strings/.test(e)));
  });

  it("accepts a well-formed config", () => {
    const r = validateBackends([
      { type: "anthropic", provider: "A", baseUrl: "https://api.anthropic.com", apiKey: "sk-x", models: ["claude"] },
      { type: "openai", provider: "B", baseUrl: "http://localhost/v1", models: ["m1", "m2"] },
    ]);
    assert.strictEqual(r.ok, true, r.errors.join("; "));
    assert.strictEqual(r.errors.length, 0);
  });

  it("tolerates duplicate models across backends (loader will dedupe)", () => {
    const r = validateBackends([
      { type: "openai", provider: "A", baseUrl: "http://x", models: ["dup"] },
      { type: "openai", provider: "B", baseUrl: "http://y", models: ["dup"] },
    ]);
    assert.strictEqual(r.ok, true);
  });
});