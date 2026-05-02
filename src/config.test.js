"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const config = require("./config");

describe("config", () => {
  it("defines PORT", () => {
    assert.strictEqual(typeof config.PORT, "number");
    assert.ok(config.PORT > 0);
  });

  it("defines timeout values", () => {
    assert.ok(config.TIMEOUT > 0);
    assert.ok(config.LOCAL_KEEP_ALIVE_TIMEOUT > 0);
    assert.ok(config.LOCAL_HEADERS_TIMEOUT > 0);
  });

  it("defines HOP_BY_HOP headers", () => {
    assert.ok(config.HOP_BY_HOP.has("transfer-encoding"));
    assert.ok(config.HOP_BY_HOP.has("connection"));
  });

  it("defines thinking effort constants", () => {
    assert.strictEqual(config.DEFAULT_THINKING_EFFORT, "max");
    assert.ok(config.SUPPORTED_THINKING_EFFORTS.has("low"));
    assert.ok(config.SUPPORTED_THINKING_EFFORTS.has("max"));
  });

  it("defines circuit breaker config", () => {
    assert.ok(config.CIRCUIT_THRESHOLD > 0);
    assert.ok(config.CIRCUIT_OPEN_MS > 0);
  });

  it("defines shutdown drain time", () => {
    assert.ok(config.SHUTDOWN_DRAIN_MS > 0);
  });

  it("defines dispatcher options", () => {
    assert.strictEqual(config.DISPATCHER_OPTIONS.connections, 256);
  });

  it("defines retryable codes", () => {
    assert.ok(config.RETRYABLE_CODES.has("ECONNREFUSED"));
    assert.ok(config.RETRYABLE_CODES.has("EAI_AGAIN"));
  });
});