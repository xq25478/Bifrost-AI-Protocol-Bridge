"use strict";

const LOG_LEVEL = (process.env.LOG_LEVEL || "info").toLowerCase();
const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LOG_THRESHOLD = LOG_LEVELS[LOG_LEVEL] ?? 20;
const LOG_COLORS = { debug: "\x1b[90m", info: "\x1b[0m", warn: "\x1b[33m", error: "\x1b[31m" };
const LOG_RESET = "\x1b[0m";
const COLOR_DIM = "\x1b[90m";
const COLOR_GREEN = "\x1b[32m";
const COLOR_CYAN = "\x1b[36m";

const BODY_SAMPLE_MAX = 1024;
const REDACT_PATTERNS = [
  // common api key shapes
  /"(api[_-]?key|authorization|x-api-key)"\s*:\s*"[^"]*"/gi,
  /(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g,
  /(pk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]+/g,
  /(Bearer\s+)[A-Za-z0-9._-]+/gi,
];

const EVENT_LABEL = {
  recv: "recv",
  route: "route",
  upstream: "upstream",
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

/**
 * Redact API keys / authorization headers from a request body sample.
 * Returns a string limited to BODY_SAMPLE_MAX characters.
 */
function redactBodySample(buf) {
  if (buf == null) return "";
  let s;
  if (Buffer.isBuffer(buf)) s = buf.subarray(0, BODY_SAMPLE_MAX * 2).toString("utf8");
  else s = String(buf);
  for (const re of REDACT_PATTERNS) {
    s = s.replace(re, (m, prefix) => {
      if (re.source.includes("api[_-]?key")) return m.replace(/"[^"]*"$/, '"[redacted]"');
      if (prefix && (prefix.startsWith("sk-") || prefix.startsWith("pk-"))) return prefix + "[redacted]";
      if (prefix && /Bearer/i.test(prefix)) return prefix + "[redacted]";
      return "[redacted]";
    });
  }
  if (s.length > BODY_SAMPLE_MAX) s = s.slice(0, BODY_SAMPLE_MAX) + "...(truncated)";
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
    if (entry.upstream_ms !== undefined) {
      fragments.push(`${COLOR_DIM}upstream=${entry.upstream_ms}ms${LOG_RESET}`);
    }

    if (entry.backend) fragments.push(`backend=${entry.backend}`);
    if (entry.model) fragments.push(`model=${entry.model}`);
    if (entry.url) fragments.push(`${COLOR_DIM}url=${entry.url}${LOG_RESET}`);

    if (entry.err) fragments.push(`${color}err=${entry.err}${LOG_RESET}`);

    if (entry.msg) fragments.push(`${color}${entry.msg}${LOG_RESET}`);

    if (entry.body_sample) {
      fragments.push(`${COLOR_DIM}body=${entry.body_sample}${LOG_RESET}`);
    }

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
 *
 * The logger tracks:
 *   - upstream_start_ms / upstream_end_ms : upstream call timing (for breakdown)
 *   - bodySample : optional redacted slice of the request body, surfaced on error logs
 */
function requestlog(rid, method, path) {
  if (!rid) {
    const noop = {
      on() {}, end() {}, err() {}, mute() {}, attachUsage() {}, attachBody() {}, markUpstream() {}, flushOnClose() {},
      _start: 0, _usage: null, _extra: null,
    };
    return noop;
  }
  const start = Date.now();
  const base = { ts: new Date().toISOString(), rid, method, path, event: "recv" };
  let muted = false;
  let _usage = null;
  let _usageExtra = null;
  let _bodySample = null;
  let _upstreamStartMs = 0;
  let _upstreamMs = 0;
  let _flushed = false;

  const { recordRequestUsage } = require("./usage_recorder");

  function flushUsage(partial) {
    if (_flushed) return;
    if (!_usage) return;
    _flushed = true;
    recordRequestUsage({
      rid,
      ts: start,
      usage: _usage,
      ..._usageExtra,
      partial: !!partial,
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
      const out = { ...base, event, elapsed: Date.now() - start, ...extra };
      if (_upstreamMs && out.upstream_ms === undefined) out.upstream_ms = _upstreamMs;
      writelog(out);
    },
    attachUsage(usage, extra = {}) {
      _usage = usage;
      _usageExtra = extra;
    },
    attachBody(buf) {
      _bodySample = redactBodySample(buf);
    },
    markUpstream(phase) {
      if (phase === "start") _upstreamStartMs = Date.now();
      else if (phase === "end" && _upstreamStartMs) {
        _upstreamMs = Date.now() - _upstreamStartMs;
      }
    },
    end(status, extra = {}) {
      if (muted) return;
      flushUsage();
      const elapsed = Date.now() - start;
      const out = { status, elapsed, ...extra };
      if (_upstreamMs) out.upstream_ms = _upstreamMs;
      self.on("done", out);
    },
    err(status, err, extra = {}) {
      if (muted) return;
      flushUsage();
      const out = {
        ...base, event: "error", level: "error", status,
        elapsed: Date.now() - start, err: err.message, ...extra
      };
      if (_upstreamMs) out.upstream_ms = _upstreamMs;
      if (_bodySample) out.body_sample = _bodySample;
      writelog(out);
    },
    /**
     * Best-effort flush attempt for early-disconnect / aborted streams.
     * Records whatever usage was attached so far, marked partial=true.
     */
    flushOnClose() {
      if (_flushed) return;
      flushUsage(true);
    },
    mute() { muted = true; }
  };
  if (!method || !path) return self;
  writelog(base);
  return self;
}

module.exports = { system, requestlog, redactBodySample, LOG_LEVELS, LOG_THRESHOLD };
