"use strict";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 20;
const LOG_COLORS = { debug: "\x1b[90m", info: "\x1b[0m", warn: "\x1b[33m", error: "\x1b[31m" };
const LOG_RESET = "\x1b[0m";
const COLOR_DIM = "\x1b[90m";
const COLOR_GREEN = "\x1b[32m";
const COLOR_CYAN = "\x1b[36m";

const EVENT_LABEL = {
  recv: "recv",
  route: "route",
  done: "done",
  error: "error",
  count_tokens: "count_tokens",
  system: "system",
};

function colorStatus(status) {
  const s = String(status);
  if (s.startsWith("2")) return COLOR_GREEN + s + LOG_RESET;
  if (s.startsWith("4") || s.startsWith("5")) return "\x1b[31m" + s + LOG_RESET;
  return s;
}

function writelog(entry) {
  const levelNum = LOG_LEVELS[entry.level];
  if (levelNum < LOG_THRESHOLD && entry.rid !== "system") return;
  if (process.stdout.isTTY) {
    const color = LOG_COLORS[entry.level] || "";
    const ts = entry.ts.slice(11, 19);
    const eventLabel = EVENT_LABEL[entry.event] || entry.event;

    const fragments = [`${COLOR_DIM}[${ts}]${LOG_RESET}`];

    if (entry.event) {
      fragments.push(`${COLOR_CYAN}${eventLabel}${LOG_RESET}`);
    }

    if (entry.rid && entry.rid !== "system") {
      fragments.push(`${COLOR_DIM}${entry.rid}${LOG_RESET}`);
    }

    if (entry.method) fragments.push(entry.method);
    if (entry.path) fragments.push(entry.path);

    if (entry.status !== undefined) {
      fragments.push(`status=${colorStatus(entry.status)}`);
    }

    if (entry.elapsed !== undefined) {
      fragments.push(`${COLOR_DIM}elapsed=${entry.elapsed}ms${LOG_RESET}`);
    }

    if (entry.backend) fragments.push(`backend=${entry.backend}`);
    if (entry.model) fragments.push(`model=${entry.model}`);

    if (entry.err) fragments.push(`${color}err=${entry.err}${LOG_RESET}`);

    if (entry.msg) fragments.push(`${color}${entry.msg}${LOG_RESET}`);

    const out = fragments.join(" ");
    if (entry.level === "error" || entry.level === "warn") {
      console.error(out);
    } else {
      console.log(out);
    }
  } else {
    console.log(JSON.stringify(entry));
  }
}

function system(level, msg, extra = {}) {
  writelog({ ts: new Date().toISOString(), level, rid: "system", event: "system", ...extra, msg });
}

/**
 * Create a request-scoped logger. When called with empty method/path (health check),
 * returns a muted logger that still exposes the same interface.
 */
function requestlog(rid, method, path) {
  if (!rid) {
    const noop = { on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, _start: 0, _usage: null, _extra: null };
    return noop;
  }
  const start = Date.now();
  const base = { ts: new Date().toISOString(), rid, method, path, event: "recv" };
  let muted = false;
  let _usage = null;
  let _usageExtra = null;

  const { recordRequestUsage } = require("./usage_recorder");

  function flushUsage() {
    if (!_usage) return;
    recordRequestUsage({
      rid,
      ts: start,
      usage: _usage,
      ..._usageExtra,
    });
    _usage = null;
    _usageExtra = null;
  }

  const self = {
    _start: start,
    _usage: null,
    _extra: null,
    on(event, extra = {}) {
      if (muted) return;
      writelog({ ...base, event, elapsed: Date.now() - start, ...extra });
    },
    attachUsage(usage, extra = {}) {
      _usage = usage;
      _usageExtra = extra;
    },
    end(status, extra = {}) {
      if (muted) return;
      flushUsage();
      const elapsed = Date.now() - start;
      self.on("done", { status, elapsed, ...extra });
    },
    err(status, err, extra = {}) {
      if (muted) return;
      flushUsage();
      writelog({
        ...base, event: "error", level: "error", status,
        elapsed: Date.now() - start, err: err.message, ...extra
      });
    },
    mute() { muted = true; }
  };
  if (!method || !path) return self;
  writelog(base);
  return self;
}

module.exports = { system, requestlog, LOG_LEVELS, LOG_THRESHOLD };