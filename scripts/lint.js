#!/usr/bin/env node
"use strict";

// Lightweight lint: syntax check + module load + dashboard html sanity.
// Catches the historical class of bugs we hit in v1 (template literal
// poisoning, missing exports, broken require chain) without pulling in a
// full eslint dependency.

const cp = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC_DIR = path.join(ROOT, "src");

function fail(msg) {
  console.error("[lint] " + msg);
  process.exit(1);
}

function syntaxCheck(file) {
  const r = cp.spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
  if (r.status !== 0) fail("syntax error in " + file + ":\n" + r.stderr);
}

function requireAll(files) {
  for (const f of files) {
    try { require(f); }
    catch (e) { fail("require failed for " + f + ": " + e.message); }
  }
}

const indexFile = path.join(ROOT, "index.js");
syntaxCheck(indexFile);

const srcFiles = fs.readdirSync(SRC_DIR)
  .filter(f => f.endsWith(".js") && !f.endsWith(".test.js"))
  .map(f => path.join(SRC_DIR, f));

for (const f of srcFiles) syntaxCheck(f);
requireAll(srcFiles);

// Dashboard HTML must be self-contained, free of template-literal traps,
// produce parseable inline JS, and end at </html>.
{
  const { dashboardHtml } = require(path.join(SRC_DIR, "dashboard_html.js"));
  const html = dashboardHtml();
  if (typeof html !== "string" || html.length < 1000) fail("dashboardHtml() returned tiny output");
  if (!html.trim().endsWith("</html>")) fail("dashboardHtml() does not end with </html>");
  if (/\$\{[^}]+\}/.test(html)) fail("dashboardHtml() contains unresolved ${...} - template literal leak");
  if (html.includes("cdn.jsdelivr.net")) fail("dashboardHtml() must not depend on a CDN");
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) fail("dashboardHtml() has no inline <script>");
  try { new Function(m[1]); }
  catch (e) { fail("dashboard inline script failed to parse: " + e.message); }
}

console.log("[lint] ok (" + (1 + srcFiles.length) + " files checked)");
