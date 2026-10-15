// Validates engine-issues.json against the rules of engine-issues.schema.json (no dependencies) plus checks a schema cannot express.
// Usage: node .github/scripts/engine-issues-check.mjs [file]   (exit 1 on any error)
import fs from "node:fs";
const file = process.argv[2] || "engine-issues.json";
const j = JSON.parse(fs.readFileSync(file, "utf8")), errs = [];
const SEV = ["high", "medium", "low"], ST = ["extended_warranty", "recall", "court_ruling", "class_action_approved", "class_action_pending", "manufacturer_notice", "regulator_notice", "fixed_in_production"];
const SRC = ["court_ruling", "class_action", "manufacturer_notice", "importer_notice", "recall", "regulator"];
const date = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const norm = s => String(s).toUpperCase().replace(/[\s.\-_/]/g, "");
if (j.version !== 1) errs.push("version must be 1");
if (!date(j.updated)) errs.push("updated must be YYYY-MM-DD");
if (!Array.isArray(j.issues)) errs.push("issues must be an array");
const ids = new Set(), keys = new Map();
for (const [i, x] of (j.issues || []).entries()) {
  const at = `issues[${i}]${x && x.id ? " (" + x.id + ")" : ""}`, e = m => errs.push(`${at}: ${m}`);
  if (!/^[a-z0-9][a-z0-9-]{2,60}$/.test(x.id || "")) e("id: lowercase letters, digits and dashes");
  if (ids.has(x.id)) e("duplicate id"); ids.add(x.id);
  const g = x.engine || {};
  if (!g.family) e("engine.family missing");
  if (!Array.isArray(g.codes) || !g.codes.length || g.codes.some(c => norm(c).length < 2)) e("engine.codes: at least one code as written in degem_manoa");
  if (!g.cc || !Number.isInteger(g.cc.min) || !Number.isInteger(g.cc.max) || g.cc.min > g.cc.max || g.cc.max > 9000) e("engine.cc: {min, max} integers, min <= max");
  if (g.years && (g.years.from && g.years.to && g.years.from > g.years.to)) e("engine.years: from > to");
  if (!x.title || x.title.length < 5 || x.title.length > 90) e("title: 5-90 characters");
  if (!x.summary || x.summary.length < 20 || x.summary.length > 500) e("summary: 20-500 characters");
  if (!SEV.includes(x.severity)) e("severity: " + SEV.join("|"));
  if (!ST.includes(x.status)) e("status: " + ST.join("|"));
  if (x.statusUntil && !date(x.statusUntil)) e("statusUntil: YYYY-MM-DD");
  if (!Array.isArray(x.sources) || !x.sources.length) e("sources: at least one official source");
  for (const [k, s] of (x.sources || []).entries()) {
    if (!SRC.includes(s.type)) e(`sources[${k}].type: ${SRC.join("|")}`);
    if (!/^https:\/\/[^\s]+$/.test(s.url || "")) e(`sources[${k}].url must be https`);
    if (s.archive && !/^https:\/\//.test(s.archive)) e(`sources[${k}].archive must be https`);
    // placeholder links are allowed only in the example file
    if (!/example/.test(file) && /\.invalid(\/|$)|example\.(com|org)/.test(s.url || "")) e(`sources[${k}].url is a placeholder`);
    if (!s.title) e(`sources[${k}].title missing`);
    if (!date(s.date)) e(`sources[${k}].date: YYYY-MM-DD`);
  }
  if (!x.reviewed || !date(x.reviewed.date) || !x.reviewed.by) e("reviewed: {date, by}");
  const known = new Set(["id", "engine", "title", "summary", "symptoms", "severity", "status", "statusText", "statusUntil", "advice", "sources", "reviewed"]);
  for (const k of Object.keys(x)) if (!known.has(k)) e("unknown field " + k);
  for (const c of g.codes || []) { const k = norm(c); if (keys.has(k) && keys.get(k) !== x.id) console.log(`note: code ${c} appears in ${keys.get(k)} and ${x.id} (fine if they are different issues)`); keys.set(k, x.id); }
}
if (errs.length) { console.log(errs.join("\n")); console.log(`\n${errs.length} error(s) in ${file}`); process.exit(1); }
console.log(`${file}: ${j.issues.length} issue(s), ${keys.size} engine code(s), OK`);
