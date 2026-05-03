"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { buildStartupBanner } = require("./startup_banner");

test("buildStartupBanner - first line names the product and base URL", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 2, modelCount: 7 });
  assert.match(lines[0], /^OpenProxyRouter listening on http:\/\/127\.0\.0\.1:4000$/);
});

test("buildStartupBanner - second line points at the dashboard", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 0, modelCount: 0 });
  assert.strictEqual(lines[1], "dashboard: http://127.0.0.1:4000/dashboard");
});

test("buildStartupBanner - reports loaded backends and model counts", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 3, modelCount: 11 });
  assert.ok(lines.some(l => /loaded 3 backend\(s\), 11 model\(s\)/.test(l)));
});

test("buildStartupBanner - lists all three client protocols with URLs", () => {
  const lines = buildStartupBanner({ port: 8080, backendCount: 1, modelCount: 1 });
  const joined = lines.join("\n");
  // Anthropic base-URL for the Claude SDK/CLI (SDK appends /v1/messages).
  assert.ok(/Anthropic Messages.*http:\/\/127\.0\.0\.1:8080\/anthropic(\s|$)/.test(joined),
    "banner should describe Anthropic base URL");
  // OpenAI Chat Completions base-URL (SDK appends /chat/completions).
  assert.ok(/OpenAI Chat Completions.*http:\/\/127\.0\.0\.1:8080\/anthropic\/v1/.test(joined),
    "banner should describe OpenAI Chat Completions base URL");
  // OpenAI Responses base-URL (SDK appends /responses).
  assert.ok(/OpenAI Responses.*http:\/\/127\.0\.0\.1:8080\/anthropic\/v1/.test(joined),
    "banner should describe OpenAI Responses base URL");
});

test("buildStartupBanner - honors a non-default host", () => {
  const lines = buildStartupBanner({ host: "0.0.0.0", port: 4000, backendCount: 0, modelCount: 0 });
  assert.ok(lines[0].includes("http://0.0.0.0:4000"));
  assert.ok(lines[1].includes("http://0.0.0.0:4000/dashboard"));
});

test("buildStartupBanner - handles zero backends and zero models gracefully", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 0, modelCount: 0 });
  assert.ok(lines.some(l => /loaded 0 backend\(s\), 0 model\(s\)/.test(l)));
});

test("buildStartupBanner - rejects invalid ports", () => {
  assert.throws(() => buildStartupBanner({ port: 0 }), /invalid port/);
  assert.throws(() => buildStartupBanner({ port: -1 }), /invalid port/);
  assert.throws(() => buildStartupBanner({ port: 70000 }), /invalid port/);
  assert.throws(() => buildStartupBanner({ port: "4000" }), /invalid port/);
  assert.throws(() => buildStartupBanner({}), /invalid port/);
});

test("buildStartupBanner - returns plain string lines (no ANSI)", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 1, modelCount: 1 });
  for (const line of lines) {
    assert.strictEqual(typeof line, "string");
    assert.ok(!/\x1b\[/.test(line), `banner line should not contain ANSI: ${JSON.stringify(line)}`);
  }
});

test("buildStartupBanner - returns exactly the documented number of lines", () => {
  const lines = buildStartupBanner({ port: 4000, backendCount: 1, modelCount: 1 });
  // 3 header lines + 1 configuration intro + 3 protocol lines = 7
  assert.strictEqual(lines.length, 7);
});
