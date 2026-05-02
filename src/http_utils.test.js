"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { json } = require("./http_utils");

describe("http_utils - json", () => {
  it("writes JSON response with correct headers", () => {
    let statusCode;
    let headers;
    let body;
    const res = {
      writeHead(code, h) { statusCode = code; headers = h; },
      end(data) { body = data; }
    };
    json(res, 200, { ok: true });
    assert.strictEqual(statusCode, 200);
    assert.strictEqual(headers["content-type"], "application/json");
    assert.strictEqual(headers["access-control-allow-origin"], "*");
    assert.strictEqual(JSON.parse(body).ok, true);
  });

  it("preserves CORS headers for error responses", () => {
    let headers;
    const res = {
      writeHead(code, h) { headers = h; },
      end() {}
    };
    json(res, 404, { error: "not found" });
    assert.strictEqual(headers["access-control-allow-origin"], "*");
    assert.strictEqual(headers["access-control-allow-headers"], "*");
    assert.strictEqual(headers["access-control-allow-methods"], "GET,POST,HEAD,OPTIONS");
  });
});