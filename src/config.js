"use strict";

const path = require("path");

const PORT = 29501;
// Wall-clock-ish ceiling for an upstream call. NOTE: this is enforced as an
// IDLE (inactivity) timeout in `doUpstream` — every byte of upstream
// response resets the watchdog, so a long-running stream that takes 30+
// minutes overall is fine as long as it keeps producing output. Only true
// stalls (no upstream activity for `TIMEOUT` ms) trigger an abort.
const TIMEOUT = 600_000;
const MAX_BODY_SIZE = 32 * 1024 * 1024;
const LOCAL_KEEP_ALIVE_TIMEOUT = 65_000;
const LOCAL_HEADERS_TIMEOUT = 66_000;
const BACKENDS_PATH = path.join(__dirname, "..", "backends.json");

const EXTRA_ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set([
  `http://127.0.0.1:${PORT}`,
  `http://localhost:${PORT}`,
  ...EXTRA_ALLOWED_ORIGINS,
]);
const ALLOWED_METHODS = "GET,POST,HEAD,OPTIONS";
const ALLOWED_HEADERS = "authorization,content-type,x-api-key,anthropic-version,anthropic-beta";

const HOP_BY_HOP = new Set([
  "transfer-encoding", "connection", "keep-alive",
  "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "upgrade"
]);

// Default `max_tokens` we send upstream when the client didn't supply one.
// Many CLIs (e.g. Codex via the Anthropic adapter) omit `max_tokens` even
// though Anthropic requires it; the previous hard-coded 4096 was small enough
// that long answers got truncated with finish_reason=length / stop_reason=
// max_tokens. Override via env (PROXY_MAX_TOKENS_DEFAULT) when needed.
const DEFAULT_MAX_TOKENS = (() => {
  const raw = parseInt(process.env.PROXY_MAX_TOKENS_DEFAULT || "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 32768;
})();

const DEFAULT_THINKING_EFFORT = "max";
const SUPPORTED_THINKING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

// Optional gateway-side bearer token. When set (non-empty), every non-health
// request MUST present a matching `Authorization: Bearer <token>` (or
// `x-api-key: <token>`) regardless of whether the backend has its own apiKey
// configured. When UNSET (the default), the gateway is open — backwards
// compatible with the original single-user desktop-bridge deployment, but
// explicitly NOT safe to expose to untrusted clients.
const GATEWAY_API_KEY = (process.env.GATEWAY_API_KEY || "").trim();

const SHUTDOWN_DRAIN_MS = 30_000;

const DISPATCHER_OPTIONS = {
  connections: 256,
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connect: { timeout: 10_000 },
  bodyTimeout: TIMEOUT,
  headersTimeout: TIMEOUT,
};

const RETRYABLE_CODES = new Set([
  "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET",
  "ECONNREFUSED", "EAI_AGAIN"
]);

module.exports = {
  PORT,
  TIMEOUT,
  MAX_BODY_SIZE,
  LOCAL_KEEP_ALIVE_TIMEOUT,
  LOCAL_HEADERS_TIMEOUT,
  BACKENDS_PATH,
  HOP_BY_HOP,
  DEFAULT_MAX_TOKENS,
  DEFAULT_THINKING_EFFORT,
  SUPPORTED_THINKING_EFFORTS,
  SHUTDOWN_DRAIN_MS,
  DISPATCHER_OPTIONS,
  RETRYABLE_CODES,
  ALLOWED_ORIGINS,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
  GATEWAY_API_KEY,
};
