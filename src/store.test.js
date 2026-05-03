"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("./store");

describe("store - sqlite persistence", () => {
  let dbPath;
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "opr-store-"));
    dbPath = path.join(tmpDir, "test.db");
    store.open(dbPath);
  });

  after(() => {
    store.close();
    try {
      for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f));
      fs.rmdirSync(tmpDir);
    } catch {}
  });

  it("inserts and queries totals", () => {
    const now = Date.now();
    store.insertRequest({
      rid: "test-1", ts: now, model: "model-a", backend: "p", endpoint: "/v1/messages",
      client_format: "anthropic", stream: 1, status: 200, duration_ms: 1000,
      input_tokens: 100, output_tokens: 50, cache_read: 10, cache_write: 0,
    });
    store.insertRequest({
      rid: "test-2", ts: now, model: "model-a", backend: "p", endpoint: "/v1/messages",
      client_format: "anthropic", stream: 0, status: 200, duration_ms: 2000,
      input_tokens: 200, output_tokens: 100, cache_read: 20, cache_write: 0,
    });
    store.insertRequest({
      rid: "test-3", ts: now, model: "model-b", backend: "p", endpoint: "/v1/messages",
      client_format: "anthropic", stream: 1, status: 200, duration_ms: 500,
      input_tokens: 50, output_tokens: 25, cache_read: 0, cache_write: 0,
    });
    store.flush();

    const totals = store.queryTotals(now - 1000, now + 1000);
    assert.ok(totals);
    assert.strictEqual(totals.requests, 3);
    assert.strictEqual(totals.input_tokens, 350);
    assert.strictEqual(totals.output_tokens, 175);
    assert.strictEqual(totals.cache_read, 30);
    assert.strictEqual(totals.total_tokens, 525);
  });

  it("aggregates per model", () => {
    const rows = store.queryAggregated(0, Date.now() + 1000);
    const byModel = {};
    for (const r of rows) byModel[r.model] = r;
    assert.strictEqual(byModel["model-a"].requests, 2);
    assert.strictEqual(byModel["model-a"].input_tokens, 300);
    assert.strictEqual(byModel["model-a"].output_tokens, 150);
    assert.strictEqual(byModel["model-b"].requests, 1);
    assert.strictEqual(byModel["model-b"].input_tokens, 50);
  });

  it("queryModels returns distinct model names", () => {
    const models = store.queryModels();
    assert.ok(models.includes("model-a"));
    assert.ok(models.includes("model-b"));
  });

  it("returns null totals for empty range", () => {
    const totals = store.queryTotals(0, 1);
    assert.strictEqual(totals.requests, 0);
    assert.strictEqual(totals.input_tokens, 0);
  });

  it("batch flush respects integer coercion", () => {
    const now = Date.now();
    store.insertRequest({
      rid: "frac", ts: now, model: "m", backend: "p", endpoint: "/x",
      client_format: "x", stream: 0, status: 200, duration_ms: 12.7,
      input_tokens: 1.9, output_tokens: 2.1, cache_read: 0, cache_write: 0,
    });
    store.flush();
    const rows = store.queryAggregated(now - 100, now + 100);
    const m = rows.find(r => r.model === "m");
    assert.strictEqual(m.input_tokens, 1);
    assert.strictEqual(m.output_tokens, 2);
  });

  it("query cache returns identical reference within TTL", () => {
    const now = Date.now();
    const a = store.queryTotals(0, now + 1000);
    const b = store.queryTotals(0, now + 1000);
    assert.strictEqual(a, b, "cached call should return same object reference");
  });

  it("insert invalidates query cache", () => {
    const now = Date.now();
    const before = store.queryTotals(0, now + 10000);
    store.insertRequest({
      rid: "cache-bust", ts: now, model: "model-z", backend: "p", endpoint: "/x",
      client_format: "x", stream: 0, status: 200, duration_ms: 1,
      input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
    });
    store.flush();
    const after = store.queryTotals(0, now + 10000);
    assert.notStrictEqual(before, after, "after insert+flush, query should not return cached object");
    assert.strictEqual(after.requests, before.requests + 1);
  });

  it("tolerates out-of-band schema change without crashing", () => {
    // Simulate another process performing a migration against the same DB
    // while this process already holds a prepared INSERT targeting the old
    // column name. This is the exact scenario that produced the real-world
    // "table requests has no column named input_chars" error.
    const BetterSQLite3 = require("better-sqlite3");
    const raw = new BetterSQLite3(dbPath);
    try {
      raw.exec("ALTER TABLE requests RENAME COLUMN input_bytes TO scratch_col");
    } finally {
      raw.close();
    }
    try {
      const now = Date.now();
      assert.doesNotThrow(() => {
        store.insertRequest({
          rid: "schema-race", ts: now, model: "m", backend: "p", endpoint: "/x",
          client_format: "x", stream: 0, status: 200, duration_ms: 1,
          input_tokens: 1, output_tokens: 1, cache_read: 0, cache_write: 0,
        });
        store.flush();
      });
    } finally {
      // Restore the column so `after` cleanup and any downstream tests do not
      // inherit a broken schema.
      const raw2 = new BetterSQLite3(dbPath);
      try {
        raw2.exec("ALTER TABLE requests RENAME COLUMN scratch_col TO input_bytes");
      } finally {
        raw2.close();
      }
    }
  });

  it("recovers batch inserts after recompiling a stale prepared statement", () => {
    // Rename the column twice (input_bytes → tmp → input_bytes). The final
    // schema is identical to the original, so a recompile of the INSERT
    // succeeds — but the store's originally-prepared statement was compiled
    // against the pre-rename column identity, so in a live DB with an
    // out-of-band writer, re-preparing is what lets the insert succeed.
    // We exercise this by forcing a flush through the repair path.
    const BetterSQLite3 = require("better-sqlite3");
    const raw = new BetterSQLite3(dbPath);
    try {
      raw.exec("ALTER TABLE requests RENAME COLUMN input_bytes TO tmp_mig");
      raw.exec("ALTER TABLE requests RENAME COLUMN tmp_mig TO input_bytes");
    } finally {
      raw.close();
    }
    const now = Date.now();
    store.insertRequest({
      rid: "rerepare", ts: now, model: "m-reprepare", backend: "p", endpoint: "/x",
      client_format: "x", stream: 0, status: 200, duration_ms: 1,
      input_tokens: 7, output_tokens: 3, cache_read: 0, cache_write: 0,
    });
    store.flush();
    const rows = store.queryAggregated(now - 100, now + 100);
    const m = rows.find(r => r.model === "m-reprepare");
    assert.ok(m, "the row inserted after schema round-trip should be visible");
    assert.strictEqual(m.input_tokens, 7);
    assert.strictEqual(m.output_tokens, 3);
  });
});
