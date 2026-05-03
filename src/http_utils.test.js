"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { json, corsHeaders } = require("./http_utils");
const { PORT } = require("./config");

describe("http_utils - json", () => {
  it("writes JSON response without CORS when no req provided", () => {
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
    assert.strictEqual(headers["access-control-allow-origin"], undefined);
    assert.strictEqual(JSON.parse(body).ok, true);
  });

  it("omits CORS headers when request has no Origin", () => {
    let headers;
    const res = {
      writeHead(code, h) { headers = h; },
      end() {}
    };
    json(res, 200, {}, { headers: {} });
    assert.strictEqual(headers["access-control-allow-origin"], undefined);
  });

  it("echoes allowed origin back", () => {
    let headers;
    const res = {
      writeHead(code, h) { headers = h; },
      end() {}
    };
    const origin = `http://127.0.0.1:${PORT}`;
    json(res, 200, {}, { headers: { origin } });
    assert.strictEqual(headers["access-control-allow-origin"], origin);
    assert.strictEqual(headers.vary, "Origin");
  });

  it("blocks disallowed origins", () => {
    let headers;
    const res = {
      writeHead(code, h) { headers = h; },
      end() {}
    };
    json(res, 200, {}, { headers: { origin: "https://evil.example" } });
    assert.strictEqual(headers["access-control-allow-origin"], undefined);
  });
});

describe("http_utils - corsHeaders", () => {
  it("returns empty for no req", () => {
    assert.deepStrictEqual(corsHeaders(), {});
  });

  it("returns empty for req without Origin", () => {
    assert.deepStrictEqual(corsHeaders({ headers: {} }), {});
  });

  it("returns full headers for allowed origin", () => {
    const origin = `http://localhost:${PORT}`;
    const h = corsHeaders({ headers: { origin } });
    assert.strictEqual(h["access-control-allow-origin"], origin);
    assert.ok(h["access-control-allow-headers"]);
    assert.ok(h["access-control-allow-methods"]);
    assert.strictEqual(h.vary, "Origin");
  });
});
