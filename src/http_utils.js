"use strict";

const { ALLOWED_ORIGINS, ALLOWED_METHODS, ALLOWED_HEADERS } = require("./config");

function corsHeaders(req) {
  const origin = req && req.headers && (req.headers.origin || req.headers.Origin);
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-allow-methods": ALLOWED_METHODS,
    "vary": "Origin",
  };
}

function json(res, code, obj, req) {
  res.writeHead(code, {
    "content-type": "application/json",
    ...corsHeaders(req),
  });
  res.end(JSON.stringify(obj));
}

module.exports = { json, corsHeaders };
