"use strict";

const fs = require("fs");
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
 * Record a backend error for the dashboard / metrics counters. Called from
 * every error path after an upstream attempt has already completed or thrown.
 * Pure bookkeeping — does not implement any circuit-breaking logic.
 */
function onBackendError(backend) {
  backend.consecutiveErrors = (backend.consecutiveErrors || 0) + 1;
}

/**
 * Mark a backend attempt as successful so the dashboard reflects health.
 * Resets the consecutive-error counter on the backend object.
 */
function onBackendSuccess(backend) {
  if (backend.consecutiveErrors) backend.consecutiveErrors = 0;
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
    const { protocol, url, apiKey, model, thinking_format, provider } = b;
    if (typeof model !== "string" || !model.trim()) {
      errors.push(`backend missing .model (upstream model name): ${JSON.stringify(b)}`);
      continue;
    }
    if (byModel.has(model)) {
      errors.push(`duplicate backend model: "${model}"`);
      continue;
    }
    byModel.set(model, {
      provider: provider || model,
      type: protocol,
      baseUrl: url,
      apiKey,
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
  return { arr: Array.from(byModel.values()), errors: [] };
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
    if (b.apiKey !== undefined && typeof b.apiKey !== "string") {
      errors.push(`${tag}: apiKey must be a string when present`);
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

function resolveApiKey(req, backendApiKey) {
  if (backendApiKey) return backendApiKey;
  // Node's HTTP parser lowercases header names — `req.headers.Authorization`
  // is always undefined, so we only look up the lowercase form.
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
}

function hasApiKey(req, backendApiKey) {
  return !!resolveApiKey(req, backendApiKey);
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
  onBackendError,
  onBackendSuccess,
  resolveApiKey,
  hasApiKey,
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
