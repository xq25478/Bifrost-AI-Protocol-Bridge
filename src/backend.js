"use strict";

const fs = require("fs");
const path = require("path");
const { Agent: UndiciAgent, request: undiciRequest } = require("undici");
const { system } = require("./logger");
const { BACKENDS_PATH, TIMEOUT, DISPATCHER_OPTIONS, RETRYABLE_CODES } = require("./config");
const { VALID_THINKING_FORMATS } = require("./thinking");

let backends = [];
let modelIndex = {};
let modelList = [];
let availableModelsStr = "";

const dispatcher = new UndiciAgent(DISPATCHER_OPTIONS);

const inFlightAbortControllers = new Set();

function upstreamErrStatus(err) {
  if (!err) return 502;
  if (err.name === "AbortError") return 504;
  const code = err.code;
  if (code === "UND_ERR_ABORTED" || code === "UND_ERR_BODY_TIMEOUT" ||
      code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_CONNECT_TIMEOUT") return 504;
  return 502;
}

function isTransientConnectError(err) {
  return !!(err && RETRYABLE_CODES.has(err.code));
}

/**
 * Call an upstream URL with automatic retry on transient connection errors.
 * Returns { statusCode, headers, body, finish, signal }.
 *
 * If `ctx` is provided, emits an "upstream" event before the call and tracks
 * upstream call timing for the request log.
 */
async function doUpstream(url, options, backend, ctx) {
  const ac = new AbortController();
  inFlightAbortControllers.add(ac);
  // Idle (inactivity) timeout — reset every time we observe activity from
  // the upstream, so a long-running response (e.g. extended thinking +
  // long generation that takes 10+ minutes wall-clock but never stalls)
  // is not killed by a wall-clock cap. The previous implementation used a
  // single `setTimeout(TIMEOUT)` armed at request start, which silently
  // truncated streams once a single hard wall (default 5 min) elapsed —
  // observed by callers as "output stops mid-sentence".
  let timer = setTimeout(() => ac.abort("timeout"), TIMEOUT);
  const armed = { current: true };
  const resetIdleTimer = () => {
    if (!armed.current) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ac.abort("timeout"), TIMEOUT);
  };
  const finish = () => {
    armed.current = false;
    if (timer) { clearTimeout(timer); timer = null; }
    inFlightAbortControllers.delete(ac);
  };
  const call = () => undiciRequest(url, { ...options, signal: ac.signal, dispatcher });

  if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("start");
  if (ctx && typeof ctx.on === "function") {
    ctx.on("upstream", { backend: backend && backend.provider, url: String(url) });
  }

  let r;
  try {
    r = await call();
  } catch (err) {
    if (isTransientConnectError(err) && !ac.signal.aborted) {
      try {
        r = await call();
      } catch (err2) {
        if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("end");
        finish();
        throw err2;
      }
    } else {
      if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("end");
      finish();
      throw err;
    }
  }
  if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("end");
  // Now that headers are in, switch the timer into idle mode: each chunk
  // of response body resets the watchdog. Idle silence longer than TIMEOUT
  // (default 5 min) still aborts — that's long enough to forgive thinking
  // mode pauses without letting truly stuck connections hang forever.
  resetIdleTimer();
  if (r.body && typeof r.body.on === "function") {
    r.body.on("data", resetIdleTimer);
  }
  const abort = (reason) => { try { ac.abort(reason); } catch {} };
  return { statusCode: r.statusCode, headers: r.headers, body: r.body, finish, signal: ac.signal, abort };
}

/**
 * Normalize parsed JSON into the internal array-of-backends shape that
 * the rest of the loader expects. Accepts two input shapes:
 *
 *   1. Legacy flat array:  [{type, provider, baseUrl, models:[...]}, ...]
 *      Returned as-is.
 *
 *   2. Recommended two-section shape:
 *        {
 *          "backends": [   // local upstream services — where + how to call them
 *            { protocol, url, apiKey, model, thinking_format?, provider? }
 *            // `model` is the upstream-accepted model name AND the
 *            // identifier used by routes to reference this backend.
 *          ],
 *          "routes":   [   // gateway-exposed names → local backend
 *            { name, backend }
 *            // `backend` references a backends[].model value.
 *          ]
 *        }
 *      Each route becomes a client-facing model id that forwards to its
 *      backend's native `model` (the upstream-accepted model name).
 *      Adding / removing exposed names is a one-line edit in `routes`.
 *
 * Returns { arr, errors }. On structural failure `arr` is null.
 * Field-level validation (type/baseUrl/thinking_format/…) still runs
 * downstream in validateBackends.
 */
// Load API keys from a sidecar file. Path resolution rules:
//   - If absolute, use as-is.
//   - Otherwise resolve relative to the directory containing backends.json.
// File format: one key per line. Lines starting with '#' or empty are skipped.
// Each key gets a default weight of 1 unless the line uses the form
//   "<key> <weight>"  (whitespace-separated).
function loadKeysFromFile(file) {
  const base = path.dirname(BACKENDS_PATH);
  const abs = path.isAbsolute(file) ? file : path.join(base, file);
  const raw = fs.readFileSync(abs, "utf8");
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const parts = t.split(/\s+/);
    const key = parts[0];
    const weight = parts[1] ? Math.max(1, parseInt(parts[1], 10) || 1) : 1;
    if (key) out.push({ key, weight });
  }
  return out;
}

/**
 * Persist a list of {key, weight} entries back to the apiKeysFile. Written
 * as "<key> <weight>" lines (sorted by key so the file is human-readable).
 * Service restart will read this file via loadKeysFromFile, making the
 * scheduler weights durable across restarts.
 *
 * Writes are batched: at most one write per 5s, so rapid successive weight
 * updates (e.g. many parallel 200s) don't thrash the disk.
 */
const _saveThrottle = new Map();
function saveKeysToFile(file, entries) {
  const base = path.dirname(BACKENDS_PATH);
  const abs = path.isAbsolute(file) ? file : path.join(base, file);
  const now = Date.now();
  const last = _saveThrottle.get(abs) || 0;
  if (now - last < 5_000) return;
  _saveThrottle.set(abs, now);
  const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
  const lines = sorted.map(e => `${e.key} ${Math.max(1, e.weight)}`);
  try {
    fs.writeFileSync(abs, lines.join("\n") + "\n", "utf8");
  } catch {
    // Non-critical — weights live in memory and survive a full round of
    // failures before hitting disk; a lost write is harmless.
  }
}

function normalizeConfig(parsed) {
  if (Array.isArray(parsed)) return { arr: parsed, errors: [] };
  if (!parsed || typeof parsed !== "object") {
    return { arr: null, errors: ["root must be an array or {backends, routes} object"] };
  }
  const { backends, routes } = parsed;
  const errors = [];
  if (!Array.isArray(backends)) errors.push("backends must be an array");
  if (!Array.isArray(routes)) errors.push("routes must be an array");
  if (errors.length) return { arr: null, errors };

  const byModel = new Map();
  for (const b of backends) {
    if (!b || typeof b !== "object") {
      errors.push(`invalid backend entry: ${JSON.stringify(b)}`);
      continue;
    }
    const { protocol, url, apiKey, apiKeys, apiKeysFile, model, thinking_format, provider } = b;
    if (typeof model !== "string" || !model.trim()) {
      errors.push(`backend missing .model (upstream model name): ${JSON.stringify(b)}`);
      continue;
    }
    if (byModel.has(model)) {
      errors.push(`duplicate backend model: "${model}"`);
      continue;
    }
    // Build the list of {key, weight} entries from any of three sources:
    //   - apiKey      : single string. When present it is EXCLUSIVE — only
    //                   this key is scheduled, and apiKeys / apiKeysFile are
    //                   ignored for this backend. Useful for pinning a known-
    //                   good key during incidents; flips back automatically on
    //                   the next hot-reload once apiKey is removed.
    //   - apiKeysFile : load lines from a sidecar text file (recommended for
    //                   long lists; keep secrets out of backends.json).
    //   - apiKeys     : inline array of strings or {key, weight} objects.
    // When apiKey is absent, apiKeysFile entries are followed by inline
    // apiKeys, with later duplicates of the same key dropped (first wins).
    const keyArr = [];
    const seen = new Set();
    function addKey(key, weight) {
      if (!key || seen.has(key)) return;
      seen.add(key);
      keyArr.push({ key, weight: Math.max(1, weight || 1) });
    }
    if (typeof apiKey === "string" && apiKey.trim()) {
      // Exclusive pin: schedule only this key. Other sources are intentionally
      // ignored so operators can hot-pin a single key by editing backends.json
      // without having to touch the sidecar key file.
      addKey(apiKey.trim(), 1);
    } else {
      if (typeof apiKeysFile === "string" && apiKeysFile.trim()) {
        try {
          for (const e of loadKeysFromFile(apiKeysFile)) addKey(e.key, e.weight);
        } catch (err) {
          errors.push(`backend "${model}" apiKeysFile load failed: ${err.message}`);
        }
      }
      if (Array.isArray(apiKeys)) {
        for (const e of apiKeys) {
          if (typeof e === "string") addKey(e, 1);
          else if (e && typeof e === "object") addKey(e.key, e.weight);
        }
      }
    }
    if (keyArr.length === 0) keyArr.push({ key: "", weight: 1 });
    // Stash apiKeysFile on the key array so resolveApiKey can pass it through
    // to the scheduler for weight persistence on restart.
    if (typeof apiKeysFile === "string" && apiKeysFile.trim()) keyArr._keysFile = apiKeysFile.trim();
    byModel.set(model, {
      provider: provider || model,
      type: protocol,
      baseUrl: url,
      apiKey: keyArr,
      apiKeysFile: (typeof apiKeysFile === "string" && apiKeysFile.trim()) ? apiKeysFile : "",
      thinking_format,
      _upstreamModel: model,
      models: [],
    });
  }
  if (errors.length) return { arr: null, errors };

  // Route-level backend alias resolution: a route.backend can reference
  // another route's name (e.g. "codex-all"). This lets you redirect a set
  // of client model names by changing one entry rather than N.
  //
  // Example:
  //   { "name": "codex-all",   "backend": "DeepSeek-V4-Flash-FP8" }
  //   { "name": "gpt-5.4",     "backend": "codex-all" }  // resolves to DeepSeek-V4-Flash-FP8
  //
  // Cycles are guarded by a `seen` set: any key encountered twice during a
  // single resolution short-circuits, so a self-reference or longer cycle
  // surfaces as an "unknown backend model" error rather than infinite
  // recursion.
  function resolveAlias(key, seen) {
    if (byModel.has(key)) return key;
    if (seen.has(key)) return key; // cycle
    seen.add(key);
    for (const r of routes) {
      if (r && typeof r.name === "string" && r.name.trim() === key) {
        const bk = typeof r.backend === "string" ? r.backend.trim() : "";
        if (bk && bk !== key) return resolveAlias(bk, seen);
        break;
      }
    }
    return key;
  }

  for (const r of routes) {
    if (!r || typeof r !== "object") {
      errors.push(`invalid route entry: ${JSON.stringify(r)}`);
      continue;
    }
    const name = typeof r.name === "string" ? r.name.trim() : "";
    let backendKey = typeof r.backend === "string" ? r.backend.trim() : "";
    if (!name) { errors.push(`route missing .name: ${JSON.stringify(r)}`); continue; }
    if (!backendKey) { errors.push(`route "${name}" missing .backend`); continue; }
    // Resolve one level of alias before looking up byModel.
    if (!byModel.has(backendKey)) {
      const resolved = resolveAlias(backendKey, new Set());
      if (resolved !== backendKey) backendKey = resolved;
    }
    const target = byModel.get(backendKey);
    if (!target) { errors.push(`route "${name}" references unknown backend model "${backendKey}"`); continue; }
    target.models.push({ id: name, upstream: target._upstreamModel });
  }

  for (const b of byModel.values()) delete b._upstreamModel;

  if (errors.length) return { arr: null, errors };
  const result = Array.from(byModel.values()).filter(b => b.models.length > 0);
  if (result.length === 0) {
    errors.push("no routes map to any backend — at least one route is required via the 'routes' section");
    return { arr: null, errors };
  }
  return { arr: result, errors: [] };
}

/**
 * Validate a parsed backends array. Returns { ok, errors[] }.
 * Pure function — does not touch module-level state.
 */
function validateBackends(arr) {
  const errors = [];
  if (!Array.isArray(arr)) {
    return { ok: false, errors: ["root must be an array"] };
  }
  if (arr.length === 0) {
    return { ok: false, errors: ["at least one backend is required"] };
  }
  const seenModels = new Set();
  for (let i = 0; i < arr.length; i++) {
    const b = arr[i];
    const tag = `backend[${i}]` + (b && b.provider ? ` (${b.provider})` : "");
    if (!b || typeof b !== "object") { errors.push(`${tag}: must be an object`); continue; }
    if (b.type !== "anthropic" && b.type !== "openai") {
      errors.push(`${tag}: type must be "anthropic" or "openai", got ${JSON.stringify(b.type)}`);
    }
    if (typeof b.provider !== "string" || !b.provider.trim()) {
      errors.push(`${tag}: provider must be a non-empty string`);
    }
    if (typeof b.baseUrl !== "string" || !b.baseUrl.trim()) {
      errors.push(`${tag}: baseUrl must be a non-empty string`);
    } else {
      try { new URL(b.baseUrl); }
      catch { errors.push(`${tag}: baseUrl is not a valid URL: ${b.baseUrl}`); }
    }
    if (b.apiKeysFile !== undefined && (typeof b.apiKeysFile !== "string" || !b.apiKeysFile.trim())) {
      errors.push(`${tag}: apiKeysFile must be a non-empty string when present`);
    }
    if (b.apiKeys !== undefined) {
      if (!Array.isArray(b.apiKeys)) {
        errors.push(`${tag}: apiKeys must be an array`);
      } else if (b.apiKeys.length === 0) {
        errors.push(`${tag}: apiKeys must be a non-empty array`);
      } else {
        for (let ki = 0; ki < b.apiKeys.length; ki++) {
          const e = b.apiKeys[ki];
          if (typeof e === "string") continue; // bare key string
          if (e && typeof e === "object" && typeof e.key === "string" && e.key) continue;
          errors.push(`${tag}: apiKeys[${ki}] must be a string or {key: string, weight?: number}`);
        }
      }
    } else if (b.apiKeysFile === undefined && b.apiKey !== undefined) {
      // Accept either a string (raw config) or an array of {key,weight}
      // entries (post-normalisation). Any other type is invalid.
      if (typeof b.apiKey === "string") {
        if (!b.apiKey) errors.push(`${tag}: apiKey must be a non-empty string when present`);
      } else if (Array.isArray(b.apiKey)) {
        if (b.apiKey.length === 0) errors.push(`${tag}: apiKey array must not be empty`);
      } else {
        errors.push(`${tag}: apiKey must be a string or an array of {key,weight} entries`);
      }
    }
    if (b.thinking_format !== undefined) {
      if (typeof b.thinking_format !== "string" || !VALID_THINKING_FORMATS.has(b.thinking_format)) {
        errors.push(`${tag}: thinking_format must be one of ${Array.from(VALID_THINKING_FORMATS).join(", ")}, got ${JSON.stringify(b.thinking_format)}`);
      }
    }
    if (!Array.isArray(b.models) || b.models.length === 0) {
      errors.push(`${tag}: models must be a non-empty array`);
    } else {
      for (const m of b.models) {
        if (typeof m === "string") {
          if (!m.trim()) {
            errors.push(`${tag}: model entries must be non-empty strings, got ${JSON.stringify(m)}`);
          } else if (!seenModels.has(m)) {
            seenModels.add(m);
          }
        } else if (m && typeof m === "object" && !Array.isArray(m)) {
          if (typeof m.id !== "string" || !m.id.trim()) {
            errors.push(`${tag}: model entry.id must be a non-empty string, got ${JSON.stringify(m)}`);
          } else if (typeof m.upstream !== "string" || !m.upstream.trim()) {
            errors.push(`${tag}: model entry.upstream must be a non-empty string, got ${JSON.stringify(m)}`);
          } else if (!seenModels.has(m.id)) {
            seenModels.add(m.id);
          }
        } else {
          errors.push(`${tag}: model entries must be non-empty strings or {id, upstream} objects, got ${JSON.stringify(m)}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

function loadBackends() {
  let raw, configs;
  try {
    raw = fs.readFileSync(BACKENDS_PATH, "utf8");
  } catch (err) {
    system("error", `failed to read ${BACKENDS_PATH}: ${err.message}`);
    return false;
  }
  try {
    configs = JSON.parse(raw);
  } catch (err) {
    system("error", `backends.json is not valid JSON: ${err.message}`);
    return false;
  }
  const norm = normalizeConfig(configs);
  if (!norm.arr) {
    system("error", `backends.json structure error:\n  - ${norm.errors.join("\n  - ")}`);
    return false;
  }
  configs = norm.arr;
  const v = validateBackends(configs);
  if (!v.ok) {
    system("error", `backends.json validation failed:\n  - ${v.errors.join("\n  - ")}`);
    return false;
  }

  // Build new state in locals first so a partial failure cannot corrupt
  // the live registry.
  const newBackends = configs.map((cfg, idx) => ({ ...cfg, index: idx }));
  const newIndex = {};
  const newList = [];

  for (const backend of newBackends) {
    for (let mi = 0; mi < backend.models.length; mi++) {
      const entry = backend.models[mi];
      const routeId = typeof entry === "string" ? entry : entry.id;
      const upstreamId = typeof entry === "string" ? entry : entry.upstream;
      if (newIndex[routeId]) {
        system("warn", `duplicate model id "${routeId}" in ${backend.provider} — first occurrence in ${newIndex[routeId].backend.provider} wins, skipped`,
          { backend: backend.provider, model: routeId });
        continue;
      }
      newIndex[routeId] = { backend, modelId: upstreamId };
      newList.push({
        id: routeId,
        type: "model",
        display_name: routeId,
        created_at: "2026-01-01T00:00:00Z"
      });
    }
  }

  // Atomic swap.
  backends = newBackends;
  modelIndex = newIndex;
  modelList = newList;
  availableModelsStr = newList.map(m => m.id).join(", ");

  system("info", `loaded ${backends.length} backends, ${modelList.length} models`);
  return true;
}

let watchHandle = null;
let watchDebounce = null;

/**
 * Start watching backends.json for changes. Reloads on modification (with a
 * 250ms debounce). Safe to call multiple times — only one watcher is kept.
 * Returns the underlying fs.FSWatcher (or null when watch fails).
 */
function watchBackends(onReload) {
  if (watchHandle) return watchHandle;
  let lastReloadCb = onReload;

  function doReload() {
    const ok = loadBackends();
    if (typeof lastReloadCb === "function") {
      try { lastReloadCb(ok); } catch {}
    }
  }

  function scheduleReload() {
    if (watchDebounce) clearTimeout(watchDebounce);
    watchDebounce = setTimeout(doReload, 250);
  }

  // Editors that save via atomic rename (vim, IntelliJ, etc.) replace the
  // inode — the original fs.watch handle stops receiving events once the
  // original file is unlinked. On "rename" we tear down the watcher and
  // re-arm it against the new inode. A tiny retry loop covers the window
  // between the rename and the replacement file appearing on disk.
  function arm() {
    try {
      watchHandle = fs.watch(BACKENDS_PATH, { persistent: false }, (eventType) => {
        if (eventType === "rename") {
          scheduleReload();
          try { watchHandle && watchHandle.close(); } catch {}
          watchHandle = null;
          // Re-arm after a short delay so the replacement file exists.
          setTimeout(() => {
            if (watchHandle) return;
            try { arm(); }
            catch (err) {
              // Try once more after another short delay; some editors take
              // a few tens of ms between unlink and create.
              setTimeout(() => { try { arm(); } catch {} }, 250);
              system("warn", `re-arm watch failed once: ${err.message}`);
            }
          }, 50);
          return;
        }
        if (eventType === "change") {
          scheduleReload();
        }
      });
      system("info", `watching ${BACKENDS_PATH} for changes`);
    } catch (err) {
      system("warn", `failed to watch ${BACKENDS_PATH}: ${err.message}`);
      watchHandle = null;
      throw err;
    }
  }

  try { arm(); } catch { /* already logged */ }
  return watchHandle;
}

function stopWatchBackends() {
  if (watchDebounce) { clearTimeout(watchDebounce); watchDebounce = null; }
  if (watchHandle) { try { watchHandle.close(); } catch {} watchHandle = null; }
}

// =============================================================================
// Multi-key weighted round-robin with adaptive feedback.
//
// Each backend (identified by its model name) maintains a per-key state:
//   { key, weight, baseWeight, current, blackoutUntil }
//
//   - weight       : current effective weight in [0, MAX_WEIGHT]. 0 = skipped.
//   - baseWeight   : weight from backends.json — used when refreshing entries.
//   - current      : Smooth-WRR running counter.
//   - blackoutUntil : timestamp; when in the future the key is skipped even
//                     if weight > 0 (used for 429 cooldown).
//
// Feedback rules (recordKeyOutcome):
//   200          -> weight = min(MAX, weight + 1)
//   429          -> weight = max(0, weight - 2), blackout 30s
//   502/503/504  -> weight = max(0, weight - 2), blackout 10s
//   500 / netErr -> weight = max(0, weight - 1)
//   401 / 403    -> weight = 0 (permanent until reload — bad key)
//   other 4xx    -> no change (request problem, not key problem)
//
// If every key has weight=0, we reset all to weight=1 and clear blackouts so
// the backend can recover (avoids wedging the gateway).
// =============================================================================

const MAX_KEY_WEIGHT = 32;

const _keyScheduler = new Map();

function _initState(backendApiKey, backendModel, keysFile) {
  const entries = backendApiKey.map(e => {
    const base = Math.max(1, e.weight || 1);
    return { key: e.key, baseWeight: base, weight: base, current: 0, blackoutUntil: 0 };
  });
  const state = { entries, key: backendModel || "_default", keysFile: keysFile || "" };
  _keyScheduler.set(state.key, state);
  return state;
}

function _refreshState(state, backendApiKey) {
  // Detect changes (key set diff) — if any new keys appear or existing ones
  // disappear we rebuild while preserving runtime weights for keys that stay.
  const incomingKeys = backendApiKey.map(e => e.key);
  const existingKeys = state.entries.map(e => e.key);
  const same = incomingKeys.length === existingKeys.length &&
    incomingKeys.every((k, i) => k === existingKeys[i]);
  if (same) return;
  const oldByKey = new Map(state.entries.map(e => [e.key, e]));
  state.entries = backendApiKey.map(e => {
    const base = Math.max(1, e.weight || 1);
    const prev = oldByKey.get(e.key);
    if (prev) return { ...prev, baseWeight: base };
    return { key: e.key, baseWeight: base, weight: base, current: 0, blackoutUntil: 0 };
  });
}

function _resetAllToBase(state) {
  for (const e of state.entries) {
    e.weight = e.baseWeight;
    e.current = 0;
    e.blackoutUntil = 0;
  }
  delete state.currentKey;
}

function _scheduledKey(backendApiKey, backendModel, keysFile) {
  if (typeof backendApiKey === "string") return backendApiKey;
  if (!Array.isArray(backendApiKey) || backendApiKey.length === 0) return "";
  if (backendApiKey.length === 1) return backendApiKey[0].key;

  const skedKey = backendModel || "_default";
  let state = _keyScheduler.get(skedKey);
  if (!state) state = _initState(backendApiKey, backendModel, keysFile);
  else _refreshState(state, backendApiKey);

  const now = Date.now();

  // Affinity: keep using the current key as long as it is usable (weight > 0
  // and not in blackout). This preserves prefix cache across requests.
  const cur = state.currentKey;
  if (cur) {
    const curEntry = state.entries.find(e => e.key === cur);
    if (curEntry && curEntry.weight > 0 && curEntry.blackoutUntil <= now) {
      // Record this pick for the WRR accounting so the counter doesn't drift.
      const candidates = state.entries.filter(e => e.weight > 0 && e.blackoutUntil <= now);
      if (candidates.length > 0) {
        const total = candidates.reduce((s, e) => s + e.weight, 0);
        for (const e of candidates) e.current += e.weight;
        curEntry.current -= total;
      }
      return cur;
    }
    // Current key became unusable — stickiness broken, fall through to pick
    // a new one.
    delete state.currentKey;
  }

  // Build candidate list: weight > 0 AND not in blackout
  const candidates = state.entries.filter(e => e.weight > 0 && e.blackoutUntil <= now);
  if (candidates.length === 0) {
    _resetAllToBase(state);
    return state.entries[0].key;
  }

  // Pick one via smooth WRR, then pin it as the affinity key.
  let total = 0;
  for (const e of candidates) total += e.weight;
  let best = null;
  for (const e of candidates) {
    e.current += e.weight;
    if (!best || e.current > best.current) best = e;
  }
  best.current -= total;
  state.currentKey = best.key;
  return best.key;
}

/**
 * Feedback after an upstream call so the scheduler can adapt weights.
 * @param {string} backendModel  the backend model id (state key)
 * @param {string} apiKey        the api key that was used
 * @param {number} status        HTTP status (0 / -1 = network error)
 */
function recordKeyOutcome(backendModel, apiKey, status) {
  if (!backendModel || !apiKey) return;
  const state = _keyScheduler.get(backendModel);
  if (!state) return;
  const entry = state.entries.find(e => e.key === apiKey);
  if (!entry) return;

  const now = Date.now();
  if (status === 200) {
    entry.weight = Math.min(MAX_KEY_WEIGHT, entry.weight + 1);
  } else if (status === 429) {
    entry.weight = Math.max(0, entry.weight - 2);
    entry.blackoutUntil = now + 30_000;
    if (state.currentKey === apiKey) delete state.currentKey;
  } else if (status === 502 || status === 503 || status === 504) {
    entry.weight = Math.max(0, entry.weight - 2);
    entry.blackoutUntil = now + 10_000;
    if (state.currentKey === apiKey) delete state.currentKey;
  } else if (status === 401 || status === 403) {
    entry.weight = 0;
    if (state.currentKey === apiKey) delete state.currentKey;
  } else if (status === 500 || status <= 0) {
    entry.weight = Math.max(0, entry.weight - 1);
    if (state.currentKey === apiKey) delete state.currentKey;
  }
  // Persist weights to the apiKeysFile if configured, so they survive restart.
  if (state.keysFile && entry.baseWeight > 0) {
    saveKeysToFile(state.keysFile, state.entries);
  }
  // other 4xx -> no weight change (caller bug, not key bug)
}

/**
 * Snapshot of the current scheduler state for diagnostics / UI.
 */
function getKeySchedulerSnapshot() {
  const out = {};
  for (const [model, state] of _keyScheduler.entries()) {
    out[model] = state.entries.map(e => ({
      key: e.key,
      weight: e.weight,
      baseWeight: e.baseWeight,
      blackoutMs: Math.max(0, e.blackoutUntil - Date.now()),
    }));
  }
  return out;
}

function resolveApiKey(req, backendApiKey, backendModel) {
  // Array-based multi-key -> use weighted round-robin
  if (Array.isArray(backendApiKey)) {
    const keysFile = Array.isArray(backendApiKey) && backendApiKey._keysFile ? backendApiKey._keysFile : "";
    const k = _scheduledKey(backendApiKey, backendModel, keysFile);
    if (req && k) {
      // Stash the choice on the request so doUpstream / the handler can
      // record an outcome later via recordKeyOutcome().
      req._gw_keyChoice = { model: backendModel, key: k };
    }
    return k;
  }
  if (backendApiKey) return backendApiKey;
  const auth = req && req.headers && req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

function hasApiKey(req, backendApiKey) {
  return !!resolveApiKey(req, backendApiKey, null);
}

function abortAllInFlight(reason) {
  for (const ac of inFlightAbortControllers) {
    try { ac.abort(reason); } catch {}
  }
}

function getInFlightAbortControllers() {
  return inFlightAbortControllers;
}

module.exports = {
  backends: () => backends,
  modelIndex: () => modelIndex,
  modelList: () => modelList,
  availableModelsStr: () => availableModelsStr,
  loadBackends,
  validateBackends,
  normalizeConfig,
  watchBackends,
  stopWatchBackends,
  doUpstream,
  upstreamErrStatus,
  resolveApiKey,
  hasApiKey,
  recordKeyOutcome,
  getKeySchedulerSnapshot,
  abortAllInFlight,
  getInFlightAbortControllers,
  resetForTest() {
    backends = [];
    modelIndex = {};
    modelList = [];
    availableModelsStr = "";
    inFlightAbortControllers.clear();
    stopWatchBackends();
  },
};
