// Fact locators shared by ideas.mjs (which emits facts) and lint.mjs (which re-reads every source and compares).
// A fact: {id?, text, value, source_path, json_pointer | source_field | regex, number_index?, source_rev?, derive?, round?, abs?, scale?,
//          estimate?, private?, fetched_at, data_as_of?, repo_commit?}
//  - text: the claim in Hebrew, written with the value exactly as in `value` (the lint checks that the text contains the value, that a
//    change fact says ירידה/עלייה in the direction of the source, and that the copy around each number fits the text: same unit, same
//    model, same topic, same direction).
//  - source_path: repo-relative path inside the checkout (no "..", no symlink out of it). An absolute path only for "private": true
//    facts (the decrypted Search Console JSON in $WORK), never inside the kit.
//  - json_pointer: RFC 6901, plus array selectors: "/models/[slug=mg3-443]/rcPer", "/byQuery/[keys.0=בדיקת רכב]/clicks", "[0]", "[last]".
//  - source_field: dotted path alternative ("models.0.rcPer").
//  - regex: applied to the resolved string (or to the whole file when no pointer/field); capture group 1 is the value. Group 1 may not
//    contain literal digits, the regex needs at least 3 literal characters of context, and every match in the source must agree.
//  - number_index: take the n-th number (0-based) in the resolved string ("24,162" counts as one number).
//  - source_rev: read the file at a git revision of the checkout (git show <rev>:<path>), e.g. last month's fuel price. Copy that uses
//    such a historical fact must say when (a month, a date, "בחודש שעבר", "אשתקד", "היה"...) and never "עכשיו/היום/החודש".
//  - derive: {op, args:[locator...]} with op pct_change (args old,new) | diff (new-old) | ratio | sum | count_where ({...locator, where:[[field,op,value]...]}).
//  - post-processing: scale (10^k only, |k| <= 3), abs, round (0-4 decimals). Without `round` the value must equal the source exactly.
//    A value more than 0.5% away from the unrounded source is an approximation: the copy must write "כ-" (or ~, בערך) before it.
//    A non-zero source may never be rounded to 0.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const NUM_RE = /(?<![A-Za-z\d_])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?!\d)|(?<![A-Za-z\d_,.])\d+(?:\.\d+)?(?!\d)/gu;
export const parseNum = s => Number(String(s).replace(/,/g, ""));
const foldDigitsLocal = s => String(s).replace(/\p{Nd}/gu, c => { const cp = c.codePointAt(0); if (cp < 128) return c; let st = cp; while (st > 0 && /\p{Nd}/u.test(String.fromCodePoint(st - 1))) st--; const d = String((cp - st) % 10); return c.length === 2 ? d + "​" : d; });
export function numbersIn(str) { return [...foldDigitsLocal(str).matchAll(NUM_RE)].map(m => ({ raw: m[0], value: parseNum(m[0]), index: m.index })); }

// Direction words (normalised: final letters written as regular letters). Used for change facts and for the copy around a number.
export const DIR_UP = "עלי(?:י)?ה|עליית|עלה|עלתה|עלו|עולה|עולים|עולות|גדל|גדלה|גדלו|גידול|זינק\\p{L}*|זינוק|קפצ\\p{L}*|קפיצה|התייקר\\p{L}*|התייקרות|up|rise|rises|rose|risen|increase\\p{L}*|grew|growth|jump\\p{L}*|higher";
export const DIR_DOWN = "ירידה|ירידת|ירד|ירדה|ירדו|יורד|יורדת|יורדים|יורדות|צנח\\p{L}*|צניחה|קטנ|קטנה|קטנו|הוזל\\p{L}*|הוזלה|נפל\\p{L}*|down|drop\\p{L}*|fell|fall|falls|decrease\\p{L}*|decline\\p{L}*|lower";
const FIN = { "ך": "כ", "ם": "מ", "ן": "נ", "ף": "פ", "ץ": "צ" };
export const normFinals = s => String(s).replace(/[ךםןףץ]/g, c => FIN[c]).toLowerCase();
const dirRe = src => new RegExp(`(?<![\\p{L}])[ושהבלמכ]{0,3}(?:${src})(?![\\p{L}])`, "iu");
export function directionOf(text) {
  const t = normFinals(text); const up = dirRe(DIR_UP).test(t), down = dirRe(DIR_DOWN).test(t);
  return up && !down ? "up" : down && !up ? "down" : up && down ? "both" : null;
}

const cache = new Map();
function realInside(base, p) {
  try { const b = fs.realpathSync(base), r = fs.realpathSync(p); return r === b || r.startsWith(b + path.sep); } catch { return false; }
}
function readSource(repo, loc) {
  const p = loc.source_path;
  if (!p) throw new Error("no source_path");
  const key = (loc.source_rev || "") + "|" + (path.isAbsolute(p) ? p : path.join(repo || "", p));
  if (cache.has(key)) return cache.get(key);
  if (!path.isAbsolute(p) && p.split(/[\\/]+/).includes("..")) throw new Error(`source_path may not contain "..": ${p}`);
  let txt;
  if (loc.source_rev) {
    if (path.isAbsolute(p)) throw new Error("source_rev needs a repo-relative source_path");
    if (!repo) throw new Error("no repo checkout given");
    try { txt = execFileSync("git", ["-C", repo, "show", `${loc.source_rev}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 }); }
    catch { throw new Error(`git revision ${loc.source_rev} of ${p} not available in the checkout (shallow clone? run: git -C <repo> fetch --deepen 200)`); }
  } else {
    if (!path.isAbsolute(p) && !repo) throw new Error("no repo checkout given");
    const full = path.isAbsolute(p) ? p : path.join(repo, p);
    if (!fs.existsSync(full)) throw new Error(`source file missing: ${p}`);
    if (!path.isAbsolute(p) && !realInside(repo, full)) throw new Error(`source_path resolves outside the checkout: ${p}`);
    txt = fs.readFileSync(full, "utf8");
  }
  let json = null; if (/\.json$/i.test(p)) { try { json = JSON.parse(txt); } catch { throw new Error(`not valid JSON: ${p}`); } }
  const r = { txt, json }; cache.set(key, r); return r;
}

function getPath(o, dotted) { return String(dotted).split(".").reduce((x, k) => x == null ? undefined : x[k], o); }
export function pointer(obj, ptr) {
  if (ptr === "" || ptr === "/") return obj;
  if (!ptr.startsWith("/")) throw new Error(`json_pointer must start with "/": ${ptr}`);
  let cur = obj;
  for (const raw of ptr.slice(1).split("/")) {
    const seg = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null) throw new Error(`pointer ${ptr}: path ends early at "${seg}"`);
    const sel = seg.match(/^\[(.+)\]$/);
    if (sel && Array.isArray(cur)) {
      const s = sel[1];
      if (s === "last") cur = cur[cur.length - 1];
      else if (/^-?\d+$/.test(s)) cur = cur[Number(s) < 0 ? cur.length + Number(s) : Number(s)];
      else {
        const eq = s.indexOf("="); if (eq < 0) throw new Error(`bad selector [${s}]`);
        const k = s.slice(0, eq), v = s.slice(eq + 1);
        const hits = cur.filter(e => String(getPath(e, k)) === v);
        if (hits.length !== 1) throw new Error(`selector [${s}] matched ${hits.length} items (need exactly 1)`);
        cur = hits[0];
      }
    } else {
      if (!(typeof cur === "object" && seg in cur)) throw new Error(`pointer ${ptr}: no key "${seg}"`);
      cur = cur[seg];
    }
  }
  return cur;
}
const CMP = { ">=": (a, b) => a >= b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, "<": (a, b) => a < b, "==": (a, b) => a == b, "!=": (a, b) => a != b };

// A regex locator must locate, not assert: group 1 may not hold literal digits ("(55)" would "verify" any 55 anywhere), there must be
// some literal context outside the group, and all matches in the source must agree.
export function regexProblem(src) {
  let depth = 0, start = -1, end = -1;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") { i++; continue; }
    if (c === "[") { const j = src.indexOf("]", i + 1); if (j > 0) { i = j; continue; } }
    if (c === "(") { depth++; if (start < 0 && src[i + 1] !== "?") { start = i; const d0 = depth; for (let k = i + 1, dd = d0; k < src.length; k++) { if (src[k] === "\\") { k++; continue; } if (src[k] === "(") dd++; if (src[k] === ")") { dd--; if (dd === d0 - 1) { end = k; break; } } } } }
    if (c === ")") depth--;
  }
  if (start < 0 || end < 0) return "regex needs a capture group around the value";
  const group = src.slice(start + 1, end).replace(/\\[dDsSwWbB.]/g, "").replace(/\[[^\]]*\]/g, "").replace(/\{\d+(?:,\d*)?\}/g, "");
  if (/\d/.test(group)) return `capture group "${src.slice(start, end + 1)}" contains literal digits: it must match the value generically (\\d+)`;
  const outside = (src.slice(0, start) + src.slice(end + 1)).replace(/\\[dDsSwWbB]/g, "").replace(/\\(.)/g, "$1").replace(/[\^$*+?{}()|[\].]/g, "").replace(/\d/g, "");
  if (outside.trim().length < 3) return "regex needs at least 3 literal characters of context outside the capture group";
  return null;
}

export function locate(repo, loc) {
  const src = readSource(repo, loc);
  let v;
  if (loc.json_pointer !== undefined || loc.source_field !== undefined) {
    if (!src.json) throw new Error(`json_pointer/source_field on a non-JSON file: ${loc.source_path}`);
    v = loc.json_pointer !== undefined ? pointer(src.json, loc.json_pointer) : getPath(src.json, loc.source_field);
    if (v === undefined) throw new Error(`field not found: ${loc.json_pointer ?? loc.source_field}`);
  } else v = src.txt;
  if (loc.where) {
    if (!Array.isArray(v)) throw new Error("where needs an array");
    v = v.filter(e => loc.where.every(([f, op, x]) => CMP[op] ? CMP[op](getPath(e, f), x) : (() => { throw new Error("bad op " + op); })()));
  }
  if (loc.regex) {
    const bad = regexProblem(loc.regex); if (bad) throw new Error(bad);
    const all = [...String(v).matchAll(new RegExp(loc.regex, "gu"))].map(m => m[1] ?? m[0]);
    if (!all.length) throw new Error(`regex /${loc.regex}/ not found in ${loc.source_path}`);
    if (new Set(all).size > 1) throw new Error(`regex /${loc.regex}/ matches ${all.length} places with different values (${[...new Set(all)].slice(0, 4).join(", ")}): make it specific`);
    v = all[0];
  }
  if (loc.number_index !== undefined) {
    const ns = numbersIn(v);
    if (loc.number_index >= ns.length) throw new Error(`number_index ${loc.number_index} out of range (${ns.length} numbers)`);
    v = ns[loc.number_index].value;
  }
  return v;
}

function decimals(x) { const s = String(x); const i = s.indexOf("."); return i < 0 ? 0 : s.length - i - 1; }
const roundTo = (x, d) => { const f = 10 ** d; return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f; };
const isNumeric = want => typeof want === "number" || (typeof want === "string" && /^-?[\d,]+(\.\d+)?$/.test(want));

// Returns {ok, computed, raw, signed (before abs), exact (after scale/abs, before rounding), relErr, error}
export function verifyFact(repo, f) {
  try {
    if (f.round !== undefined && !(Number.isInteger(f.round) && f.round >= 0 && f.round <= 4)) throw new Error(`round must be an integer 0-4 (got ${JSON.stringify(f.round)})`);
    if (f.scale !== undefined && !(typeof f.scale === "number" && [1e-3, 1e-2, 0.1, 1, 10, 100, 1000].some(s => Math.abs(s - f.scale) < 1e-12))) throw new Error(`scale must be a power of ten (0.001-1000), got ${JSON.stringify(f.scale)}`);
    let raw;
    if (f.derive) {
      const a = (f.derive.args || []).map(l => locate(repo, { source_rev: l.source_rev, ...l }));
      const n = a.map(x => Array.isArray(x) ? x.length : parseNum(x));
      switch (f.derive.op) {
        case "pct_change": raw = (n[1] - n[0]) / n[0] * 100; break;
        case "diff": raw = n[1] - n[0]; break;
        case "ratio": raw = n[0] / n[1]; break;
        case "sum": raw = n.reduce((s, x) => s + x, 0); break;
        case "count_where": raw = Array.isArray(a[0]) ? a[0].length : NaN; break;
        default: throw new Error("unknown derive op " + f.derive.op);
      }
    } else raw = locate(repo, f);
    const want = f.value;
    if (isNumeric(want)) {
      let x = typeof raw === "number" ? raw : parseNum(raw);
      if (Number.isNaN(x)) return { ok: false, raw, error: `source value is not a number: ${JSON.stringify(raw)}` };
      if (f.scale) x *= f.scale;
      const signed = x;
      if (f.abs) x = Math.abs(x);
      const w = parseNum(want);
      const c = f.round !== undefined ? roundTo(x, f.round) : x;
      const ok = f.round !== undefined ? Math.abs(c - w) < 1e-9 : Math.abs(x - w) <= 1e-9 * Math.max(1, Math.abs(w));
      const relErr = x === 0 ? (w === 0 ? 0 : Infinity) : Math.abs(w - x) / Math.abs(x);
      return { ok, computed: f.round !== undefined ? c : roundTo(x, Math.max(decimals(w), 6)), raw, signed, exact: x, relErr,
        ...(ok ? {} : f.round === undefined && Math.abs(roundTo(x, decimals(w)) - w) < 1e-9 ? { error: `value ${w} is the source ${roundTo(x, 6)} rounded: add an explicit "round" (and write "כ-" in the copy if it changes the number by more than 0.5%)` } : {}) };
    }
    const ok = String(raw).trim() === String(want).trim();
    return { ok, computed: raw, raw };
  } catch (e) { return { ok: false, error: e.message }; }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;
function revDate(repo, rev) { try { return execFileSync("git", ["-C", repo, "log", "-1", "--format=%cI", rev], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }
function argKey(repo, l) {
  if (l.source_rev) return { kind: "rev", v: revDate(repo, l.source_rev) || "" };
  const last = String(l.json_pointer || l.source_field || "").split(/[/.]/).pop();
  if (/^\d{6}$|^\d{4}-\d{2}(?:-\d{2})?$/.test(last)) return { kind: "date", v: last.replace(/-/g, "") };
  return { kind: "now", v: null };
}

// Every rule a single fact must pass besides its value. opts: {repo, kitDir, now (ms), cfg (lint-config facts rule)}.
// Returns {errors: [msg], warnings: [msg], verify}
export function checkFact(f, { repo, kitDir, now = Date.now(), cfg = {} } = {}) {
  const errors = [], warnings = [];
  const C = cfg || {};
  if (f.fetched_at !== undefined) {
    if (!ISO.test(String(f.fetched_at)) || Number.isNaN(Date.parse(f.fetched_at))) errors.push(`fetched_at ${JSON.stringify(f.fetched_at)} is not an ISO date-time (YYYY-MM-DDTHH:MM:SSZ)`);
    else {
      const age = (now - Date.parse(f.fetched_at)) / 864e5;
      if (age < -1 / 24) errors.push(`fetched_at ${f.fetched_at} is in the future`);
      else if (age > (C.max_fact_age_days ?? 10)) errors.push(`fetched_at ${f.fetched_at} is ${Math.round(age)} days old (max ${C.max_fact_age_days ?? 10}): re-run ideas.mjs on a fresh checkout`);
    }
  }
  if (f.data_as_of && !Number.isNaN(Date.parse(f.data_as_of))) {
    const age = (now - Date.parse(f.data_as_of)) / 864e5;
    if (age > (C.max_data_age_days ?? 35)) warnings.push(`"${f.text}": the source data is from ${f.data_as_of} (${Math.round(age)} days old)`);
  }
  if (f.source_path && path.isAbsolute(f.source_path)) {
    if (!f.private) errors.push(`absolute source_path is allowed only for private (Search Console) facts: ${f.source_path}`);
    if (kitDir && realInside(kitDir, f.source_path)) errors.push(`source_path points inside the kit itself: ${f.source_path}`);
  }
  for (const l of [f, ...((f.derive && f.derive.args) || [])]) {
    if (l.source_path && !path.isAbsolute(l.source_path) && String(l.source_path).split(/[\\/]+/).includes("..")) errors.push(`source_path may not contain "..": ${l.source_path}`);
    if (l.regex) { const bad = regexProblem(l.regex); if (bad) errors.push(bad); }
  }
  if (isNumeric(f.value) && f.text !== undefined && !numbersIn(f.text).some(n => Math.abs(n.value - parseNum(f.value)) < 1e-9))
    errors.push(`text "${f.text}" does not contain the value ${f.value}: the text must state exactly the number it backs`);
  // bindings: what kind of claim a source can back (e.g. /petrol95 -> בנזין, /diesel -> סולר)
  for (const b of C.bindings || []) {
    const locs = [f, ...((f.derive && f.derive.args) || [])];
    if (!locs.some(l => l.source_path === b.source_path && new RegExp(b.pointer, "u").test(String(l.json_pointer ?? l.source_field ?? "")))) continue;
    if (b.fact_text && f.text !== undefined && !new RegExp(b.fact_text, "iu").test(normFinals(f.text))) errors.push(`text "${f.text}" does not describe what ${b.source_path} ${b.pointer} holds (${b.about || b.fact_text})`);
  }
  const v = repo !== undefined || (f.source_path && path.isAbsolute(f.source_path)) ? verifyFact(repo, f) : null;
  if (v && v.ok && isNumeric(f.value)) {
    const w = parseNum(f.value);
    if (w === 0 && v.exact !== 0) errors.push(`value 0 but the source is ${v.exact}: a non-zero number may not be rounded to 0`);
    if (v.relErr > (C.max_rounding ?? 0.05)) errors.push(`value ${w} is ${Math.round(v.relErr * 100)}% away from the source ${v.exact}: rounding may change a number by at most ${Math.round((C.max_rounding ?? 0.05) * 100)}%`);
    if (f.derive && ["pct_change", "diff"].includes(f.derive.op)) {
      const d = directionOf(f.text || "");
      const real = v.signed < 0 ? "down" : v.signed > 0 ? "up" : null;
      if (real && d !== real) errors.push(`the source changed ${real === "down" ? "DOWN (ירידה)" : "UP (עלייה)"} (${Math.round(v.signed * 100) / 100}), but the text ${d ? `says ${d === "up" ? "עלייה" : d === "down" ? "ירידה" : "both"}` : "names no direction"}`);
      const [a0, a1] = (f.derive.args || []).map(l => argKey(repo, l));
      if (a0 && a1) {
        if (a1.kind === "rev" && a0.kind !== "rev") errors.push("derive args are in the wrong order: the first (old) argument is current and the second (new) is a git revision");
        else if (a0.kind === a1.kind && a0.v && a1.v && a0.v > a1.v) errors.push(`derive args are in the wrong order: the first (old) argument (${a0.v}) is later than the second (${a1.v})`);
      }
    }
  }
  return { errors, warnings, verify: v };
}

export function repoHead(repo) {
  try {
    const [sha, date] = execFileSync("git", ["-C", repo, "log", "-1", "--format=%H%x09%cI"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\t");
    return { sha, date };
  } catch { return { sha: null, date: null }; }
}
export function isAncestor(repo, a, b) {
  try { execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" }); return true; } catch (e) { return e.status === 1 ? false : null; }
}
