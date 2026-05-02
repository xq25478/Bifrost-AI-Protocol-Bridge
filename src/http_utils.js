"use strict";

function json(res, code, obj) {
  res.writeHead(code, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,HEAD,OPTIONS"
  });
  res.end(JSON.stringify(obj));
}

module.exports = { json };