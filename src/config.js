"use strict";

const path = require("path");

const PORT = 29501;
const TIMEOUT = 300_000;
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

const DEFAULT_THINKING_EFFORT = "max";
const SUPPORTED_THINKING_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_OPEN_MS = 10_000;

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
  DEFAULT_THINKING_EFFORT,
  SUPPORTED_THINKING_EFFORTS,
  CIRCUIT_THRESHOLD,
  CIRCUIT_OPEN_MS,
  SHUTDOWN_DRAIN_MS,
  DISPATCHER_OPTIONS,
  RETRYABLE_CODES,
  ALLOWED_ORIGINS,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
};