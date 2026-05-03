"use strict";

/**
 * Stateful SSE line splitter. `feed(chunk, onLine)` buffers any partial line
 * tail and emits complete lines (Buffer, stripped of the trailing CR/LF) to
 * the callback. `flush(onLine)` emits a final line if the stream ended
 * without a terminating newline.
 */
function createSSEParser() {
  let buf = null;
  return {
    feed(chunk, onLine) {
      buf = buf ? Buffer.concat([buf, chunk], buf.length + chunk.length) : chunk;
      let nl;
      while ((nl = buf.indexOf(0x0A)) !== -1) {
        const end = nl > 0 && buf[nl - 1] === 0x0D ? nl - 1 : nl;
        onLine(buf.subarray(0, end));
        buf = buf.subarray(nl + 1);
      }
    },
    flush(onLine) {
      if (!buf || buf.length === 0) return;
      const end = buf[buf.length - 1] === 0x0D ? buf.length - 1 : buf.length;
      if (end > 0) onLine(buf.subarray(0, end));
      buf = null;
    },
  };
}

function isSSEDataLine(line) {
  return line.length >= 6 &&
    line[0] === 0x64 && line[1] === 0x61 && line[2] === 0x74 &&
    line[3] === 0x61 && line[4] === 0x3A && line[5] === 0x20;
}

function sseDataPayload(line) {
  return line.subarray(6).toString("utf8").trim();
}

module.exports = { createSSEParser, isSSEDataLine, sseDataPayload };
