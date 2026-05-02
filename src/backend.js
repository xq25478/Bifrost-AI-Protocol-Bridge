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

function isCircuitOpen(backend) {
  return !!(backend.circuitOpenUntil && Date.now() < backend.circuitOpenUntil);
}

function onBackendError(backend) {
  backend.consecutiveErrors = (backend.consecutiveErrors || 0) + 1;
  if (backend.consecutiveErrors >= CIRCUIT_THRESHOLD && !isCircuitOpen(backend)) {
    backend.circuitOpenUntil = Date.now() + CIRCUIT_OPEN_MS;
    system("warn", `circuit opened for backend ${backend.provider} after ${backend.consecutiveErrors} consecutive errors`,
      { backend: backend.provider });
  }
}

function onBackendSuccess(backend) {
  if (backend.consecutiveErrors || backend.circuitOpenUntil) {
    backend.consecutiveErrors = 0;
    backend.circuitOpenUntil = 0;
  }
}

function isTransientConnectError(err) {
  return !!(err && RETRYABLE_CODES.has(err.code));
}

/**
 * Call an upstream URL with automatic retry on transient connection errors.
 * Returns { statusCode, headers, body, finish, signal }.
 */
async function doUpstream(url, options, backend) {
  const ac = new AbortController();
  inFlightAbortControllers.add(ac);
  const timeout = setTimeout(() => ac.abort("timeout"), TIMEOUT);
  const finish = () => {
    clearTimeout(timeout);
    inFlightAbortControllers.delete(ac);
  };
  const call = () => undiciRequest(url, { ...options, signal: ac.signal, dispatcher });

  let r;
  try {
    r = await call();
  } catch (err) {
    if (isTransientConnectError(err) && !ac.signal.aborted) {
      try {
        r = await call();
      } catch (err2) {
        finish();
        onBackendError(backend);
        throw err2;
      }
    } else {
      finish();
      onBackendError(backend);
      throw err;
    }
  }
  return { statusCode: r.statusCode, headers: r.headers, body: r.body, finish, signal: ac.signal };
}

function loadBackends() {
  try {
    const raw = fs.readFileSync(BACKENDS_PATH, "utf8");
    const configs = JSON.parse(raw);

    backends = configs.map((cfg, idx) => ({ ...cfg, index: idx }));

    modelIndex = {};
    modelList = [];

    for (const backend of backends) {
      for (let mi = 0; mi < backend.models.length; mi++) {
        const modelId = backend.models[mi];
        if (modelIndex[modelId]) {
          system("warn", `duplicate model id "${modelId}" in ${backend.provider} — first occurrence in ${modelIndex[modelId].backend.provider} wins, skipped`,
            { backend: backend.provider, model: modelId });
          continue;
        }
        modelIndex[modelId] = { backend, modelId };
        modelList.push({
          id: modelId,
          type: "model",
          display_name: modelId,
          created_at: "2026-01-01T00:00:00Z"
        });
      }
    }

    system("info", `loaded ${backends.length} backends, ${modelList.length} models`);
    availableModelsStr = modelList.map(m => m.id).join(", ");
    return true;
  } catch (err) {
    system("error", `failed to load backends: ${err.message}`);
    return false;
  }
}

function resolveApiKey(req, backendApiKey) {
  if (backendApiKey) return backendApiKey;
  const auth = req.headers.authorization || req.headers.Authorization;
  if (auth && auth.toLowerCase().startsWith("bearer ")) {
    return auth.slice("bearer ".length).trim();
  }
  return "";
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
  doUpstream,
  upstreamErrStatus,
  isCircuitOpen,
  onBackendError,
  onBackendSuccess,
  resolveApiKey,
  abortAllInFlight,
  getInFlightAbortControllers,
  resetForTest() {
    backends = [];
    modelIndex = {};
    modelList = [];
    availableModelsStr = "";
    inFlightAbortControllers.clear();
  },
};