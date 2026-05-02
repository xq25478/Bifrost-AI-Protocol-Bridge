"use strict";

const path = require("path");
const { system } = require("./logger");

let BetterSQLite3 = null;
try {
  BetterSQLite3 = require("better-sqlite3");
} catch {}

const DB_PATH = path.join(__dirname, "..", ".runtime", "gateway.db");

let db = null;
let insertStmt = null;
let pruneStmt = null;
let aggregatedStmt = null;
let totalsStmt = null;
let modelsStmt = null;

let batch = [];
let batchTimer = null;
const BATCH_SIZE = 256;
const BATCH_INTERVAL_MS = 500;
const MAX_AGE_DAYS = 365;

// Lightweight in-process query cache. Dashboard auto-refresh / multiple
// reload-debounce paths can otherwise trigger duplicate full-table scans
// every second; a 1.5s TTL is short enough that the UI feels live but long
// enough to absorb burst calls.
const CACHE_TTL_MS = 1500;
const CACHE_MAX_ENTRIES = 64;
const queryCache = new Map();

function cacheKey(kind, from, to) {
  return kind + ":" + from + ":" + to;
}
function readCache(kind, from, to) {
  const k = cacheKey(kind, from, to);
  const hit = queryCache.get(k);
  if (!hit) return undefined;
  if (Date.now() - hit.t > CACHE_TTL_MS) {
    queryCache.delete(k);
    return undefined;
  }
  return hit.v;
}
function writeCache(kind, from, to, v) {
  const k = cacheKey(kind, from, to);
  if (queryCache.size >= CACHE_MAX_ENTRIES) {
    const firstKey = queryCache.keys().next().value;
    if (firstKey) queryCache.delete(firstKey);
  }
  queryCache.set(k, { t: Date.now(), v });
}
function invalidateCache() { queryCache.clear(); }

function open(customPath) {
  if (!BetterSQLite3) {
    system("warn", "better-sqlite3 not installed, persistent token storage disabled");
    return;
  }
  const targetPath = customPath || DB_PATH;
  try {
    db = new BetterSQLite3(targetPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -8000");
    db.pragma("busy_timeout = 3000");
    db.exec(`
      CREATE TABLE IF NOT EXISTS requests (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        rid                 TEXT    NOT NULL,
        ts                  INTEGER NOT NULL,
        model               TEXT    NOT NULL,
        backend             TEXT    NOT NULL,
        endpoint            TEXT    NOT NULL,
        client_format       TEXT    NOT NULL,
        stream              INTEGER NOT NULL,
        status              INTEGER NOT NULL,
        duration_ms         INTEGER NOT NULL,
        input_tokens        INTEGER NOT NULL,
        output_tokens       INTEGER NOT NULL,
        cache_read          INTEGER NOT NULL,
        cache_write         INTEGER NOT NULL,
        ttft_ms             INTEGER NOT NULL DEFAULT 0,
        itl_avg_ms          INTEGER NOT NULL DEFAULT 0,
        input_chars         INTEGER NOT NULL DEFAULT 0
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_requests_ts    ON requests(ts);
      CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model, ts);
    `);
    insertStmt = db.prepare(`
      INSERT INTO requests
        (rid, ts, model, backend, endpoint, client_format, stream, status,
         duration_ms, input_tokens, output_tokens, cache_read, cache_write,
         ttft_ms, itl_avg_ms, input_chars)
      VALUES
        (@rid, @ts, @model, @backend, @endpoint, @client_format, @stream, @status,
         @duration_ms, @input_tokens, @output_tokens, @cache_read, @cache_write,
         @ttft_ms, @itl_avg_ms, @input_chars)
    `);
    pruneStmt = db.prepare("DELETE FROM requests WHERE ts < ?");
    aggregatedStmt = db.prepare(`
      SELECT
        model,
        COUNT(*)                    AS requests,
        SUM(input_tokens)           AS input_tokens,
        SUM(output_tokens)          AS output_tokens,
        SUM(cache_read)             AS cache_read,
        SUM(cache_write)            AS cache_write,
        SUM(input_tokens + output_tokens)           AS total_tokens,
        ROUND(AVG(duration_ms), 1)                  AS avg_duration_ms,
        ROUND(SUM(input_tokens + output_tokens) * 1.0 / NULLIF(SUM(duration_ms), 0) * 1000, 1) AS tokens_per_sec,
        ROUND(COUNT(*) * 1000.0 / NULLIF(MAX(ts) - MIN(ts), 0), 3) AS qps,
        ROUND(AVG(ttft_ms), 1)                      AS avg_ttft_ms,
        ROUND(AVG(itl_avg_ms), 1)                   AS avg_itl_ms,
        ROUND(AVG(input_tokens), 1)                 AS avg_input_tokens,
        ROUND(AVG(output_tokens), 1)                AS avg_output_tokens,
        ROUND(AVG(input_chars), 1)                  AS avg_input_chars
      FROM requests
      WHERE ts >= @from AND ts <= @to
      GROUP BY model
      ORDER BY total_tokens DESC
    `);
    totalsStmt = db.prepare(`
      SELECT
        COUNT(*)                                            AS requests,
        COALESCE(SUM(input_tokens), 0)                      AS input_tokens,
        COALESCE(SUM(output_tokens), 0)                     AS output_tokens,
        COALESCE(SUM(cache_read), 0)                        AS cache_read,
        COALESCE(SUM(cache_write), 0)                       AS cache_write,
        COALESCE(SUM(input_tokens + output_tokens), 0)      AS total_tokens,
        ROUND(AVG(duration_ms), 1)                          AS avg_duration_ms,
        ROUND(COALESCE(SUM(input_tokens + output_tokens), 0) * 1.0 / NULLIF(SUM(duration_ms), 0) * 1000, 1) AS tokens_per_sec,
        ROUND(COUNT(*) * 1000.0 / NULLIF(MAX(ts) - MIN(ts), 0), 3) AS qps,
        ROUND(AVG(ttft_ms), 1)                              AS avg_ttft_ms,
        ROUND(AVG(itl_avg_ms), 1)                           AS avg_itl_ms,
        ROUND(AVG(input_tokens), 1)                         AS avg_input_tokens,
        ROUND(AVG(output_tokens), 1)                        AS avg_output_tokens,
        ROUND(AVG(input_chars), 1)                          AS avg_input_chars,
        MIN(ts)                                             AS first_ts,
        MAX(ts)                                             AS last_ts
      FROM requests
      WHERE ts >= @from AND ts <= @to
    `);
    modelsStmt = db.prepare("SELECT DISTINCT model FROM requests ORDER BY model");
    system("info", "sqlite store opened at " + targetPath + " (WAL, batched)");
  } catch (err) {
    system("error", "failed to open sqlite: " + err.message);
    db = null;
  }
}

function enqueue(row) {
  if (!insertStmt) return;
  batch.push(row);
  if (batch.length >= BATCH_SIZE) flush();
  else if (!batchTimer) batchTimer = setTimeout(flush, BATCH_INTERVAL_MS);
}

function flush() {
  if (!db || !insertStmt || batch.length === 0) return;
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  const rows = batch;
  batch = [];
  try {
    const tx = db.transaction(() => {
      for (const row of rows) insertStmt.run(row);
    });
    tx();
    // any insert invalidates the small cache so the next dashboard refresh
    // sees fresh data
    invalidateCache();
  } catch (err) {
    system("error", "sqlite batch insert failed: " + err.message);
    try { for (const row of rows) insertStmt.run(row); } catch {}
  }
}

function insertRequest(entry) {
  enqueue({
    rid:              entry.rid || "",
    ts:               entry.ts || Date.now(),
    model:            entry.model || "",
    backend:          entry.backend || "",
    endpoint:         entry.endpoint || "",
    client_format:    entry.client_format || "",
    stream:           entry.stream ? 1 : 0,
    status:           entry.status || 0,
    duration_ms:      entry.duration_ms | 0,
    input_tokens:     entry.input_tokens | 0,
    output_tokens:    entry.output_tokens | 0,
    cache_read:       entry.cache_read | 0,
    cache_write:      entry.cache_write | 0,
    ttft_ms:          entry.ttft_ms | 0,
    itl_avg_ms:       entry.itl_avg_ms | 0,
    input_chars:      entry.input_chars | 0,
  });
}

function prune() {
  if (!pruneStmt) return;
  try {
    const cutoff = Date.now() - MAX_AGE_DAYS * 86400 * 1000;
    const info = pruneStmt.run(cutoff);
    if (info.changes > 0) {
      system("info", `pruned ${info.changes} old request rows`);
      invalidateCache();
    }
  } catch (err) {
    system("error", "sqlite prune failed: " + err.message);
  }
}

function queryAggregated(from, to) {
  if (!db) return [];
  const cached = readCache("agg", from, to);
  if (cached !== undefined) return cached;
  try {
    const rows = aggregatedStmt.all({ from, to });
    writeCache("agg", from, to, rows);
    return rows;
  } catch (err) {
    system("error", "sqlite query failed: " + err.message);
    return [];
  }
}

function queryTotals(from, to) {
  if (!db) return null;
  const cached = readCache("tot", from, to);
  if (cached !== undefined) return cached;
  try {
    const row = totalsStmt.get({ from, to });
    writeCache("tot", from, to, row);
    return row;
  } catch (err) {
    system("error", "sqlite totals query failed: " + err.message);
    return null;
  }
}

function queryModels() {
  if (!db) return [];
  try {
    return modelsStmt.all().map(r => r.model);
  } catch { return []; }
}

function close() {
  flush();
  if (db) {
    try { db.close(); } catch {}
    db = null;
    insertStmt = null;
    pruneStmt = null;
    aggregatedStmt = null;
    totalsStmt = null;
    modelsStmt = null;
    invalidateCache();
    system("info", "sqlite store closed");
  }
}

module.exports = {
  open, insertRequest, prune, close, flush,
  queryAggregated, queryTotals, queryModels,
  invalidateCache,
};
