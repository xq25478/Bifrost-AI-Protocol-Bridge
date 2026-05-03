"use strict";

/**
 * Build the multi-line startup banner printed when the server begins listening.
 *
 * Returned as an array of plain strings so the caller can emit each line with
 * its own `system("info", line)` call, and so the content is unit-testable
 * without touching the live logger.
 *
 *   buildStartupBanner({ host: "127.0.0.1", port: 4000, backendCount, modelCount }) -> string[]
 */
function buildStartupBanner({ host = "127.0.0.1", port, backendCount = 0, modelCount = 0 } = {}) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`buildStartupBanner: invalid port ${port}`);
  }
  const baseUrl = `http://${host}:${port}`;

  return [
    `OpenProxyRouter listening on ${baseUrl}`,
    `dashboard: ${baseUrl}/dashboard`,
    `loaded ${backendCount} backend(s), ${modelCount} model(s)`,
    "client configuration — point your SDK/CLI base-URL at the value shown:",
    `  Anthropic Messages (Claude Code, Anthropic SDK):    ${baseUrl}/anthropic`,
    `  OpenAI Chat Completions (OpenAI SDK, LangChain):    ${baseUrl}/anthropic/v1`,
    `  OpenAI Responses (OpenAI SDK >= 1.47):              ${baseUrl}/anthropic/v1`,
  ];
}

module.exports = { buildStartupBanner };
