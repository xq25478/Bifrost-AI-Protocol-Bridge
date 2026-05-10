"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { backends, modelIndex, modelList, availableModelsStr, resolveApiKey, upstreamErrStatus, resetForTest, normalizeConfig } = require("./backend");

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

  it("returns empty string when no key is available", () => {
    const req = { headers: {} };
    assert.strictEqual(resolveApiKey(req, ""), "");
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

  it("accepts valid thinking_format values", () => {
    const formats = ["anthropic-standard", "bedrock-adaptive", "chat_template_kwargs", "reasoning_effort", "none"];
    for (const f of formats) {
      const r = validateBackends([
        { type: "openai", provider: "P", baseUrl: "http://x", models: ["m"], thinking_format: f },
      ]);
      assert.strictEqual(r.ok, true, `format=${f}: ${r.errors.join(", ")}`);
    }
  });

  it("rejects invalid thinking_format", () => {
    const r = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: ["m"], thinking_format: "bogus" },
    ]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /thinking_format/.test(e)), r.errors.join(", "));
  });

  it("rejects non-string thinking_format", () => {
    const r = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: ["m"], thinking_format: 42 },
    ]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /thinking_format/.test(e)));
  });

  it("accepts alias object entries {id, upstream}", () => {
    const r = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: [
        "raw-name",
        { id: "claude-sonnet-4-5", upstream: "raw-name" },
      ] },
    ]);
    assert.strictEqual(r.ok, true, r.errors.join("; "));
  });

  it("rejects alias object missing id or upstream", () => {
    const r1 = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: [{ upstream: "m" }] },
    ]);
    assert.strictEqual(r1.ok, false);
    assert.ok(r1.errors.some(e => /entry\.id/.test(e)), r1.errors.join(", "));

    const r2 = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: [{ id: "claude-x" }] },
    ]);
    assert.strictEqual(r2.ok, false);
    assert.ok(r2.errors.some(e => /entry\.upstream/.test(e)), r2.errors.join(", "));
  });

  it("rejects non-string, non-object model entries", () => {
    const r = validateBackends([
      { type: "openai", provider: "P", baseUrl: "http://x", models: [42] },
    ]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.errors.some(e => /strings or \{id, upstream\}/.test(e)), r.errors.join(", "));
  });
});

describe("backend - normalizeConfig route alias resolution", () => {
  it("resolves a route.backend that points to another route name", () => {
    const { arr, errors } = normalizeConfig({
      backends: [
        { provider: "MaaS", protocol: "openai", url: "http://x/v1", apiKey: "k", model: "DeepSeek" },
      ],
      routes: [
        { name: "codex-all", backend: "DeepSeek" },
        { name: "gpt-5", backend: "codex-all" },
        { name: "gpt-5-mini", backend: "codex-all" },
      ],
    });
    assert.deepStrictEqual(errors, []);
    assert.ok(Array.isArray(arr));
    assert.strictEqual(arr.length, 1);
    const ids = arr[0].models.map(m => m.id).sort();
    assert.deepStrictEqual(ids, ["codex-all", "gpt-5", "gpt-5-mini"]);
    for (const m of arr[0].models) assert.strictEqual(m.upstream, "DeepSeek");
  });

  it("still flags routes pointing at a truly unknown backend", () => {
    const { arr, errors } = normalizeConfig({
      backends: [
        { provider: "MaaS", protocol: "openai", url: "http://x/v1", apiKey: "k", model: "DeepSeek" },
      ],
      routes: [
        { name: "x", backend: "no-such-thing" },
      ],
    });
    assert.strictEqual(arr, null);
    assert.ok(errors.some(e => /unknown backend model "no-such-thing"/.test(e)), errors.join(", "));
  });

  it("breaks alias cycles instead of recursing forever", () => {
    const { arr, errors } = normalizeConfig({
      backends: [
        { provider: "MaaS", protocol: "openai", url: "http://x/v1", apiKey: "k", model: "Real" },
      ],
      routes: [
        { name: "a", backend: "b" },
        { name: "b", backend: "a" },
        { name: "ok", backend: "Real" },
      ],
    });
    // a→b→a is a cycle, must surface as error rather than hang.
    assert.strictEqual(arr, null);
    assert.ok(errors.length > 0);
  });
});
