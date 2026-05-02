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