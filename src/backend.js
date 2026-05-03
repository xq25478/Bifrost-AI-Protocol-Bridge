"use strict";

const fs = require("fs");
const { Agent: UndiciAgent, request: undiciRequest } = require("undici");
const { system } = require("./logger");
const { BACKENDS_PATH, TIMEOUT, DISPATCHER_OPTIONS, RETRYABLE_CODES, CIRCUIT_THRESHOLD, CIRCUIT_OPEN_MS } = require("./config");

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

function circuitState(backend) {
  if (!backend.circuitOpenUntil) return "closed";
  if (Date.now() < backend.circuitOpenUntil) return "open";
  return "half_open";
}

function isCircuitOpen(backend) {
  // Pure predicate — "open" only. half_open is treated as available for passive checks.
  return circuitState(backend) === "open";
}

function tryAcquireCircuit(backend) {
  // Side-effectful gate for the request path: returns false when the request
  // should be rejected with 503. In half_open state, allows exactly one probe
  // at a time; others are blocked until the probe settles.
  const state = circuitState(backend);
  if (state === "closed") return true;
  if (state === "open") return false;
  if (backend.halfOpenInflight) return false;
  backend.halfOpenInflight = true;
  system("info", `circuit half-open for backend ${backend.provider} — allowing probe`,
    { backend: backend.provider });
  return true;
}

function onBackendError(backend) {
  const wasProbe = !!backend.halfOpenInflight;
  backend.halfOpenInflight = false;
  backend.consecutiveErrors = (backend.consecutiveErrors || 0) + 1;
  if (wasProbe) {
    backend.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    system("warn", `circuit re-opened for backend ${backend.provider} — probe failed`,
      { backend: backend.provider });
    return;
  }
  if (backend.consecutiveErrors >= CIRCUIT_THRESHOLD && circuitState(backend) !== "open") {
    backend.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    system("warn", `circuit opened for backend ${backend.provider} after ${backend.consecutiveErrors} consecutive errors`,
      { backend: backend.provider });
  }
}

function onBackendSuccess(backend) {
  const wasProbe = !!backend.halfOpenInflight;
  backend.halfOpenInflight = false;
  if (backend.consecutiveErrors || backend.circuitOpenUntil) {
    backend.consecutiveErrors = 0;
    backend.circuitOpenUntil = 0;
    if (wasProbe) {
      system("info", `circuit closed for backend ${backend.provider} — probe succeeded`,
        { backend: backend.provider });
    }
  }
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
  const timeout = setTimeout(() => ac.abort("timeout"), TIMEOUT);
  const finish = () => {
    clearTimeout(timeout);
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
        onBackendError(backend);
        throw err2;
      }
    } else {
      if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("end");
      finish();
      onBackendError(backend);
      throw err;
    }
  }
  if (ctx && typeof ctx.markUpstream === "function") ctx.markUpstream("end");
  return { statusCode: r.statusCode, headers: r.headers, body: r.body, finish, signal: ac.signal };
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
    if (!Array.isArray(b.models) || b.models.length === 0) {
      errors.push(`${tag}: models must be a non-empty array`);
    } else {
      for (const m of b.models) {
        if (typeof m !== "string" || !m.trim()) {
          errors.push(`${tag}: model entries must be non-empty strings, got ${JSON.stringify(m)}`);
        } else if (seenModels.has(m)) {
          // not a hard error — loadBackends will warn and skip duplicates
        } else {
          seenModels.add(m);
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
      const modelId = backend.models[mi];
      if (newIndex[modelId]) {
        system("warn", `duplicate model id "${modelId}" in ${backend.provider} — first occurrence in ${newIndex[modelId].backend.provider} wins, skipped`,
          { backend: backend.provider, model: modelId });
        continue;
      }
      newIndex[modelId] = { backend, modelId };
      newList.push({
        id: modelId,
        type: "model",
        display_name: modelId,
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
  try {
    watchHandle = fs.watch(BACKENDS_PATH, { persistent: false }, (eventType) => {
      if (eventType !== "change" && eventType !== "rename") return;
      if (watchDebounce) clearTimeout(watchDebounce);
      watchDebounce = setTimeout(() => {
        const ok = loadBackends();
        if (typeof onReload === "function") {
          try { onReload(ok); } catch {}
        }
      }, 250);
    });
    system("info", `watching ${BACKENDS_PATH} for changes`);
  } catch (err) {
    system("warn", `failed to watch ${BACKENDS_PATH}: ${err.message}`);
    watchHandle = null;
  }
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
  watchBackends,
  stopWatchBackends,
  doUpstream,
  upstreamErrStatus,
  isCircuitOpen,
  tryAcquireCircuit,
  circuitState,
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