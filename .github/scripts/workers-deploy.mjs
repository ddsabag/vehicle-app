// Workers deploy (Ship Tail part 1): deploys the Cloudflare Workers listed in .github/ship-tail.json from main with wrangler, guarded so
// a deploy never loses a dashboard value (vars, bindings, routes, crons, workers.dev), never overwrites code that is not on main, never
// undoes a version someone chose by hand in the dashboard, and never puts older files over newer ones.
// Every existing Worker was deployed by hand from the dashboard, so the dashboard is the truth: anything live that the toml does not
// declare refuses that Worker (the others continue) with the reason and what to change.
// Two jobs, so wrangler (fetched from npm) never runs next to a secret it does not need:
//   deploy job (this script, env: the Cloudflare pair only), per selected Worker in config order with a KV creator first:
//     a. node --check, no static imports (no_bundle uploads the file byte for byte), wrangler deploy --dry-run on a temp copy of the toml
//     b. live state from the Cloudflare API: script, settings, routes, custom domains, crons, workers.dev, active deployment, versions,
//        secret names, the live code; a Worker for which main already has newer files is skipped quietly (a re-run of an older run)
//     c. guards (see guards()); a version chosen by hand (a dashboard rollback) is replaced only by a manual run that names the Worker;
//        live code from a commit this run does not contain is never replaced; the KV placeholder is resolved by title and created only
//        for a create:true Worker in mode on
//     d. the configured check must already pass on the live version (manual input skip_precheck=<key> overrides)
//     e. wrangler deploy from the temp toml (no_bundle and keep_vars forced on), message = the commit sha
//     f. the new version is the active deployment at 100%; after a settle wait the check passes twice in a row (with "version": true
//        the answer must name the new version); then the deployment is marked "ship-tail verified <sha>"
//     g. a failed check rolls back to the previous version and checks again
//   after job (--after, a fresh runner that runs no npm code; env: Cloudflare, Telegram, GitHub, Brevo): puts the secretsFromGitHub a
//     deployed Worker lacks (Cloudflare API, then verify and check again, rollback on failure) and sends the alerts: a refusal one day
//     alert (one for all when Cloudflare could not be read for several), a failed check one loud alert, a force_code replace one day
//     alert. Success is quiet (job summary only) and closes that Worker's open alert items.
// Modes: repo variable SHIP_TAIL off = nothing, dry = a-d plus the plan in the job summary (no writes, no alerts), unset or on = act.
// A manual run acts only with the input mode=on, only on main, and only when origin/main is known. Without CLOUDFLARE_API_TOKEN or
// CF_ACCOUNT_ID: one notice line, exit 0.
// Result: job summary, step outputs "result" (JSON), "outcome" and "mode", and the file RESULT_FILE (artifact workers-deploy-<sha>).
// Exit 1 only on a crash, a bad CF_ACCOUNT_ID or CLOUDFLARE_API_TOKEN, or (after job) an alert that could not be delivered, so failure-alert
// speaks instead.
//   node .github/scripts/workers-deploy.mjs              deploy job   env: see .github/workflows/workers-deploy.yml
//   node .github/scripts/workers-deploy.mjs --after      after job    env RESULT = the deploy job's "result" output
//   node .github/scripts/workers-deploy.mjs --selftest   offline: fixture repo, mocked Cloudflare API, wrangler runner, site and alerts
// Node 20+ and no imports except node: builtins; the workflow runs Node 22 because wrangler 4 needs it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export const WRANGLER = "wrangler@4.147.0";   // exact pin, published 2026-10-02 (over two weeks old when chosen); run through npx
const CF_API = "https://api.cloudflare.com/client/v4";
const SELF = url.fileURLToPath(import.meta.url);
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const CF_PAIR = ["CLOUDFLARE_API_TOKEN", "CF_ACCOUNT_ID"];
const BASE_SECRETS = [...CF_PAIR, "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "GITHUB_TOKEN", "BREVO_API_KEY", "REVIEWS_SA_JSON"];
const NEVER_COPY = new Set(["CLOUDFLARE_API_TOKEN", "CF_ACCOUNT_ID", "GITHUB_TOKEN"]);   // never handed to a Worker as a secret
const VAR_TYPES = new Set(["plain_text", "json"]), SECRET_TYPES = new Set(["secret_text", "secret_key"]);
const NOT_FOUND = [10007, 10090];   // Cloudflare "worker not found"
const ROLLBACK_SECRETS_CHANGED = 10220;   // a rollback target predates a secret change; wrangler retries with force, so do we
const VERSION_HEADER = "x-luchit-version";   // set by og, api and uptime from their CF_VERSION_METADATA binding
// probe: tries and the gap between them, passes in a row needed after a deploy, settle = wait after the API says "active" (edge rollout)
export const T = { probeTries: 8, probeGap: 10000, probePasses: 2, settle: 25000, depTries: 4, depGap: 5000, fetchMs: 30000 };

// injectable I/O: the selftest swaps these
export const IO = {
  env: process.env, root: path.resolve(path.dirname(SELF), "../.."), fetch: (u, o) => fetch(u, o),
  run: (args, o) => {   // the wrangler runner: npx with the exact pin; input goes through stdin only
    const r = spawnSync("npx", ["--yes", WRANGLER, ...args], { cwd: o.cwd, input: o.input || "", env: o.env, encoding: "utf8", timeout: 10 * 60e3, maxBuffer: 64e6 });
    return { code: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") + (r.error ? "\n" + r.error.message : "") };
  },
  sleep: t => new Promise(r => setTimeout(r, t)), out: s => process.stdout.write(s + "\n"), router: undefined,   // undefined = import ./alert.mjs
};

// ---- secrets never leave the process: every printed or written text goes through scrub() ----
let SECRET_NAMES = new Set(BASE_SECRETS);
function secretValues() {
  const v = [];
  for (const k of SECRET_NAMES) {
    const s = String(IO.env[k] || "");
    if (s.length >= 4) v.push(s);
    for (const l of s.split(/\r?\n/)) if (l.trim().length >= 8) v.push(l.trim());   // a multi-line secret (a JSON key) line by line
  }
  return [...new Set(v)].sort((a, b) => b.length - a.length);
}
export const scrub = t => { let s = String(t); for (const v of secretValues()) s = s.split(v).join("***"); return s; };
const say = t => IO.out(scrub(t));

// ---- small helpers ----
const norm = s => String(s).replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");   // CRLF and trailing newlines do not count
const hash = s => createHash("sha256").update(norm(s)).digest("hex");
const short = u => { try { const x = new URL(u); return x.host + x.pathname; } catch { return String(u).slice(0, 80); } };
const md = s => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const isSha = s => /^[0-9a-f]{40}$/.test(String(s || "")) && !/^0+$/.test(s);
function git(args) {
  const r = spawnSync("git", ["-C", IO.root, ...args], { encoding: "utf8", maxBuffer: 64e6 });
  return { code: r.status ?? 1, out: r.stdout || "" };
}
const hasCommit = s => isSha(s) && git(["cat-file", "-e", s + "^{commit}"]).code === 0;
const isAncestor = (a, b) => git(["merge-base", "--is-ancestor", a, b]).code === 0;
// a Worker's entry in .github/ship-tail.json at a commit, as JSON text (compared with w.raw), or null
function entryAt(rev, key) {
  try { return JSON.stringify(JSON.parse(git(["show", `${rev}:.github/ship-tail.json`]).out).workers.find(x => x.key === key) || null); } catch { return null; }
}
// where main is now: a re-run keeps its old GITHUB_SHA, so fetch the tip (public repo, no token); offline, the checkout's own origin/main
function mainTip() {
  spawnSync("git", ["-C", IO.root, "fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"],
    { encoding: "utf8", timeout: 60e3, env: { PATH: IO.env.PATH || process.env.PATH || "", HOME: IO.env.HOME || process.env.HOME || "", GIT_TERMINAL_PROMPT: "0" } });
  const r = git(["rev-parse", "--verify", "-q", "refs/remotes/origin/main^{commit}"]).out.trim();
  return isSha(r) ? r : null;
}

// ---- TOML: the subset wrangler files use (tables, arrays of tables, strings, booleans, numbers, arrays, inline tables) ----
export function parseToml(src) {
  const s = String(src).replace(/\r\n/g, "\n"), root = {}, headers = new Set();
  let i = 0, cur = root;
  const err = m => { throw new Error(`toml: ${m} (line ${s.slice(0, i).split("\n").length})`); };
  const ws = () => { while (s[i] === " " || s[i] === "\t") i++; };
  const comment = () => { if (s[i] === "#") while (i < s.length && s[i] !== "\n") i++; };
  const wsnl = () => { for (;;) { ws(); comment(); if (s[i] === "\n") { i++; continue; } return; } };
  function str() {
    const q = s[i];
    if (s.startsWith(q.repeat(3), i)) err("multi-line strings are not supported");
    i++;
    let o = "";
    while (i < s.length && s[i] !== q) {
      if (s[i] === "\n") err("newline in a string");
      if (q === '"' && s[i] === "\\") {
        const e = s[i + 1]; i += 2;
        if (e === "u" || e === "U") { const n = e === "u" ? 4 : 8; o += String.fromCodePoint(parseInt(s.slice(i, i + n), 16)); i += n; }
        else if (e in ESC) o += ESC[e]; else err("bad escape");
      } else o += s[i++];
    }
    if (s[i] !== q) err("unterminated string");
    i++;
    return o;
  }
  const ESC = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", '"': '"', "\\": "\\" };
  function key() {
    ws();
    if (s[i] === '"' || s[i] === "'") { const k = str(); ws(); return k; }
    const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
    if (!m) err("key expected");
    i += m[0].length; ws();
    return m[0];
  }
  const keys = () => { const k = [key()]; while (s[i] === ".") { i++; k.push(key()); } return k; };
  function put(o, ks, v) {
    for (const k of ks.slice(0, -1)) { if (o[k] === undefined) o[k] = {}; o = o[k]; }
    const last = ks[ks.length - 1];
    if (Object.hasOwn(o, last)) err("duplicate key " + last);
    o[last] = v;
  }
  function val() {
    ws();
    const c = s[i];
    if (c === '"' || c === "'") return str();
    if (c === "[") {
      i++;
      const a = [];
      for (;;) {
        wsnl();
        if (s[i] === "]") { i++; return a; }
        a.push(val()); wsnl();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "]") { i++; return a; }
        err("array");
      }
    }
    if (c === "{") {
      i++;
      const o = {};
      ws();
      if (s[i] === "}") { i++; return o; }
      for (;;) {
        const ks = keys();
        if (s[i] !== "=") err("= expected");
        i++;
        put(o, ks, val()); ws();
        if (s[i] === ",") { i++; continue; }
        if (s[i] === "}") { i++; return o; }
        err("inline table");
      }
    }
    const m = /^(true|false|[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?)(?=[ \t,\]}#\n]|$)/.exec(s.slice(i));
    if (!m) err("value expected");
    i += m[0].length;
    return m[1] === "true" ? true : m[1] === "false" ? false : Number(m[1].replace(/_/g, ""));
  }
  function table(ks, arr) {
    let o = root;
    for (const k of ks.slice(0, -1)) { if (o[k] === undefined) o[k] = {}; o = Array.isArray(o[k]) ? o[k][o[k].length - 1] : o[k]; }
    const last = ks[ks.length - 1];
    if (arr) { if (o[last] === undefined) o[last] = []; if (!Array.isArray(o[last])) err("not an array of tables"); const t = {}; o[last].push(t); return t; }
    const id = JSON.stringify(ks);
    if (headers.has(id) || (o[last] !== undefined && (typeof o[last] !== "object" || Array.isArray(o[last])))) err("table redefined");
    headers.add(id);
    if (o[last] === undefined) o[last] = {};
    return o[last];
  }
  for (;;) {
    wsnl();
    if (i >= s.length) break;
    if (s[i] === "[") {
      const arr = s[i + 1] === "[";
      i += arr ? 2 : 1;
      const ks = keys(), close = arr ? "]]" : "]";
      if (!s.startsWith(close, i)) err("table header");
      i += close.length;
      cur = table(ks, arr);
    } else {
      const ks = keys();
      if (s[i] !== "=") err("= expected");
      i++;
      put(cur, ks, val());
    }
    ws(); comment();
    if (i < s.length && s[i] !== "\n") err("unexpected text");
  }
  return root;
}

// the toml wrangler deploys: no_bundle (the file is uploaded byte for byte) and keep_vars (dashboard variables survive) always on,
// the KV placeholder replaced by the real id. Text edits only, so wrangler reads the same file the repo holds.
export function tempToml(text, placeholder, kvId) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  let top = lines.findIndex(l => /^\s*\[/.test(l));
  if (top < 0) top = lines.length;
  const kept = lines.filter((l, n) => !(n < top && /^\s*(keep_vars|no_bundle)\s*=/.test(l)));
  let t = "# written by .github/scripts/workers-deploy.mjs\nno_bundle = true\nkeep_vars = true\n" + kept.join("\n");
  if (kvId) t = t.replace(new RegExp(`^(\\s*id\\s*=\\s*)"${placeholder}"`, "gm"), `$1"${kvId}"`);
  return t;
}

// ---- what the toml declares, the way wrangler 4 applies it ----
const BINDING_TABLES = [   // [toml table, API type, name field, toml target field, API target field]
  ["kv_namespaces", "kv_namespace", "binding", "id", "namespace_id"],
  ["send_email", "send_email", "name", "destination_address", "destination_address"],
  ["services", "service", "binding", "service", "service"],
  ["r2_buckets", "r2_bucket", "binding", "bucket_name", "bucket_name"],
  ["d1_databases", "d1", "binding", "database_id", "id"],
  ["queues.producers", "queue", "binding", "queue", "queue_name"],
  ["durable_objects.bindings", "durable_object_namespace", "name"],
  ["analytics_engine_datasets", "analytics_engine", "binding"], ["hyperdrive", "hyperdrive", "binding"], ["vectorize", "vectorize", "binding"],
  ["mtls_certificates", "mtls_certificate", "binding"], ["dispatch_namespaces", "dispatch_namespace", "binding"], ["workflows", "workflow", "binding"],
  ["ratelimits", "ratelimit", "name"], ["secrets_store_secrets", "secrets_store_secret", "binding"], ["ai", "ai", "binding"],
  ["browser", "browser", "binding"], ["images", "images", "binding"], ["version_metadata", "version_metadata", "binding"], ["assets", "assets", "binding"],
];
export function declared(t) {
  const routes = [...(Array.isArray(t.routes) ? t.routes : []), ...(t.route ? [t.route] : [])].map(r => (typeof r === "string" ? { pattern: r } : r));
  const workersDev = t.workers_dev ?? routes.length === 0;   // wrangler: on unless the file has routes
  const bindings = [];
  for (const [tab, type, nf, tf] of BINDING_TABLES) {
    let v = tab.split(".").reduce((o, k) => (o == null ? undefined : o[k]), t);
    if (v == null) continue;
    for (const b of Array.isArray(v) ? v : [v]) bindings.push({ name: b[nf], type, target: tf ? b[tf] : undefined });
  }
  return {
    routes: routes.filter(r => !r.custom_domain).map(r => r.pattern), domains: routes.filter(r => r.custom_domain).map(r => r.pattern),
    workersDev, previews: t.preview_urls ?? workersDev,   // without preview_urls the API follows workers.dev (wrangler's own warning says so)
    crons: t.triggers?.crons ?? [], vars: t.vars || {}, bindings, cdate: t.compatibility_date || null, cflags: t.compatibility_flags || [],
  };
}
const liveTarget = b => { const f = BINDING_TABLES.find(x => x[1] === b.type); return f && f[4] ? b[f[4]] : undefined; };
const needsVersion = w => w.probe.version === true || (w.probe.checks || []).some(c => c.version === true);

// ---- config ----
export function loadConfig(root = IO.root) {
  const c = JSON.parse(fs.readFileSync(path.join(root, ".github/ship-tail.json"), "utf8"));
  const keys = new Set(), names = new Set();
  if (!/^[a-z0-9.-]+$/.test(c.zone || "") || !c.kv?.title || !/^[A-Z_]+$/.test(c.kv?.placeholder || "")) throw new Error("ship-tail.json: zone/kv");
  for (const w of c.workers) {
    w.raw = JSON.stringify({ ...w });
    const bad = m => { throw new Error(`ship-tail.json: ${w.key || "?"}: ${m}`); };
    if (!/^[a-z][a-z0-9-]*$/.test(w.key || "") || keys.has(w.key)) bad("key");
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(w.name || "") || names.has(w.name)) bad("name");
    if (!["main", "off"].includes(w.deploy)) bad("deploy must be main or off");
    if (typeof w.create !== "boolean") bad("create must be true or false");
    if (!/^worker(\/[a-z0-9-]+)?$/.test(w.dir || "")) bad("dir");
    const p = w.probe || {};
    if (!["http", "health", "version"].includes(p.kind)) bad("probe.kind");
    for (const f of ["version", "readOnly"]) if (p[f] !== undefined && typeof p[f] !== "boolean") bad(`probe.${f} must be true or false`);
    if (p.kind === "http" && !(p.checks || []).length) bad("probe.checks");
    for (const k of p.checks || []) {
      if (!/^https:\/\//.test(k.url || "") || !Number.isInteger(k.status)) bad("probe check url/status");
      if (k.method !== undefined && !["GET", "HEAD"].includes(k.method)) bad("probe check method must be GET or HEAD");
      if (k.version !== undefined && typeof k.version !== "boolean") bad("probe check version must be true or false");
    }
    w.secretsFromGitHub = w.secretsFromGitHub || [];
    for (const s of w.secretsFromGitHub) if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(s) || NEVER_COPY.has(s)) bad("secret name " + s);
    keys.add(w.key); names.add(w.name);
  }
  return c;
}

// ---- Cloudflare API: every call has a deadline; GETs get one retry on 5xx or a network error ----
async function cf(method, p, body, { raw = false } = {}) {
  const tries = method === "GET" ? 2 : 1;
  let last = { ok: false, status: 0, codes: [] };
  for (let k = 0; k < tries; k++) {
    if (k) await IO.sleep(2000);
    try {
      const r = await IO.fetch(CF_API + p, { method, signal: AbortSignal.timeout(T.fetchMs),
        headers: { authorization: "Bearer " + IO.env.CLOUDFLARE_API_TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let j = null;
      try { j = JSON.parse(text); } catch {}
      last = raw ? { ok: r.ok, status: r.status, text, type: r.headers.get("content-type") || "", entry: r.headers.get("cf-entrypoint") || "", codes: (j?.errors || []).map(e => e.code) }
        : { ok: r.ok && j?.success !== false, status: r.status, result: j?.result, info: j?.result_info, codes: (j?.errors || []).map(e => e.code) };
      if (r.status < 500) return last;
    } catch (e) { last = { ok: false, status: 0, codes: [], net: String(e?.cause?.code || e?.name || "error").slice(0, 40) }; }   // never e.message: it can hold the header
  }
  return last;
}
class Unreadable extends Error {}
function need(r, what) {
  if (!r.ok) throw new Unreadable(`${what}: ${r.status ? "HTTP " + r.status : "no answer" + (r.net ? ` (${r.net})` : "")}${r.codes?.length ? " (code " + r.codes.join(",") + ")" : ""}`);
  return r;
}
const notFound = r => r.status === 404 && r.codes.some(c => NOT_FOUND.includes(c));
const acct = () => `/accounts/${IO.env.CF_ACCOUNT_ID}`;
// a read failure: 401/403 is a missing token permission; anything else (5xx, 429, no answer) is Cloudflare's and the next run retries
const readHe = m => (/HTTP 40[13]\b/.test(m) ? `לא הצלחתי לקרוא את המצב החי ב-Cloudflare (${m}). כנראה חסרה הרשאה במפתח CLOUDFLARE_API_TOKEN.`
  : /no answer \(TypeError\)/.test(m) ? `לא הצלחתי לשלוח בקשה ל-Cloudflare (${m}). כנראה יש במפתח CLOUDFLARE_API_TOKEN תו שאי אפשר לשלוח: הדבק אותו מחדש.`
  : `לא הצלחתי לקרוא את המצב החי ב-Cloudflare (${m}). כנראה תקלה זמנית אצל Cloudflare, והריצה הבאה תנסה שוב.`);
function unreadable(R, m) { R.unreadable = m; R.refuse(`live state unreadable: ${m}`, readHe(m)); }
// a token copied from a right-to-left page can carry invisible direction marks, spaces or a line break, and fetch then cannot send it at
// all ("no answer"); a Cloudflare API token is letters, digits, - and _ only, so those are dropped and any other character stops the run.
// Cloudflare shows a new token next to a test command (curl ... -H "Authorization: Bearer <token>"): pasted whole, the token is taken from it.
export function cleanToken(t) {
  const raw = String(t || ""), bearer = /\bBearer\s+([A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/.exec(raw);
  if (bearer && raw.match(/\bBearer\s/g).length === 1) return { value: bearer[1], dropped: 0, bad: 0, fromCommand: true };
  const s = [...raw], v = s.filter(c => !/[\s\p{Cf}]/u.test(c));
  return { value: v.join(""), dropped: s.length - v.length, bad: v.filter(c => !/[A-Za-z0-9_-]/.test(c)).length, fromCommand: false };
}

export function parseMultipart(text, type) {
  const b = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (!b) return null;
  const parts = [];
  for (const chunk of String(text).split("--" + b).slice(1)) {
    if (chunk.startsWith("--")) break;
    const c = chunk.replace(/^\r?\n/, ""), at = c.search(/\r?\n\r?\n/);
    if (at < 0) continue;
    const head = c.slice(0, at);
    parts.push({ name: /name="([^"]*)"/i.exec(head)?.[1] || "", filename: /filename="([^"]*)"/i.exec(head)?.[1] || "",
      type: /content-type:\s*([^\r\n;]+)/i.exec(head)?.[1] || "", body: c.slice(at).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "") });
  }
  return parts;
}
function liveCode(r) {
  if (!r.ok) return { err: "HTTP " + r.status };
  if (!/^multipart\//i.test(r.type)) return { text: r.text, modules: 1 };
  const parts = parseMultipart(r.text, r.type) || [];
  const js = parts.filter(p => /javascript|ecmascript/i.test(p.type) || /\.(m?js|cjs)$/.test(p.filename || p.name));
  const main = parts.find(p => r.entry && (p.name === r.entry || p.filename === r.entry)) || (js.length === 1 ? js[0] : null);
  if (js.length > 1) return { err: `${js.length} modules`, modules: js.length };
  return main ? { text: main.body, modules: 1 } : { err: `no main module among ${parts.length} parts` };
}
// esbuild output of a plain "wrangler deploy" (bundling on): helpers or a "// worker.js" path line on top, "export { x as default };" at the end
export const looksBundled = (s, from) => /export\s*\{\s*[\w$]+\s+as\s+default\s*\};?\s*$/.test(s) &&
  (/\bvar __defProp = Object\.defineProperty;/.test(s) || /^\/\/ \S+\.[cm]?[jt]s\s*$/m.test(s) || from === "wrangler");

// b. the live state of one Worker; throws Unreadable when something cannot be read (= refuse)
async function readLive(w) {
  const A = acct(), S = `${A}/workers/scripts/${w.name}`;
  const svc = await cf("GET", `${A}/workers/services/${w.name}`);
  if (notFound(svc)) return { exists: false };
  need(svc, "the Worker");
  const envName = svc.result?.default_environment?.environment || "production", E2 = `${A}/workers/services/${w.name}/environments/${envName}`;
  const [settings, routes, domains, crons, sub, deps, secrets, list, code] = await Promise.all([
    cf("GET", `${S}/settings`), cf("GET", `${E2}/routes?show_zonename=true`), cf("GET", `${A}/workers/domains?service=${w.name}`),
    cf("GET", `${S}/schedules`), cf("GET", `${S}/subdomain`), cf("GET", `${S}/deployments`), cf("GET", `${S}/secrets`),
    cf("GET", `${S}/versions?deployable=true`), cf("GET", `${E2}/content/v2`, undefined, { raw: true })]);
  for (const [x, what] of [[settings, "settings"], [routes, "routes"], [domains, "custom domains"], [crons, "cron triggers"],
    [sub, "workers.dev state"], [deps, "deployments"], [secrets, "secret names"], [list, "versions"]]) need(x, what);
  const active = deps.result?.deployments?.[0] || null, versions = active?.versions || [], items = list.result?.items || [];
  const newest = items.reduce((a, b) => (a && (a.number ?? 0) >= (b.number ?? 0) ? a : b), null);
  let message = null, number = null, viaSecret = false;
  if (versions.length === 1) {
    const v = need(await cf("GET", `${S}/versions/${versions[0].version_id}`), "the active version");
    message = v.result?.annotations?.["workers/message"] ?? null;
    number = v.result?.number ?? null;
    if (v.result?.annotations?.["workers/triggered_by"] === "secret") {
      // a secret change makes a version on top of the deployed code: the deploy message sits on the newest earlier version that is not one
      viaSecret = true;
      const base = items.filter(x => (x.number ?? 0) < (number ?? Infinity) && x.annotations?.["workers/triggered_by"] !== "secret")
        .sort((a, b) => (b.number ?? 0) - (a.number ?? 0))[0];
      message = base?.annotations?.["workers/message"] ?? null;
    }
  }
  // the active deployment says who chose it: this script (verified or rollback marker), the dashboard, or a deploy
  const ann = active?.annotations || {}, depMsg = String(ann["workers/message"] || ""), by = String(ann["workers/triggered_by"] || "");
  // set by rollback() below: this sha was deployed, failed its check and was rolled back, so it is not retried until the files change again
  const rolledBackFrom = /^ship-tail rollback of ([0-9a-f]{40})$/.exec(depMsg)?.[1] || null;
  const ours = !!rolledBackFrom || /^ship-tail verified [0-9a-f]{40}$/.test(depMsg);
  // chosen by hand: a dashboard rollback, or any version older than the newest made active outside this script; a push never undoes it
  let pinned = "";
  if (!ours && versions.length === 1) {
    if (/^(rollback|promotion)$/i.test(by)) pinned = `the dashboard's ${by.toLowerCase()}`;
    else if (newest?.id && newest.id !== versions[0].version_id) pinned = `version ${number ?? "?"} is active, the newest is ${newest.number ?? "?"}`;
  }
  // deployed by this script (the sha message) but never marked verified: its run stopped between the deploy and the check
  const unverified = !ours && !pinned && !viaSecret && isSha(message);
  return { exists: true, lastFrom: svc.result?.default_environment?.script?.last_deployed_from || null, settings: settings.result || {},
    routes: (routes.result || []).map(x => x.pattern), domains: (domains.result || []).filter(d => !d.service || d.service === w.name).map(d => d.hostname),
    crons: (crons.result?.schedules || []).map(x => x.cron), sub: sub.result || {}, versions, message, number, rolledBackFrom, pinned, unverified,
    secrets: (secrets.result || []).map(x => x.name), code: liveCode(code) };
}
async function zone(ctx) {
  if (!ctx.zone) {
    const z = need(await cf("GET", `/zones?name=${encodeURIComponent(ctx.cfg.zone)}`), "the zone " + ctx.cfg.zone);
    const id = z.result?.[0]?.id;
    if (!id) throw new Unreadable(`the zone ${ctx.cfg.zone} is not visible to the token`);
    const rt = need(await cf("GET", `/zones/${id}/workers/routes`), "the zone's Worker routes");
    ctx.zone = { id, routes: (rt.result || []).map(x => ({ pattern: x.pattern, script: x.script || null })) };
  }
  return ctx.zone;
}
async function accountSub(ctx) {
  if (ctx.sub === undefined) {
    const r = await cf("GET", `${acct()}/workers/subdomain`);
    if (r.ok) ctx.sub = r.result?.subdomain || null;
    else if (r.status === 404) ctx.sub = null;
    else need(r, "the account's workers.dev subdomain");
  }
  return ctx.sub;
}
async function kvFind(ctx) {
  if (ctx.kv.id || ctx.kv.listed) return ctx.kv.id;
  for (let page = 1; page <= 50; page++) {
    const r = need(await cf("GET", `${acct()}/storage/kv/namespaces?per_page=100&page=${page}`), "KV namespaces");
    const hit = (r.result || []).find(n => n.title === ctx.cfg.kv.title);
    if (hit) { ctx.kv.id = hit.id; break; }
    if (page >= (r.info?.total_pages ?? 1)) break;
  }
  ctx.kv.listed = true;
  return ctx.kv.id;
}

// the dashboard-edit check: blob hash -> commit for every version of the file reachable from ref ("HEAD" = main's history, "--all" = any
// branch), after CRLF/trailing-newline normalisation
function history(rel, ref) {
  const blobs = new Map();
  for (const c of git(["log", ref, "--format=%H", "--", rel]).out.split("\n").filter(Boolean)) {
    const b = git(["rev-parse", "--verify", "-q", `${c}:${rel}`]).out.trim();
    if (b && !blobs.has(b)) blobs.set(b, c);
  }
  const out = new Map();
  for (const [b, c] of blobs) { const k = hash(git(["cat-file", "blob", b]).out); if (!out.has(k)) out.set(k, c); }
  return out;
}

// with workers=changed: is what is live behind main for this Worker? Works across cancelled pending runs: the version message is the sha
// the last automatic deploy came from; a Worker deployed by hand counts as changed when this push touched it or its code is not HEAD's
function whyChanged(ctx, w, live, rels, mainAbs) {
  if (!live.exists) return "the script does not exist yet";
  const from = live.rolledBackFrom || live.message, m = hasCommit(from) ? from : null;
  if (m) {
    if (git(["diff", "--quiet", m, "HEAD", "--", ...rels]).code !== 0) return `files changed since ${m.slice(0, 7)}`;
    if (entryAt(m, w.key) !== w.raw) return "its entry in .github/ship-tail.json changed";
    if (live.unverified) return `the live version (from ${m.slice(0, 7)}) was never checked: its run stopped before the check`;
    return "";
  }
  if (isSha(ctx.before) && hasCommit(ctx.before) && git(["diff", "--quiet", ctx.before, "HEAD", "--", ...rels]).code !== 0) return "files changed in this push";
  if (!live.code.text || hash(live.code.text) !== hash(fs.readFileSync(mainAbs, "utf8"))) return "the live code is not the file at HEAD";
  return "";
}

// what is live now, one line for the plan (names only: no var values, no secrets)
function liveSummary(l) {
  const onoff = v => (v === true ? "on" : v === false ? "off" : "?"), b = l.settings.bindings || [];
  return [`version ${(l.versions[0]?.version_id || "?").slice(0, 8)}${l.versions.length > 1 ? ` (+${l.versions.length - 1} more)` : ""} ${isSha(l.message) ? "from " + l.message.slice(0, 7) : `(last deployed from ${l.lastFrom || "?"})`}`,
    l.rolledBackFrom ? `rolled back from ${l.rolledBackFrom.slice(0, 7)}` : "", l.pinned ? `chosen by hand (${l.pinned})` : "", l.unverified ? "never checked" : "",
    `routes: ${l.routes.join(", ") || "none"}`, l.domains.length ? `custom domains: ${l.domains.join(", ")}` : "", `crons: ${l.crons.join(", ") || "none"}`,
    `workers.dev ${onoff(l.sub.enabled)}, previews ${onoff(l.sub.previews_enabled)}`, `vars: ${b.filter(x => VAR_TYPES.has(x.type)).map(x => x.name).join(", ") || "none"}`,
    `secrets: ${l.secrets.join(", ") || "none"}`, `bindings: ${b.filter(x => !VAR_TYPES.has(x.type) && !SECRET_TYPES.has(x.type)).map(x => `${x.name} (${x.type})`).join(", ") || "none"}`,
    `compatibility ${l.settings.compatibility_date || "?"}${(l.settings.compatibility_flags || []).length ? " " + l.settings.compatibility_flags.join(",") : ""}`].filter(Boolean).join("; ");
}

// c. guards: each refusal names what would be lost and what to change; plan lines say what a deploy changes
function guards(ctx, w, t, live, rel, mainRel, R) {
  const d = declared(t), no = (en, he) => R.refuse(en, he), forced = ctx.force.has(w.key);
  for (const [k, v] of Object.entries(d.vars)) if (v === "") no(`empty var ${k} in ${rel}`, `במשתנה ${k} בקובץ ${rel} אין ערך, ופריסה הייתה מוחקת את הערך שבלוח הבקרה. למחוק את השורה מהקובץ.`);
  if (!live.exists) {
    // a first deploy has no check before it and no version to go back to: never automatic for a Worker the site's traffic goes through
    const routed = d.routes.length > 0 || d.domains.length > 0;
    if (!w.create) no("the script does not exist and create is false", routed
      ? `ה-Worker ${w.name} לא קיים ב-Cloudflare. Worker עם נתיב באתר נוצר רק ידנית: ליצור אותו פעם אחת בלוח הבקרה, ואז להריץ שוב.`
      : `ה-Worker ${w.name} לא קיים ב-Cloudflare, והפריסה לא יוצרת אותו. ליצור אותו פעם אחת, או לסמן create בקובץ .github/ship-tail.json.`);
    else if (routed) no(`create is only for Workers without routes or custom domains (${rel} has ${[...d.routes, ...d.domains].join(", ")})`,
      `ה-Worker ${w.name} לא קיים, ולפי ${rel} יש לו נתיב באתר. פריסה ראשונה כזאת לא נבדקת לפני שהיא עולה ואין גרסה קודמת לחזור אליה, ולכן היא לא נעשית אוטומטית. ליצור אותו פעם אחת בלוח הבקרה, ואז להריץ שוב.`);
    else R.plan.push("create the script");
    return d;
  }
  if (live.versions.length !== 1 || live.versions[0].percentage !== 100)
    no("the live deployment is not one version at 100% (a gradual deployment?)", "ב-Cloudflare לא רצה עכשיו גרסה אחת ב-100% (כנראה פריסה הדרגתית). לסיים אותה בלוח הבקרה ואז להריץ שוב.");
  const lb = live.settings.bindings || [], secrets = new Set([...live.secrets, ...lb.filter(b => SECRET_TYPES.has(b.type)).map(b => b.name)]);
  // vars: keep_vars keeps every live var; a toml var only adds or overwrites, so a different value would replace the dashboard's
  for (const [k, v] of Object.entries(d.vars)) {
    if (secrets.has(k)) { no(`var ${k} would replace the live secret of that name`, `השם ${k} מוגדר בקובץ כמשתנה, וב-Cloudflare הוא סוד. פריסה הייתה מחליפה את הסוד. למחוק אותו מהקובץ.`); continue; }
    const l = lb.find(b => VAR_TYPES.has(b.type) && b.name === k);
    const lv = l ? (l.type === "json" ? JSON.stringify(l.json) : l.text) : undefined, tv = typeof v === "string" ? v : JSON.stringify(v);
    if (l && lv !== tv && v !== "") no(`var ${k} differs from the live value`, `למשתנה ${k} יש בקובץ ערך אחר מזה שבלוח הבקרה. להעתיק לקובץ את הערך מלוח הבקרה, או למחוק את השורה מהקובץ.`);
    else if (!l && v !== "") R.plan.push(`add var ${k}`);
  }
  // bindings other than vars and secrets: every live one must be declared with the same type and target
  for (const b of lb) {
    if (VAR_TYPES.has(b.type) || SECRET_TYPES.has(b.type)) continue;
    const m = d.bindings.find(x => x.name === b.name);
    if (!m || m.type !== b.type) no(`live binding ${b.name} (${b.type}) is not in ${rel}`, `בלוח הבקרה יש חיבור ${b.name} (${b.type}) שלא מופיע ב-${rel}, ופריסה הייתה מוחקת אותו. להוסיף אותו לקובץ.`);
    else if (m.target !== undefined && liveTarget(b) !== undefined && String(m.target) !== String(liveTarget(b)))
      no(`binding ${b.name} (${b.type}) points elsewhere in ${rel}`, `החיבור ${b.name} (${b.type}) מצביע בקובץ על יעד אחר מזה שבלוח הבקרה. להתאים את הקובץ ללוח הבקרה.`);
  }
  for (const b of d.bindings) {
    if (secrets.has(b.name)) no(`binding ${b.name} would replace the live secret of that name`, `השם ${b.name} מוגדר בקובץ כחיבור, וב-Cloudflare הוא סוד. לשנות את השם בקובץ.`);
    else if (!lb.some(x => x.name === b.name)) R.plan.push(`add binding ${b.name} (${b.type})`);
  }
  for (const p of live.routes) if (!d.routes.includes(p)) no(`live route ${p} is not in ${rel}`, `ל-Worker יש בלוח הבקרה נתיב ${p} שלא מופיע ב-${rel}, ופריסה הייתה מוחקת אותו. להוסיף אותו ל-routes בקובץ.`);
  for (const p of d.routes) if (!live.routes.includes(p)) R.plan.push(`add route ${p}`);
  for (const h of live.domains) if (!d.domains.includes(h)) no(`live custom domain ${h} is not in ${rel}`, `ל-Worker יש דומיין ${h} שלא מופיע ב-${rel}. להוסיף אותו ל-routes עם custom_domain = true.`);
  for (const c of live.crons) if (!d.crons.includes(c)) no(`live cron "${c}" is not in ${rel}`, `ל-Worker יש בלוח הבקרה תזמון "${c}" שלא מופיע ב-${rel}. להוסיף אותו ל-crons תחת [triggers] בקובץ.`);
  for (const c of d.crons) if (!live.crons.includes(c)) R.plan.push(`add cron "${c}"`);
  const onoff = v => (v ? "on" : "off");
  if (typeof live.sub.enabled === "boolean" && live.sub.enabled !== d.workersDev)
    no(`workers.dev is ${onoff(live.sub.enabled)} live, the deploy would turn it ${onoff(d.workersDev)}`,
      `כתובת workers.dev ${live.sub.enabled ? "פעילה" : "כבויה"} בלוח הבקרה, והפריסה הייתה ${d.workersDev ? "מפעילה" : "מכבה"} אותה. להוסיף ל-${rel} את השורה workers_dev = ${live.sub.enabled}, או לשנות בלוח הבקרה.`);
  if (typeof live.sub.previews_enabled === "boolean" && live.sub.previews_enabled !== d.previews)
    no(`preview URLs are ${onoff(live.sub.previews_enabled)} live, the deploy would turn them ${onoff(d.previews)}`,
      `כתובות התצוגה המקדימה (Preview URLs) ${live.sub.previews_enabled ? "פעילות" : "כבויות"} בלוח הבקרה, והפריסה הייתה ${d.previews ? "מפעילה" : "מכבה"} אותן. להוסיף ל-${rel} את השורה preview_urls = ${live.sub.previews_enabled}.`);
  const st = live.settings;
  for (const f of st.compatibility_flags || []) if (!d.cflags.includes(f))
    no(`live compatibility flag ${f} is not in ${rel}`, `בלוח הבקרה מוגדר compatibility flag בשם ${f} שלא מופיע ב-${rel}. להוסיף אותו ל-compatibility_flags בקובץ.`);
  if (st.compatibility_date && d.cdate && st.compatibility_date !== d.cdate) R.warn(`compatibility_date ${st.compatibility_date} live, ${d.cdate} in ${rel} (the deploy changes it)`);
  // settings the dashboard can switch on that a deploy resets when the toml is silent about them
  const lost = [];
  if ((st.observability?.enabled || st.observability?.logs?.enabled) && t.observability === undefined)   // logs hold request URLs (a ?plate= link): keeping them is a choice
    lost.push(["Workers Logs (observability)", "[observability] enabled = true כדי להשאיר אותו, או enabled = false כדי לכבות אותו בכוונה"]);
  if (st.logpush === true && t.logpush === undefined) lost.push(["Logpush", "logpush = true"]);
  if (st.placement?.mode === "smart" && t.placement === undefined) lost.push(["Smart Placement", '[placement] mode = "smart"']);
  if ((st.tail_consumers || []).length && t.tail_consumers === undefined) lost.push(["Tail Workers", "tail_consumers"]);
  if (st.limits?.cpu_ms && t.limits === undefined) lost.push(["CPU limit", "[limits] cpu_ms"]);
  for (const [what, fix] of lost) no(`${what} is on live and ${rel} does not declare it`, `בלוח הבקרה מופעל ${what}, והקובץ ${rel} לא מזכיר אותו, ולכן פריסה הייתה מכבה אותו. להוסיף לקובץ: ${fix}.`);
  // the code: live must be a version of the file on main; anything else is replaced only when force_code names this Worker
  const head = hash(fs.readFileSync(path.join(IO.root, mainRel), "utf8"));
  if (live.code.err) {
    if (forced) { R.warn(`live code unreadable (${live.code.err}); replaced because force_code names ${w.key}`); R.forced = "unreadable"; }
    else no(`live code cannot be compared (${live.code.err})`, `לא הצלחתי להשוות את הקוד החי לקובץ (${live.code.err}). אם זה בסדר לדרוס אותו, להריץ ידנית עם force_code=${w.key}.`);
    return d;
  }
  const h = hash(live.code.text), onMain = history(mainRel, "HEAD").get(h);
  if (onMain) { R.plan.push(h === head ? "code: unchanged (live = the file at HEAD)" : `code: update (live = ${mainRel} at ${onMain.slice(0, 7)})`); return d; }
  const elsewhere = history(mainRel, "--all").get(h), bundled = !elsewhere && looksBundled(norm(live.code.text), live.lastFrom);
  const kind = elsewhere ? `${mainRel} from ${elsewhere.slice(0, 7)}, which is not on main` : bundled ? "bundled by wrangler (a plain wrangler deploy)" : "edited in the dashboard";
  if (forced) { R.warn(`live code is ${kind}; replaced because force_code names ${w.key}`); R.forced = kind; return d; }
  if (elsewhere) no(`live code is ${kind}`,
    `הקוד החי של ${w.name} הוא ${mainRel} מ-${elsewhere.slice(0, 7)}, שלא נמצא ב-main (כנראה נפרס מענף אחר). כדי לא לדרוס אותו, לא נפרס כלום. להכניס את השינוי ל-main, או להריץ ידנית עם force_code=${w.key}.`);
  else if (bundled) no(`live code was bundled by wrangler (a plain wrangler deploy), so it cannot be compared with git`,
    `הקוד החי של ${w.name} הועלה בעבר עם wrangler deploy רגיל, שאורז את הקובץ מחדש, ולכן אי אפשר להשוות אותו לגרסאות ב-git. אם הוא הועלה מהקובץ שב-git, להריץ ידנית עם force_code=${w.key} (רק ל-Worker הזה).`);
  else no(`live code matches no version of ${mainRel} in git (edited in the dashboard)`,
    `הקוד החי של ${w.name} שונה מכל גרסה של ${mainRel} ב-git, כלומר מישהו ערך אותו בלוח הבקרה. להעתיק את השינוי לקובץ ב-git, או להריץ ידנית עם force_code=${w.key} כדי לדרוס אותו.`);
  return d;
}

// ---- probes ----
async function get(u, ua, method = "GET") {
  try {
    const r = await IO.fetch(u, { method, headers: { "user-agent": ua, "cache-control": "no-cache" }, redirect: "manual", signal: AbortSignal.timeout(15000) });
    const text = method === "HEAD" ? "" : (await r.text()).slice(0, 2e6);
    return { status: r.status, text, location: r.headers.get("location") || "", version: r.headers.get(VERSION_HEADER) || "" };
  } catch (e) { return { err: /timeout|abort/i.test(String(e?.name)) ? "timeout" : "network" }; }
}
// "" when fine, else a short Hebrew reason; want = the version id an answer marked "version" must name (null = any version)
async function probeOnce(ctx, w, want) {
  const p = w.probe;
  if (p.kind === "version") return "";
  const other = (u, x, flag) => (flag && want && x.version !== want ? `${short(u)}: ענתה גרסה ${x.version ? x.version.slice(0, 8) : "לא ידועה"} ולא החדשה ${want.slice(0, 8)}` : "");
  if (p.kind === "health") {
    const sub = await accountSub(ctx).catch(() => null);
    if (!sub) return "אין לחשבון כתובת workers.dev";
    const u = `https://${w.name}.${sub}.workers.dev${p.path || "/health"}`, x = await get(u, "luchit-ship-tail/1");
    if (x.err) return `${short(u)}: אין תשובה (${x.err})`;
    if (x.status !== 200) return `${short(u)} ענה ${x.status}`;
    let j = null;
    try { j = JSON.parse(x.text); } catch {}
    if (!j) return `${short(u)} לא החזיר JSON`;
    return other(u, x, p.version);
  }
  for (const c of p.checks) {
    const u = c.url.replace("{nonce}", `${IO.env.GITHUB_RUN_ID || "local"}-${Date.now().toString(36)}`), x = await get(u, c.ua === "browser" ? BROWSER_UA : c.ua, c.method || "GET");
    const at = (c.method === "HEAD" ? "HEAD " : "") + short(u);
    if (x.err) return `${at}: אין תשובה (${x.err})`;
    if (x.status !== c.status) return `${at} ענה ${x.status} במקום ${c.status}`;
    for (const n of c.contains || []) if (!x.text.includes(n)) return `${at}: חסר בתשובה "${n}"`;
    if (c.location && !x.location.includes(c.location)) return `${at}: הפניה לא צפויה`;
    const v = other(u, x, c.version);
    if (v) return v;
  }
  return "";
}
// passes in a row: after a deploy two, so one answer from a lucky edge cannot carry a bad version
async function probe(ctx, w, want, passes = 1) {
  let why = "", run = 0;
  for (let i = 0; i < T.probeTries; i++) {
    if (i) await IO.sleep(T.probeGap);
    why = await probeOnce(ctx, w, want);
    if (why) run = 0;
    else if (++run >= passes) return "";
  }
  return why || "הבדיקה לא עברה פעמיים ברצף";
}
// the active deployment is exactly this version at 100% (a few tries: the API is eventually consistent)
async function activeIs(w, want) {
  for (let i = 0; i < T.depTries; i++) {
    if (i) await IO.sleep(T.depGap);
    const d = await cf("GET", `${acct()}/workers/scripts/${w.name}/deployments`), v = d.ok ? d.result?.deployments?.[0]?.versions || [] : [];
    if (v.length === 1 && v[0].percentage === 100 && v[0].version_id === want) return true;
  }
  return false;
}
// what is active now, or known=false when the API stays unreadable (then nothing may be written on a guess)
async function readActive(w) {
  for (let i = 0; i < T.depTries; i++) {
    if (i) await IO.sleep(T.depGap);
    const d = await cf("GET", `${acct()}/workers/scripts/${w.name}/deployments`);
    if (notFound(d)) return { known: true, versions: [] };
    if (d.ok) return { known: true, versions: d.result?.deployments?.[0]?.versions || [] };
  }
  return { known: false, versions: [] };
}
async function newestVersion(w) {
  const r = await cf("GET", `${acct()}/workers/scripts/${w.name}/versions?deployable=true`);
  const items = r.ok ? r.result?.items || [] : [];
  return items.reduce((a, b) => (a && (a.number ?? 0) >= (b.number ?? 0) ? a : b), null)?.id || null;
}
async function rollback(ctx, w, prev) {
  const body = { strategy: "percentage", versions: [{ version_id: prev, percentage: 100 }], annotations: { "workers/message": `ship-tail rollback of ${ctx.sha}` } };
  const S = `${acct()}/workers/scripts/${w.name}/deployments`;
  let r = await cf("POST", S, body);
  if (!r.ok && r.codes.includes(ROLLBACK_SECRETS_CHANGED)) r = await cf("POST", S + "?force=true", body);
  return r.ok;
}
// the same version deployed again with the marker "ship-tail verified <sha>": traffic does not change, and a run that stops between
// the deploy and here leaves the version unmarked, so the next run checks that Worker again (readLive: unverified)
async function markVerified(ctx, w, ver, R) {
  const r = await cf("POST", `${acct()}/workers/scripts/${w.name}/deployments`,
    { strategy: "percentage", versions: [{ version_id: ver, percentage: 100 }], annotations: { "workers/message": `ship-tail verified ${ctx.sha}` } });
  if (!r.ok) R.warn(`the version passed its check but could not be marked as checked (HTTP ${r.status}); the next run checks it again`);
}

// ---- wrangler: a minimal environment (no Telegram or other secrets), Cloudflare credentials only for writes ----
function wrangler(label, args, { cwd, input = "", creds = false, outFile } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(IO.env)) if (!SECRET_NAMES.has(k)) env[k] = v;
  Object.assign(env, { CI: "true", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" });
  if (creds) Object.assign(env, { CLOUDFLARE_API_TOKEN: IO.env.CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID: IO.env.CF_ACCOUNT_ID });
  if (outFile) env.WRANGLER_OUTPUT_FILE_PATH = outFile;
  const r = IO.run(args, { cwd, input, env });
  const shown = scrub(r.out).split("\n").filter(l => l.trim()).slice(-30).map(l => "    " + l).join("\n");
  say(`::group::wrangler ${label} (exit ${r.code})\n${shown}\n::endgroup::`);
  return r;
}
function deployedVersion(outFile, text) {
  try {
    for (const l of fs.readFileSync(outFile, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const j = JSON.parse(l);
      if (j.type === "deploy" && j.version_id) return j.version_id;
    }
  } catch {}
  return /Current Version ID:\s*([0-9a-f-]{36})/i.exec(text)?.[1] || null;
}

// ---- alerts: through the router (.github/scripts/alert.mjs), today's direct Telegram send as its legacy ----
async function tgLegacy(text) {
  const E = IO.env;
  if (!E.TELEGRAM_BOT_TOKEN || !E.TELEGRAM_CHAT_ID) return false;
  try {
    const r = await IO.fetch(`https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: E.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15000) });
    return r.ok;
  } catch { return false; }
}
async function router() {
  if (IO.router === undefined) { IO.router = null; try { IO.router = await import("./alert.mjs"); } catch {} }
  return IO.router;
}
async function tell(level, key, text) {
  const rt = await router(), link = /^https:\/\//.test(IO.env.RUN_URL || "") ? IO.env.RUN_URL : "", body = text + (link ? "\n" + link : "");
  try {
    if (rt) return (await rt.alert(level, key, body, link, { today: "loud", plain: true, legacy: () => tgLegacy(body) })).delivered;
  } catch {}
  return tgLegacy(body);
}

// ---- one Worker, a to g (the deploy job) ----
async function one(ctx, w, changedOnly) {
  const R = { key: w.key, name: w.name, dir: w.dir, action: "", reasons: [], he: [], plan: [], warnings: [], version: null, previous: null, probe: null, changed: null };
  R.refuse = (en, he) => { R.reasons.push(en); R.he.push(he); };
  R.warn = m => R.warnings.push(m);
  const done = a => { R.action = a; return R; };
  if (ctx.mode === "on" && w.deploy !== "main") { R.reasons.push("deploy is off in .github/ship-tail.json"); return done("off"); }
  const rel = `${w.dir}/wrangler.toml`, tomlAbs = path.join(IO.root, rel);
  let text, t;
  try { text = fs.readFileSync(tomlAbs, "utf8"); t = parseToml(text); } catch (e) {
    R.refuse(`${rel}: ${e.message}`, `לא הצלחתי לקרוא את ${rel}: ${e.message}`);
    return done("refused");
  }
  if (!/^[\w.-]+$/.test(t.main || "")) { R.refuse(`${rel}: main must be a file next to it`, `ב-${rel} השדה main צריך להיות שם של קובץ באותה תיקייה.`); return done("refused"); }
  const mainRel = `${w.dir}/${t.main}`, mainAbs = path.join(IO.root, mainRel), rels = [rel, mainRel];
  if (t.name !== w.name) R.refuse(`${rel} names "${t.name}", the config says ${w.name}`, `בקובץ ${rel} השם הוא "${t.name}" ולא ${w.name}. לתקן את name בקובץ.`);
  const placeholder = (t.kv_namespaces || []).some(k => k.id === ctx.cfg.kv.placeholder);
  // b first: an unchanged Worker stops here, quietly
  let live = null;
  try { live = await readLive(w); } catch (e) {
    if (!(e instanceof Unreadable)) throw e;
    unreadable(R, e.message);
    return done("refused");
  }
  if (live.exists) { R.previous = live.versions.length === 1 ? live.versions[0].version_id : null; R.state = liveSummary(live); }
  // main has moved on with other files for this Worker (a re-run of an older run, or a push overtaken by the next): the run for main
  // deploys them, and this one must not put older files over them
  if (ctx.main && ctx.main !== ctx.sha && !isAncestor(ctx.main, ctx.sha) &&
    (git(["diff", "--quiet", ctx.sha, ctx.main, "--", ...rels]).code !== 0 || entryAt(ctx.main, w.key) !== w.raw)) {
    R.reasons.push(`main is at ${ctx.main.slice(0, 7)} with other files for this Worker: the run for main deploys them`);
    return done("superseded");
  }
  if (changedOnly) {
    if (!fs.existsSync(mainAbs)) { R.refuse(`${mainRel} is missing`, `הקובץ ${mainRel} חסר.`); return done("refused"); }
    R.changed = whyChanged(ctx, w, live, rels, mainAbs);
    if (!R.changed) return done("unchanged");
  }
  if (live.exists) {
    const from = live.rolledBackFrom || live.message;
    if (hasCommit(from) && !isAncestor(from, ctx.sha) && !ctx.force.has(w.key)) {
      R.refuse(`live comes from ${from.slice(0, 7)}, which is newer than this run or not in its history (a re-run of an older run?)`,
        `הגרסה החיה של ${w.name} נפרסה מ-${from.slice(0, 7)}, שלא נמצא בהיסטוריה של ההרצה הזאת (כנראה הרצה חוזרת של ריצה ישנה). כדי לא להחזיר קוד ישן, לא נפרס כלום. להריץ מחדש מ-main העדכני.`);
      return done("refused");
    }
    if (live.pinned && !ctx.explicit.has(w.key)) {
      R.refuse(`the live version was chosen by hand in the dashboard (${live.pinned}); only a manual run that names ${w.key} replaces it`,
        `ב-${w.name} פעילה עכשיו גרסה שנבחרה ידנית בלוח הבקרה (למשל החזרה לגרסה קודמת), ופריסה אוטומטית לא מחליפה אותה. כשהתיקון מוכן ב-main, להריץ ידנית: Actions > Workers deploy > Run workflow, עם workers=${w.key} ו-mode=on.`);
      return done("refused");
    }
    if (live.pinned) R.warn(`the live version was chosen by hand (${live.pinned}); replaced because this manual run names ${w.key}`);
  }
  // a. the file itself, then wrangler's own dry run on the temp toml
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `ship-tail-${w.key}-`));
  try {
    let code = null;
    try { code = fs.readFileSync(mainAbs); } catch { R.refuse(`${mainRel} is missing`, `הקובץ ${mainRel} חסר.`); return done("refused"); }
    fs.writeFileSync(path.join(tmp, "check.mjs"), code);
    const chk = spawnSync(process.execPath, ["--check", path.join(tmp, "check.mjs")], { encoding: "utf8" });
    if (chk.status !== 0) R.refuse(`${mainRel}: node --check failed: ${scrub(chk.stderr || "").split("\n").find(l => /Error/.test(l)) || "syntax error"}`, `יש שגיאת תחביר ב-${mainRel}.`);
    if (/^\s*import\s*(?:[\w*{$][^;]*?\sfrom\s*)?["'][^"']+["']|^\s*export\s+(?:\*|\{[^}]*\})\s*from\s*["']/m.test(code.toString("utf8")))
      R.refuse(`${mainRel} has a static import (no_bundle uploads one file as it is)`, `ב-${mainRel} יש import. הפריסה מעלה את הקובץ כמו שהוא, בלי איחוד קבצים, ולכן הוא צריך להיות קובץ אחד בלי import.`);
    let kvId = null;
    if (placeholder) {
      try { kvId = await kvFind(ctx); } catch (e) {
        if (!(e instanceof Unreadable)) throw e;
        unreadable(R, e.message);
      }
      // the creator plans the namespace; main() lets the others count on it only once the creator itself ended "planned"
      if (!kvId && !R.reasons.length) {
        if (w.create) { R.plan.push(`create KV namespace ${ctx.cfg.kv.title}`); R.kvCreate = true; }
        else if (ctx.kv.wouldCreate) R.plan.push(`KV ${ctx.cfg.kv.title}: created in this run by ${ctx.kv.wouldCreate}`);
        else R.refuse(`KV namespace ${ctx.cfg.kv.title} does not exist (luchit-uptime creates it)`, `מאגר ה-KV בשם ${ctx.cfg.kv.title} לא קיים עדיין. הוא נוצר בפריסה הראשונה של luchit-uptime, ולכן צריך להריץ אותה קודם.`);
      } else if (kvId) R.plan.push(`KV ${ctx.cfg.kv.title} = ${kvId.slice(0, 8)}…`);
    }
    const tomlTmp = path.join(tmp, "wrangler.toml");
    fs.copyFileSync(mainAbs, path.join(tmp, t.main));
    const tt = tempToml(text, ctx.cfg.kv.placeholder, kvId || (placeholder ? "0".repeat(32) : null));
    fs.writeFileSync(tomlTmp, tt);
    const pt = parseToml(tt);
    if (pt.keep_vars !== true || pt.no_bundle !== true || (pt.kv_namespaces || []).some(k => k.id === ctx.cfg.kv.placeholder)) throw new Error("temp toml check failed");
    const dry = wrangler(`deploy --dry-run ${w.name}`, ["deploy", "--dry-run", "--outdir", path.join(tmp, "out"), "--config", tomlTmp], { cwd: tmp });
    if (dry.code !== 0) R.refuse("wrangler deploy --dry-run failed (see the log)", "הבדיקה היבשה של wrangler נכשלה. הפירוט ביומן ההרצה.");
    else {
      let built = null;
      try { built = fs.readFileSync(path.join(tmp, "out", t.main)); } catch {}
      if (!built || !built.equals(code)) R.refuse("the dry-run output is not byte-identical to the file", "wrangler היה מעלה קוד שונה מהקובץ. הפירוט ביומן ההרצה.");
    }
    // c. guards against the live state
    let d = null;
    try {
      d = guards(ctx, w, kvId ? parseToml(tempToml(text, ctx.cfg.kv.placeholder, kvId)) : t, live, rel, mainRel, R);
      const z = await zone(ctx);
      for (const p of d.routes) { const o = z.routes.find(x => x.pattern === p && x.script && x.script !== w.name); if (o) R.refuse(`route ${p} belongs to ${o.script}`, `הנתיב ${p} שבקובץ שייך עכשיו ל-Worker אחר (${o.script}). להחליט למי הוא שייך ולתקן את הקובץ או את לוח הבקרה.`); }
      if ((d.workersDev || w.probe.kind === "health") && !(await accountSub(ctx)))
        R.refuse("the account has no workers.dev subdomain", "לחשבון Cloudflare אין עדיין כתובת workers.dev. לבחור אותה פעם אחת בלוח הבקרה של Workers.");
    } catch (e) {
      if (!(e instanceof Unreadable)) throw e;
      unreadable(R, e.message);
    }
    // a version check without the binding that names the version could never pass: every deploy would roll back
    if (d && needsVersion(w) && !d.bindings.some(b => b.type === "version_metadata"))
      R.refuse(`.github/ship-tail.json checks which version answers, but ${rel} has no [version_metadata] binding`,
        `הבדיקה של ${w.name} ב-.github/ship-tail.json מזהה את הגרסה שעונה, אבל ב-${rel} אין [version_metadata]. להוסיף אותו לקובץ, או להוריד את "version" מהבדיקה.`);
    // d. the check must pass on the live version first, or it cannot tell a bad deploy from a bad site
    if (!R.reasons.length && live.exists && w.probe.kind !== "version") {
      if (ctx.mode !== "on" && w.probe.readOnly === false) R.plan.push("pre-deploy check not opened in dry mode (opening it changes state)");
      else {
        const base = await probe(ctx, w, null);
        if (!base) R.plan.push("post-deploy check passes on the live version");
        else if (ctx.skipPre.has(w.key)) R.warn(`the post-deploy check already fails on the live version (${base}); deploying anyway because skip_precheck names ${w.key}`);
        else R.refuse(`the post-deploy check already fails on the live version: ${base}`,
          `הבדיקה שרצה אחרי פריסה נכשלת כבר עכשיו, לפני כל שינוי (${base}). בלי בדיקה שעובדת אין פריסה. לבדוק את האתר, או לתקן את הבדיקה ב-.github/ship-tail.json. אם רק הקוד החדש מתקן את זה, להריץ ידנית עם skip_precheck=${w.key}.`);
      }
    }
    // e (after job). secrets the Worker lacks: names only here; the values live in the after job, which runs no npm code
    R.secretsMissing = w.secretsFromGitHub.filter(n => !(live.exists && live.secrets.includes(n)));
    for (const n of R.secretsMissing) R.plan.push(`after the deploy: put secret ${n} from the GitHub secret of that name (missing on the Worker)`);
    if (R.reasons.length) return done("refused");
    if (ctx.mode !== "on") return done("planned");

    // e. deploy (the KV namespace first when this Worker may create it)
    if (placeholder && !kvId) {
      const c = await cf("POST", `${acct()}/storage/kv/namespaces`, { title: ctx.cfg.kv.title });
      if (!c.ok || !c.result?.id) { R.refuse(`creating KV ${ctx.cfg.kv.title} failed (HTTP ${c.status})`, `יצירת מאגר ה-KV בשם ${ctx.cfg.kv.title} נכשלה. כנראה חסרה הרשאת Workers KV Storage: Edit במפתח.`); return done("failed"); }
      ctx.kv.id = kvId = c.result.id;
      say(`KV namespace ${ctx.cfg.kv.title} created`);
      fs.writeFileSync(tomlTmp, tempToml(text, ctx.cfg.kv.placeholder, kvId));
    }
    const outFile = path.join(tmp, "wrangler-output.ndjson");
    const dep = wrangler(`deploy ${w.name}`, ["deploy", "--config", tomlTmp, "--message", ctx.sha], { cwd: tmp, creds: true, outFile });
    const prev = R.previous;
    if (dep.code !== 0) {
      // write only on proof: unchanged live = a plain failure; unreadable = report it, change nothing; a new active version = go back
      const now = await readActive(w), v = now.versions;
      if (now.known && (!live.exists ? !v.length : v.length === 1 && v[0].version_id === prev && v[0].percentage === 100)) {
        R.reasons.push("wrangler deploy failed; nothing changed live");
        R.he.push("wrangler החזיר שגיאה, ושום דבר לא השתנה ב-Cloudflare. הפירוט ביומן ההרצה.");
        return done("failed");
      }
      if (!now.known) {
        R.reasons.push("wrangler deploy failed and the live state could not be read afterwards");
        R.he.push("wrangler החזיר שגיאה, ואחר כך לא הצלחתי לקרוא מה רץ עכשיו ב-Cloudflare. לבדוק בלוח הבקרה שהגרסה הפעילה היא הקודמת.");
        return done("failed");
      }
      return await recover(ctx, w, R, prev, "wrangler החזיר שגיאה באמצע הפריסה");
    }
    const ver = deployedVersion(outFile, dep.out);
    R.version = ver;
    // f. verify: the new version live at 100%, a settle wait for the edge, then the check twice in a row
    if (!ver || !(await activeIs(w, ver))) return await recover(ctx, w, R, prev, "הגרסה החדשה לא פעילה ב-100%");
    await IO.sleep(T.settle);
    const why = await probe(ctx, w, ver, T.probePasses);
    if (why) return await recover(ctx, w, R, prev, why);
    R.probe = "ok";
    await markVerified(ctx, w, ver, R);
    return done(live.exists ? "deployed" : "created");
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// g. back to the previous version and check it again; the alert itself is sent by the after job
async function recover(ctx, w, R, prev, why) {
  R.probe = "failed";
  R.why = why;
  R.reasons.push("post-deploy check failed: " + why);
  if (!prev) { R.after = "none"; return Object.assign(R, { action: "failed" }); }
  if (!(await rollback(ctx, w, prev)) || !(await activeIs(w, prev))) { R.after = "rollback-failed"; return Object.assign(R, { action: "rollback-failed" }); }
  await IO.sleep(T.settle);
  const again = await probe(ctx, w, null);
  R.after = again ? "still-failing" : "ok";
  if (again) R.reasons.push("after the rollback: " + again);
  return Object.assign(R, { action: "rolled-back", version: prev });
}

function alertFor(r) {
  const he = r.he || [];
  if (r.action === "refused") return ["day", `workers:refused:${r.name}`,
    `⚠️ לוחית: הפריסה של ${r.name} נעצרה\n${he.map(x => "• " + x).join("\n")}\nשום דבר לא השתנה ב-Cloudflare.`];
  if (r.action === "rolled-back" || r.action === "rollback-failed" || (r.action === "failed" && r.probe === "failed")) {
    const after = r.action === "rollback-failed" ? "ההחזרה לגרסה הקודמת לא הצליחה. צריך לבדוק עכשיו ב-Cloudflare."
      : r.after === "none" ? "זה Worker חדש, ואין גרסה קודמת להחזיר."
      : r.after === "ok" ? "הגרסה הקודמת חזרה לפעול והבדיקה עוברת שוב." : "הגרסה הקודמת חזרה, אבל גם היא לא עוברת את הבדיקה. צריך לבדוק עכשיו.";
    const title = r.action === "rolled-back" ? `הפריסה של ${r.name} נכשלה בבדיקה והוחזרה לגרסה הקודמת` : `הפריסה של ${r.name} נכשלה בבדיקה`;
    return ["critical", `workers:rollback:${r.name}`, `🔴 לוחית: ${title}\nמה נכשל: ${r.why}\n${after}`];
  }
  if (r.action === "failed") return ["day", `workers:failed:${r.name}`, `⚠️ לוחית: הפריסה של ${r.name} נכשלה\n${he.join("\n")}`];
  return null;
}

// ---- report: job summary, step outputs, result file ----
const RANK = ["off", "skipped", "superseded", "unchanged", "planned", "deployed", "created", "refused", "failed", "rolled-back", "rollback-failed"];
function finish(res, title = "") {
  const E = IO.env, worst = res.workers.reduce((a, w) => (RANK.indexOf(w.action) > RANK.indexOf(a) ? w.action : a), res.outcome || "skipped");
  res.outcome = worst;
  const clean = { ...res, workers: res.workers.map(({ refuse, warn, ...w }) => w) };
  const json = scrub(JSON.stringify(clean));
  if (E.RESULT_FILE) fs.writeFileSync(E.RESULT_FILE, json + "\n");
  if (E.GITHUB_OUTPUT) fs.appendFileSync(E.GITHUB_OUTPUT, `result=${json}\noutcome=${worst}\nmode=${res.mode || "none"}\n`);
  if (E.GITHUB_STEP_SUMMARY && res.workers.length) {
    const L = [`## Workers deploy${title}: ${res.mode} at ${res.sha.slice(0, 7)}`, "", "| Worker | Result | Version | Details |", "|---|---|---|---|"];
    for (const w of res.workers) L.push(`| ${w.name} | ${w.action} | ${md((w.version || "").slice(0, 8))} | ${md([...(w.reasons.length ? w.reasons : w.plan.filter(p => !/^code: unchanged/.test(p))),
      w.changed && "changed: " + w.changed, w.probe && "probe " + w.probe].filter(Boolean).join("; "))} |`);
    for (const w of res.workers.filter(x => x.plan.length || x.warnings.length || x.state)) {
      L.push("", `<details><summary>${w.name}: ${w.action}</summary>`, "");
      if (w.state) L.push("- live: " + md(w.state));
      for (const p of w.plan) L.push("- " + md(p));
      for (const p of w.warnings) L.push("- warning: " + md(p));
      L.push("", "</details>");
    }
    fs.appendFileSync(E.GITHUB_STEP_SUMMARY, scrub(L.join("\n")) + "\n");
  }
  return worst;
}

// the deploy job
export async function main() {
  const E = IO.env, res = { v: 2, sha: "", mode: "", event: E.EVENT || "", workers: [], outcome: "skipped" };
  const ship = String(E.SHIP_TAIL || "").trim().toLowerCase();
  if (ship === "off") { say("::notice::SHIP_TAIL=off: Workers deploy does nothing"); res.mode = "off"; res.outcome = "off"; finish(res); return 0; }
  if (!E.CLOUDFLARE_API_TOKEN || !E.CF_ACCOUNT_ID) {
    say("::notice::Workers deploy skipped: the secrets CLOUDFLARE_API_TOKEN and CF_ACCOUNT_ID are not both set");
    finish(res);
    return 0;
  }
  if (!/^[0-9a-f]{32}$/i.test(E.CF_ACCOUNT_ID)) { say("::error::CF_ACCOUNT_ID is not a 32-character Cloudflare account id"); return 1; }
  const tok = cleanToken(E.CLOUDFLARE_API_TOKEN);
  if (tok.bad || !tok.value) { say(`::error::CLOUDFLARE_API_TOKEN ${tok.bad ? `has ${tok.bad} character(s) no Cloudflare API token has (it is letters, digits, - and _ only)` : "is only spaces or invisible marks"}: paste the token again`); return 1; }
  if (tok.fromCommand) say("::notice::CLOUDFLARE_API_TOKEN holds Cloudflare's test command, not the token alone: the token after \"Bearer\" is used");
  else if (tok.dropped) say(`::notice::CLOUDFLARE_API_TOKEN: dropped ${tok.dropped} invisible character(s) (spaces, line breaks or direction marks) that came with the paste`);
  E.CLOUDFLARE_API_TOKEN = tok.value;   // wrangler gets the clean token too
  let mode = ship === "" || ship === "on" ? "on" : "dry";
  if (ship !== "" && ship !== "on" && ship !== "dry") say(`::notice::SHIP_TAIL=${ship.slice(0, 20)} is not off, dry or on: planning only`);
  const dispatch = E.EVENT === "workflow_dispatch";
  if (dispatch && E.MODE !== "on") mode = "dry";
  // production comes from main only: a manual run started on another branch plans, it never deploys that branch's code
  if (E.GITHUB_ACTIONS === "true" && E.GITHUB_REF !== "refs/heads/main" && mode === "on") { mode = "dry"; say(`::notice::${String(E.GITHUB_REF).slice(0, 60)} is not main: planning only`); }
  const cfg = loadConfig();
  SECRET_NAMES = new Set([...BASE_SECRETS, ...cfg.workers.flatMap(w => w.secretsFromGitHub)]);
  // wrangler runs in this job: any secret other than the Cloudflare pair belongs in the after job (see the workflow)
  const extra = [...SECRET_NAMES].filter(k => !CF_PAIR.includes(k) && String(E[k] || ""));
  if (extra.length) say(`::warning::the deploy job has secrets it does not need (${extra.join(", ")}): wrangler runs here, so keep them in the after job`);
  // manual inputs that name Workers (keys or names, comma separated)
  const named = (v, what) => {
    const s = String(v || "").trim(), out = new Set();
    if (!s || /^(false|0)$/i.test(s)) return out;
    if (/^(true|1)$/i.test(s)) { say(`::warning::${what} names Workers now (for example ${what}=og); "${s}" applies to no Worker`); return out; }
    for (const x of s.split(",").map(y => y.trim()).filter(Boolean)) {
      const w = cfg.workers.find(w2 => w2.key === x || w2.name === x);
      if (w) out.add(w.key); else say(`::warning::unknown Worker "${x.slice(0, 40)}" in ${what}`);
    }
    return out;
  };
  const ctx = { cfg, mode, sha: git(["rev-parse", "HEAD"]).out.trim(), before: E.BEFORE, explicit: new Set(), kv: { id: null, listed: false, wouldCreate: null },
    force: dispatch ? named(E.FORCE_CODE, "force_code") : new Set(), skipPre: dispatch ? named(E.SKIP_PRECHECK, "skip_precheck") : new Set() };
  ctx.main = mainTip();
  if (!ctx.main && mode === "on") { mode = ctx.mode = "dry"; say("::notice::where main is now is unknown (origin/main could not be read): planning only"); }
  Object.assign(res, { sha: ctx.sha, mode });
  const spec = dispatch ? String(E.WORKERS || "changed").trim() : "changed";
  let list, changedOnly = false;
  if (spec === "changed" || spec === "all") { list = cfg.workers.filter(w => w.deploy === "main"); changedOnly = spec === "changed"; }
  else {
    list = [];
    for (const x of spec.split(",").map(s => s.trim()).filter(Boolean)) {
      const w = cfg.workers.find(w2 => w2.key === x || w2.name === x);
      if (w) { if (!list.includes(w)) list.push(w); ctx.explicit.add(w.key); } else say(`::warning::unknown Worker "${x.slice(0, 40)}" in the workers input`);
    }
  }
  // a Worker that may create the KV namespace runs before the ones that only read it (uptime before mail and reviews)
  const mayCreate = w => { try { return w.create && fs.readFileSync(path.join(IO.root, w.dir, "wrangler.toml"), "utf8").includes(`"${cfg.kv.placeholder}"`) ? 1 : 0; } catch { return 0; } };
  list = list.map((w, i) => [w, i]).sort((a, b) => mayCreate(b[0]) - mayCreate(a[0]) || a[1] - b[1]).map(x => x[0]);
  say(`Workers deploy: mode ${mode}, ${changedOnly ? "changed Workers among " : ""}${list.map(w => w.key).join(", ") || "none"} at ${ctx.sha.slice(0, 7)}${ctx.main && ctx.main !== ctx.sha ? ` (main is at ${ctx.main.slice(0, 7)})` : ""}`);
  for (const w of list) {
    const r = await one(ctx, w, changedOnly);
    if (r.kvCreate && r.action === "planned") ctx.kv.wouldCreate = w.name;   // only a creator that passed every check counts (dry = on)
    res.workers.push(r);
    say(`${w.name}: ${r.action}${r.reasons.length ? " (" + r.reasons.join("; ") + ")" : ""}`);
  }
  finish(res);
  return 0;
}

// after job: secrets for deployed Workers, then the alerts. Fresh runner: no npm code runs next to these secrets.
async function putSecrets(ctx, w, R) {
  const names = w.secretsFromGitHub.filter(n => (R.secretsMissing || []).includes(n)), codeVer = R.version;
  let put = 0;
  for (const n of names) {
    const v = String(IO.env[n] || "");
    if (!v) { R.warnings.push(`secret ${n}: empty on GitHub (or not passed to the after job), not put`); continue; }
    const s = await cf("PUT", `${acct()}/workers/scripts/${w.name}/secrets`, { name: n, text: v, type: "secret_text" });
    if (s.ok) { put++; R.plan.push(`secret ${n} put`); }
    else { R.warnings.push(`secret ${n} could not be put (HTTP ${s.status})`); R.he.push(`הקוד עלה, אבל הוספת הסוד ${n} נכשלה. להדביק אותו ידנית בלוח הבקרה.`); R.secretFailed = true; }
  }
  if (put) {
    // a secret makes a new version with the same code: it gets the same verification, and goes back to the checked version on failure
    const want = await newestVersion(w);
    if (!want || !(await activeIs(w, want))) return recover(ctx, w, R, codeVer, "הגרסה עם הסוד לא פעילה ב-100%");
    await IO.sleep(T.settle);
    const why = await probe(ctx, w, want, T.probePasses);
    if (why) return recover(ctx, w, R, codeVer, why);
    R.version = want;
  }
  if (R.secretFailed) R.action = "failed";
}
export async function after() {
  const E = IO.env;
  let res = null;
  try { res = JSON.parse(E.RESULT || "null"); } catch {}
  // the workflow starts this job only after a deploy job in mode on, so a missing result (an output GitHub dropped) must not pass quietly
  if (!res || !Array.isArray(res.workers)) { say("::error::the deploy job's result did not arrive: no alert could be sent, see the deploy job's summary"); return 1; }
  if (res.mode !== "on") return 0;   // dry, off or skipped: nothing to put, nothing to send
  const tok = cleanToken(E.CLOUDFLARE_API_TOKEN);
  if (!tok.value || tok.bad || !/^[0-9a-f]{32}$/i.test(E.CF_ACCOUNT_ID || "")) { say("::error::the after job has no usable Cloudflare credentials"); return 1; }
  E.CLOUDFLARE_API_TOKEN = tok.value;
  const cfg = loadConfig();
  SECRET_NAMES = new Set([...BASE_SECRETS, ...cfg.workers.flatMap(w => w.secretsFromGitHub)]);
  const ctx = { cfg, mode: "on", sha: isSha(res.sha) ? res.sha : git(["rev-parse", "HEAD"]).out.trim() };
  // the deploy job's result is data: Worker names and secret names come from this checkout's config, never from the result
  const workers = [];
  for (const r of res.workers) {
    const w = cfg.workers.find(x => x.key === r.key && x.name === r.name);
    if (!w) continue;
    Object.assign(r, { reasons: r.reasons || [], he: r.he || [], plan: r.plan || [], warnings: r.warnings || [] });
    if (["deployed", "created"].includes(r.action) && (r.secretsMissing || []).length) await putSecrets(ctx, w, r);
    workers.push(r);
  }
  res.workers = workers;
  // alerts: Cloudflare unreadable for several Workers is one cause, so one alert
  const unread = workers.filter(r => r.action === "refused" && r.unreadable), grouped = unread.length >= 2, list = [];
  if (grouped) list.push(["day", "workers:refused:cloudflare-read",
    `⚠️ לוחית: הפריסה של ${unread.map(r => r.name).join(", ")} נעצרה\n• ${readHe(unread[0].unreadable)}\nשום דבר לא השתנה ב-Cloudflare.`]);
  for (const r of workers) {
    if (!(grouped && r.action === "refused" && r.unreadable)) { const a = alertFor(r); if (a) list.push(a); }
    if (r.forced && ["deployed", "created"].includes(r.action)) list.push(["day", `workers:forced:${r.name}`,
      `⚠️ לוחית: הקוד החי של ${r.name} הוחלף בקוד מ-git (force_code)\nהקוד שהיה שם לא היה ב-main (${r.forced}). הוא עדיין שמור ב-Cloudflare, בגרסאות הקודמות של ה-Worker.`]);
  }
  let undelivered = 0;
  for (const a of list) if (!(await tell(...a))) { undelivered++; say(`::warning::the alert ${a[1]} was not delivered`); }
  // a Worker that is fine again closes its open items (they would otherwise stay open for up to 26 h)
  const fine = workers.filter(r => ["deployed", "created", "unchanged"].includes(r.action) && !r.forced).map(r => r.name);
  const rt = await router();
  if (fine.length && rt?.resolve) {
    try { await rt.resolve([...fine.flatMap(n => [`workers:refused:${n}`, `workers:rollback:${n}`, `workers:failed:${n}`]), ...(unread.length ? [] : ["workers:refused:cloudflare-read"])]); } catch {}
  }
  say(`Workers deploy after: ${workers.map(r => `${r.name} ${r.action}`).join(", ") || "nothing"}; ${list.length} alert(s)${undelivered ? `, ${undelivered} not delivered` : ""}`);
  finish(res, " (after)");
  return undelivered ? 1 : 0;
}

// ---- selftest (offline) ----
// Everything runs on fixtures in a temp git repo: the real config and Worker files change for normal reasons (a cron, a version label,
// a Worker switched on), and the problems of a real deploy:main Worker are refusals of main() itself, so the self-test never reads them.
const FIX_TOML = {
  uptime: 'name = "luchit-uptime"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\ncompatibility_flags = ["global_fetch_strictly_public"]   # a comment\n' +
    'workers_dev = true\nkeep_vars = true\n[observability]\nenabled = false\n[triggers]\ncrons = ["*/10 * * * *"]\n[[kv_namespaces]]\nbinding = "ALERTS"\n' +
    'id = "KV_NAMESPACE_ID"   # filled in by title\n[version_metadata]\nbinding = "CF_VERSION_METADATA"\n',
  og: 'name = "luchit-og"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nkeep_vars = true\nroutes = [{ pattern = "luchit.app/*", zone_name = "luchit.app" }]\n' +
    '[version_metadata]\nbinding = "CF_VERSION_METADATA"\n',
  api: 'name = "luchit-api"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nroutes = [{ pattern = "luchit.app/api/*", zone_name = "luchit.app" }]\nkeep_vars = true\n' +
    '# dashboard variables only\n[version_metadata]\nbinding = "CF_VERSION_METADATA"\n',
  mail: 'name = "luchit-mail"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nkeep_vars = true\n[vars]\nFORWARD_TO = "owner@example.invalid"\n' +
    '[[kv_namespaces]]\nbinding = "ALERTS"\nid = "KV_NAMESPACE_ID"\n',
  reviews: 'name = "luchit-reviews"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nworkers_dev = true\nkeep_vars = true\npreview_urls = false\n' +
    '[observability]\nenabled = false\n[triggers]\ncrons = ["*/30 * * * *"]\n[[kv_namespaces]]\nbinding = "ALERTS"\nid = "KV_NAMESPACE_ID"\n',
  live: 'name = "luchit-live"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nroutes = [{ pattern = "luchit.app/live*", zone_name = "luchit.app" }]\nkeep_vars = true\n' +
    '[vars]\nGA_PROPERTY_ID = "1"\n',
  proxy: 'name = "luchit-proxy"\nmain = "worker.js"\ncompatibility_date = "2026-10-01"\nworkers_dev = true\n[observability]\nenabled = false\n',
};
const FIX_CODE = k => `// luchit-${k} (self-test fixture)\nexport default {\n  async fetch(req, env) {\n    return new Response("${k}");\n  },\n};\n`;
const FIX_CONFIG = {
  about: "self-test fixture", zone: "luchit.app", kv: { title: "luchit-alerts", placeholder: "KV_NAMESPACE_ID" },
  workers: [
    { key: "uptime", dir: "worker/uptime", name: "luchit-uptime", deploy: "main", create: true, probe: { kind: "health", path: "/health", version: true }, secretsFromGitHub: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] },
    { key: "og", dir: "worker/og", name: "luchit-og", deploy: "main", create: false, probe: { kind: "http", checks: [
      { url: "https://luchit.app/?st={nonce}", ua: "browser", status: 200, contains: ['id="plate"'] },
      { url: "https://luchit.app/?cmp=W3t9LHt9XQ&st={nonce}", ua: "TelegramBot (like TwitterBot)", status: 200, contains: ["og:title", "השוואת 2 רכבים בלוחית"], version: true },
      { url: "https://luchit.app/magazine/?st={nonce}", ua: "browser", status: 200, contains: ['id="nl"'] },
      { url: "https://luchit.app/.well-known/assetlinks.json?st={nonce}", ua: "luchit-ship-tail/1", status: 200, contains: ["com.ddsabag.pratirechev"] },
      { url: "https://luchit.app/?st={nonce}", method: "HEAD", ua: "browser", status: 200 }] }, secretsFromGitHub: [] },
    { key: "api", dir: "worker/api", name: "luchit-api", deploy: "main", create: false, probe: { kind: "http", checks: [
      { url: "https://luchit.app/api/confirm?e=x&x=1&t=x", ua: "luchit-ship-tail/1", status: 302, location: "subscribed=expired", version: true }] }, secretsFromGitHub: [] },
    { key: "mail", dir: "worker/mail", name: "luchit-mail", deploy: "main", create: false, probe: { kind: "version" }, secretsFromGitHub: [] },
    { key: "reviews", dir: "worker/reviews", name: "luchit-reviews", deploy: "off", create: true, probe: { kind: "health", path: "/health", readOnly: false }, secretsFromGitHub: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "REVIEWS_SA_JSON"] },
    { key: "live", dir: "worker/live", name: "luchit-live", deploy: "off", create: false, probe: { kind: "version" }, secretsFromGitHub: [] },
    { key: "proxy", dir: "worker", name: "luchit-proxy", deploy: "off", create: false, probe: { kind: "version" }, secretsFromGitHub: [] },
  ],
};
async function selftest() {
  const keep = { ...IO }, keepT = { ...T };
  let n = 0, bad = 0;
  const ok = (c, m) => { n++; if (!c) { bad++; process.stdout.write("FAIL " + m + "\n"); } };
  Object.assign(T, { probeGap: 1, depGap: 1, fetchMs: 5000, settle: 1 });
  const ACC = "0123456789abcdef0123456789abcdef", TOKEN = "cf-token-SECRET-1234567890", TG = "tg-bot-SECRET-0987654321", CHAT = "4242424242", BREVO = "brevo-SECRET-5555";
  const SA = '{\n  "type": "service_account",\n  "private_key": "-----BEGIN PRIVATE KEY-----\\nSECRETKEYMATERIAL1234567890\\n-----END PRIVATE KEY-----\\n"\n}';
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ship-tail-selftest-"));
  const G = (cwd, ...a) => spawnSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  try {
    // TOML parser on every fixture, and the temp toml
    for (const [k, src] of Object.entries(FIX_TOML)) {
      let t = null;
      try { t = parseToml(src); } catch (e) { ok(false, `parse fixture ${k}: ${e.message}`); continue; }
      ok(t.name === `luchit-${k}` && t.main === "worker.js" && /^\d{4}-\d\d-\d\d$/.test(t.compatibility_date), "toml basics " + k);
    }
    const up = parseToml(FIX_TOML.uptime);
    ok(up.triggers.crons[0] === "*/10 * * * *" && up.kv_namespaces[0].binding === "ALERTS" && up.workers_dev === true && up.observability.enabled === false &&
      up.compatibility_flags[0] === "global_fetch_strictly_public" && up.version_metadata.binding === "CF_VERSION_METADATA", "toml tables, arrays of tables, comments after values");
    const ogt = parseToml(FIX_TOML.og);
    ok(ogt.routes[0].pattern === "luchit.app/*" && ogt.routes[0].zone_name === "luchit.app" && ogt.keep_vars === true, "toml inline route table");
    ok(declared(ogt).bindings.some(b => b.type === "version_metadata" && b.name === "CF_VERSION_METADATA") && declared(ogt).workersDev === false, "declared: version_metadata binding, no workers.dev with a route");
    ok(JSON.stringify(parseToml('a = [\n  "x", # c\n  "y",\n]\n[[t]]\nk = { p = "q", r = true }\n[[t]]\nk = 2')) === '{"a":["x","y"],"t":[{"k":{"p":"q","r":true}},{"k":2}]}', "toml multi-line arrays and arrays of tables");
    for (const b of ['a = 1\na = 2', 'a = "x', "[t]\nb = 1\n[t]", 'a = """x"""']) { let thrown = false; try { parseToml(b); } catch { thrown = true; } ok(thrown, "toml rejects " + JSON.stringify(b)); }
    const tt = tempToml('name = "x"\nkeep_vars = true\nmain = "worker.js"\n[vars]\nkeep_vars = "a var, not the setting"\n[[kv_namespaces]]\nbinding = "ALERTS"\nid = "KV_NAMESPACE_ID"\n', "KV_NAMESPACE_ID", "f".repeat(32));
    const tp = parseToml(tt);
    ok(tp.keep_vars === true && tp.no_bundle === true && tp.vars.keep_vars === "a var, not the setting" && tp.kv_namespaces[0].id === "f".repeat(32), "temp toml: forced keys once, var kept, KV id in");
    ok(parseMultipart('--B\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\nexport default {};\r\n--B--\r\n', "multipart/form-data; boundary=B")[0].body === "export default {};", "multipart parser");
    const BUNDLED = "var __defProp = Object.defineProperty;\nvar __name = (target, value) => __defProp(target, \"name\", { value, configurable: true });\n\n// worker.js\nvar worker_default = {\n  async fetch(req) { return fetch(req); }\n};\nexport {\n  worker_default as default\n};\n";
    ok(looksBundled(BUNDLED, "dash") && looksBundled("// worker.js\nvar w = {};\nexport { w as default };", null) && !looksBundled(FIX_CODE("og"), "wrangler") && !looksBundled("export { w as default };", "dash"), "bundled-code detection");
    for (const [cfgBad, m] of [[{ probe: { kind: "http", checks: [{ url: "https://x", status: 200, method: "POST" }] } }, "method"], [{ probe: { kind: "health", readOnly: "no" } }, "readOnly"],
      [{ probe: { kind: "http", checks: [{ url: "http://x", status: 200 }] } }, "url"]]) {
      const R9 = path.join(tmpRoot, "cfg-" + m);
      fs.mkdirSync(path.join(R9, ".github"), { recursive: true });
      fs.writeFileSync(path.join(R9, ".github/ship-tail.json"), JSON.stringify({ ...FIX_CONFIG, workers: [{ ...FIX_CONFIG.workers[1], ...cfgBad }] }));
      let thrown = false;
      try { loadConfig(R9); } catch { thrown = true; }
      ok(thrown, "config rejects a bad probe " + m);
    }

    // a temp repo from the fixtures, with an older og in history; origin/main = its main
    const R0 = path.join(tmpRoot, "repo");
    fs.mkdirSync(R0);
    G(R0, "init", "-q", "-b", "main");
    const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(R0, f)), { recursive: true }); fs.writeFileSync(path.join(R0, f), s); };
    put(".github/ship-tail.json", JSON.stringify(FIX_CONFIG, null, 2));
    for (const k of ["og", "api", "mail", "uptime", "reviews", "live"]) { put(`worker/${k}/worker.js`, FIX_CODE(k)); put(`worker/${k}/wrangler.toml`, FIX_TOML[k]); }
    put("worker/worker.js", FIX_CODE("proxy")); put("worker/wrangler.toml", FIX_TOML.proxy);
    const OG = FIX_CODE("og"), OG_OLD = "// older og\n" + OG;
    put("worker/og/worker.js", OG_OLD);
    G(R0, "add", "-A"); G(R0, "commit", "-qm", "one");
    const C1 = G(R0, "rev-parse", "HEAD").stdout.trim();
    put("worker/og/worker.js", OG);
    G(R0, "add", "-A"); G(R0, "commit", "-qm", "two");
    const C2 = G(R0, "rev-parse", "HEAD").stdout.trim();
    G(R0, "update-ref", "refs/remotes/origin/main", C2);
    const file = f => fs.readFileSync(path.join(R0, f), "utf8");

    // the mocked account: scripts as the dashboard left them
    const routeOf = { "luchit-og": ["luchit.app/*"], "luchit-api": ["luchit.app/api/*"] };
    function account(o = {}) {
      const S = {}, vid = { n: 0 };
      const mk = (name, code, extra = {}) => {
        const v = { id: `v-${name}-${++vid.n}`, number: 1, message: extra.message ?? null, code, meta: false };
        S[name] = { versions: [v], active: [{ version_id: v.id, percentage: 100 }], routes: [...(routeOf[name] || [])], domains: [], crons: [], secrets: [],
          sub: { enabled: !routeOf[name], previews_enabled: !routeOf[name] }, settings: { bindings: [], compatibility_date: "2026-10-01", compatibility_flags: [] }, ...extra };
      };
      mk("luchit-og", OG_OLD); mk("luchit-api", file("worker/api/worker.js"), { settings: { compatibility_date: "2026-10-01", compatibility_flags: [],
        bindings: [{ type: "plain_text", name: "BREVO_LIST_ID", text: "7" }, { type: "plain_text", name: "NOTIFY_TO", text: "owner" }, { type: "secret_text", name: "BREVO_KEY" }] }, secrets: ["BREVO_KEY"] });
      mk("luchit-mail", file("worker/mail/worker.js"), { settings: { compatibility_date: "2026-10-01", compatibility_flags: [], bindings: [{ type: "plain_text", name: "FORWARD_TO", text: parseToml(file("worker/mail/wrangler.toml")).vars.FORWARD_TO }] },
        secrets: ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"] });
      mk("luchit-live", file("worker/live/worker.js"));
      for (const n2 of o.make || []) mk(n2, file(`worker/${n2.replace("luchit-", "")}/worker.js`), { sub: { enabled: true, previews_enabled: false } });
      const st = { S, kv: [...(o.kv || [])], calls: [], deploys: [], secretPuts: [], dryRuns: [], tg: [], probes: 0, bad: new Set(o.bad || []), rollbackErr: o.rollbackErr || 0, lag: {}, lagFrom: {}, goodLeft: {}, ...o.state };
      (o.tweak || (() => {}))(S);
      const J = (result, status = 200, extra = {}) => new Response(JSON.stringify({ success: status < 400, errors: status < 400 ? [] : [{ code: extra.code || 10000 }], result, ...extra.info && { result_info: extra.info } }), { status, headers: { "content-type": "application/json" } });
      st.fetch = async (u, init = {}) => {
        const method = init.method || "GET";
        if (u.startsWith(CF_API)) {
          const p = u.slice(CF_API.length);
          st.calls.push(method + " " + p);
          if (init.headers?.authorization !== "Bearer " + TOKEN) return J(null, 403);
          if ((o.deny || []).some(d => p.includes(d))) return J(null, 403, { code: 10000 });
          if ((o.down || []).some(d => p.includes(d))) return J(null, 503);
          if (p === "/zones?name=luchit.app") return J([{ id: "z1", name: "luchit.app" }]);
          if (p === "/zones/z1/workers/routes") return J([...Object.entries(S).flatMap(([s, x]) => x.routes.map(pattern => ({ id: s + pattern, pattern, script: s }))), ...(o.otherRoutes || [])]);
          const a = `/accounts/${ACC}`;
          if (p === `${a}/workers/subdomain`) return o.noSub ? J(null, 404, { code: 10007 }) : J({ subdomain: "acct" });
          if (p.startsWith(`${a}/storage/kv/namespaces`)) {
            if (method === "POST") { const id = "k".repeat(32); st.kv.push({ id, title: JSON.parse(init.body).title }); return J({ id, title: JSON.parse(init.body).title }); }
            return J(st.kv, 200, { info: { page: 1, total_pages: 1 } });
          }
          if (p.startsWith(`${a}/workers/domains`)) return J(Object.entries(S).flatMap(([s, x]) => x.domains.map(hostname => ({ hostname, service: s }))));
          let m = /^\/accounts\/[0-9a-f]+\/workers\/(?:services|scripts)\/([a-z0-9-]+)(.*)$/.exec(p);
          if (!m) return J(null, 404);
          const [, name, rest] = m, x = S[name];
          if (!x) return J(null, 404, { code: 10007 });
          if (rest === "") return J({ default_environment: { environment: "production", script: { last_deployed_from: x.versions.length > 1 ? "wrangler" : "dash" } } });
          if (rest === "/settings") return J(x.settings);
          if (rest === "/environments/production/routes?show_zonename=true") return J(x.routes.map(pattern => ({ id: pattern, pattern, zone_name: "luchit.app" })));
          if (rest === "/schedules") return J({ schedules: x.crons.map(cron => ({ cron })) });
          if (rest === "/subdomain") return J(x.sub);
          if (rest === "/secrets" && method === "PUT") {   // the secrets API: a new version with the same code, made active
            const b = JSON.parse(init.body), pv = x.versions.find(v2 => v2.id === x.active[0].version_id);
            st.secretPuts.push({ worker: name, name: b.name, text: b.text, type: b.type });
            if (o.secretFail) return J(null, 400, { code: 10000 });
            const v = { ...pv, id: `v-${name}-s${x.versions.length}`, number: x.versions.length + 1, message: null, trigger: "secret", bad: !!o.secretBad };
            x.secrets.push(b.name); x.versions.push(v); x.active = [{ version_id: v.id, percentage: 100 }]; x.depAnn = { "workers/triggered_by": "secret" };
            return J({ name: b.name, type: "secret_text" });
          }
          if (rest === "/secrets") return J(x.secrets.map(n2 => ({ name: n2, type: "secret_text" })));
          if (rest === "/environments/production/content/v2") {
            const v = x.versions.find(v2 => v2.id === x.active[0].version_id);
            if (o.rawCode) return new Response(v.code, { status: 200, headers: { "content-type": "application/javascript" } });
            return new Response(`--XB\r\nContent-Disposition: form-data; name="worker.js"; filename="worker.js"\r\nContent-Type: application/javascript+module\r\n\r\n${v.code.replace(/\n/g, "\r\n")}\r\n--XB--\r\n`,
              { status: 200, headers: { "content-type": "multipart/form-data; boundary=XB", "cf-entrypoint": "worker.js" } });
          }
          if (rest === "/deployments" && method === "GET" && st.depFailLeft > 0) { st.depFailLeft--; return J(null, 503); }
          if (rest === "/deployments" && method === "GET") return J({ deployments: [{ id: "d" + x.versions.length, versions: x.active, annotations: x.depAnn || {} }] });
          if (rest.startsWith("/deployments") && method === "POST") {
            const b = JSON.parse(init.body);
            if (st.rollbackErr && !rest.includes("force=true")) { st.rollbackErr--; return J(null, 400, { code: 10220 }); }
            x.active = b.versions; x.depAnn = b.annotations;
            if (/^ship-tail verified /.test(b.annotations?.["workers/message"] || "")) st.marks = (st.marks || 0) + 1; else st.rollbacks = (st.rollbacks || 0) + 1;
            return J({ id: "dr" });
          }
          const ann = v => ({ ...(v.message ? { "workers/message": v.message } : {}), ...(v.trigger ? { "workers/triggered_by": v.trigger } : {}) });
          if (rest === "/versions?deployable=true") return J({ items: [...x.versions].reverse().map(v => ({ id: v.id, number: v.number, annotations: ann(v) })) });
          m = /^\/versions\/(.+)$/.exec(rest);
          if (m) { const v = x.versions.find(v2 => v2.id === m[1]); return v ? J({ id: v.id, number: v.number, annotations: ann(v) }) : J(null, 404); }
          return J(null, 404);
        }
        if (u.startsWith("https://api.telegram.org/")) { st.tg.push(JSON.parse(init.body)); return new Response("{}", { status: 200 }); }
        // the live site and workers.dev: answers come from the active version of the Worker behind them (a "bad" version breaks);
        // edge lag (o.lag): right after a deploy the next answers still come from the version that was active before it
        st.probes++;
        const live = name => {
          const x = S[name];
          if (!x) return null;
          if (st.lag[name] > 0) { st.lag[name]--; return x.versions.find(v => v.id === st.lagFrom[name]) || null; }
          return x.versions.find(v => v.id === x.active[0].version_id);
        };
        const U = new URL(u), M = init.method || "GET";
        const hdr = (v, h = {}) => ({ ...h, ...(v.meta ? { "x-luchit-version": v.id } : {}) });   // a version with [version_metadata] names itself
        const broken = (v, p) => {
          if (v?.bad && st.goodLeft[v.id] > 0) { st.goodLeft[v.id]--; return false; }   // o.goodFirst: a bad version that answers well a few times first
          return !v || v.bad || (v.badPaths || []).includes(p) || (v.badPaths || []).includes(M + " " + p);
        };
        if (U.host.endsWith(".acct.workers.dev")) {
          const v = live(U.host.split(".")[0]);
          if (broken(v, U.pathname)) return new Response("err", { status: 500 });
          return new Response(JSON.stringify({ v: "x" }), { status: 200, headers: hdr(v) });
        }
        if (U.pathname.startsWith("/api/")) { const v = live("luchit-api"); return broken(v, U.pathname) ? new Response("x", { status: 500 }) : new Response(null, { status: 302, headers: hdr(v, { location: "https://luchit.app/magazine/?subscribed=expired" }) }); }
        const v = live("luchit-og");
        if (broken(v, U.pathname)) return new Response("broken", { status: 502 });
        if (M === "HEAD") return new Response(null, { status: 200 });
        if (U.pathname === "/.well-known/assetlinks.json") return new Response('[{"target":{"package_name":"com.ddsabag.pratirechev"}}]', { status: 200 });
        if (U.pathname === "/magazine/") return new Response('<div id="nl"></div>', { status: 200 });
        const tg = /TelegramBot/.test(init.headers?.["user-agent"] || "") && U.searchParams.get("cmp");   // og rewrites (and names its version) only for crawlers
        return new Response(`<meta property="og:title" content="${tg ? "השוואת 2 רכבים בלוחית" : "לוחית"}"><input id="plate">`, { status: 200, headers: tg ? hdr(v) : {} });
      };
      // wrangler: dry runs copy the entry to --outdir; deploys add a version and make it active; it never puts secrets
      st.run = (args, opt) => {
        const cfgPath = args[args.indexOf("--config") + 1], t = parseToml(fs.readFileSync(cfgPath, "utf8")), name = args.includes("--name") ? args[args.indexOf("--name") + 1] : t.name;
        ok(!Object.values(opt.env).some(v => [TG, CHAT, SA, BREVO, "ghs_SECRETSECRETSECRET"].includes(v)) && !opt.input, "wrangler never sees a Telegram, GitHub, Brevo or service-account secret");
        if (args[0] === "deploy" && args.includes("--dry-run")) {
          st.dryRuns.push(name);
          ok(!opt.env.CLOUDFLARE_API_TOKEN && !opt.env.TELEGRAM_BOT_TOKEN, "dry run gets no credentials");
          const out = args[args.indexOf("--outdir") + 1];
          fs.mkdirSync(out, { recursive: true });
          fs.copyFileSync(path.join(path.dirname(cfgPath), t.main), path.join(out, t.main));
          return { code: (o.dryFail || []).includes(name) ? 1 : 0, out: "dry run ok" };
        }
        ok(opt.env.CLOUDFLARE_API_TOKEN === TOKEN && opt.env.CLOUDFLARE_ACCOUNT_ID === ACC, "wrangler write gets the Cloudflare credentials");
        if (args[0] === "deploy") {
          st.deploys.push({ name, toml: fs.readFileSync(cfgPath, "utf8"), message: args[args.indexOf("--message") + 1] });
          if ((o.deployFail || []).includes(name)) { st.depFailLeft = o.depReadFail || 0; return { code: 1, out: "✘ [ERROR] A request to the Cloudflare API failed. token " + TOKEN }; }
          const code = fs.readFileSync(path.join(path.dirname(cfgPath), t.main), "utf8");
          if (!S[name]) { S[name] = { versions: [], active: [], routes: [], domains: [], crons: [], secrets: [], sub: {}, settings: { bindings: [] } }; }
          const x = S[name], before = x.active[0]?.version_id, v = { id: `v-${name}-new${x.versions.length}`, number: x.versions.length + 1, message: args[args.indexOf("--message") + 1], code,
            bad: st.bad.has(name), meta: !!t.version_metadata, badPaths: (o.badPaths || {})[name] || [] };
          if (o.lag && before) { st.lag[name] = o.lag; st.lagFrom[name] = before; }
          if (o.goodFirst) st.goodLeft[v.id] = o.goodFirst;
          x.versions.push(v); x.active = [{ version_id: v.id, percentage: 100 }]; x.depAnn = {};
          x.crons = t.triggers?.crons || x.crons;
          x.settings.bindings = [...x.settings.bindings.filter(b => VAR_TYPES.has(b.type) || SECRET_TYPES.has(b.type)), ...(t.kv_namespaces || []).map(k => ({ type: "kv_namespace", name: k.binding, namespace_id: k.id })),
            ...(t.version_metadata ? [{ type: "version_metadata", name: t.version_metadata.binding }] : [])];
          fs.writeFileSync(opt.env.WRANGLER_OUTPUT_FILE_PATH, JSON.stringify({ type: "deploy", version: 1, version_id: v.id }) + "\n");
          return { code: 0, out: `Uploaded ${name}\nCurrent Version ID: ${v.id}` };
        }
        ok(false, "wrangler called with " + args.slice(0, 2).join(" "));
        return { code: 1, out: "unknown" };
      };
      return st;
    }
    // one workflow run: the deploy job (the Cloudflare pair and the run's context only), then the after job (a fresh runner with the
    // Telegram, GitHub and Brevo secrets and the deploy job's "result" output)
    const LATE = { TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: CHAT, REVIEWS_SA_JSON: SA, GITHUB_TOKEN: "ghs_SECRETSECRETSECRET", BREVO_API_KEY: BREVO };
    const runWith = async (o = {}) => {
      const st = account(o), out = [], alerts = [], resolved = [];
      const files = { sum: path.join(tmpRoot, "sum.md"), res: path.join(tmpRoot, "res.json"), gout: path.join(tmpRoot, "gout.txt") };
      for (const f of Object.values(files)) fs.rmSync(f, { force: true });
      const setEnv = e => { IO.env = e; for (const [k, v] of Object.entries(IO.env)) if (v === undefined) delete IO.env[k]; };
      const base = { CLOUDFLARE_API_TOKEN: TOKEN, CF_ACCOUNT_ID: ACC, EVENT: "workflow_dispatch", MODE: "on", WORKERS: "all", RUN_URL: "https://github.com/o/r/actions/runs/1",
        GITHUB_STEP_SUMMARY: files.sum, RESULT_FILE: files.res, GITHUB_OUTPUT: files.gout, PATH: process.env.PATH, ...o.env };
      Object.assign(IO, { root: o.root || R0, fetch: st.fetch, run: st.run, sleep: async () => {}, out: s => out.push(s),
        router: o.router === null ? null : { alert: async (level, key, text, link, opts) => { alerts.push({ level, key, text, link, opts }); return { delivered: o.undelivered ? false : true, action: "loud" }; },
          resolve: async p => { resolved.push(...p); return 0; } } });
      const rd = f => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
      setEnv({ ...base, ...o.deployEnv });
      let c1, c2;
      try { c1 = await main(); } catch (e) { c1 = "crash " + e.stack; }
      const a1 = alerts.length, p1 = st.secretPuts.length, tg1 = st.tg.length, out1 = out.length, gout1 = rd(files.gout);
      setEnv({ ...base, ...LATE, ...o.lateEnv, RESULT: /^result=(.*)$/m.exec(gout1)?.[1] || "" });
      try { c2 = await after(); } catch (e) { c2 = "crash " + e.stack; }
      const res = rd(files.res) ? JSON.parse(rd(files.res)) : null;
      return { code: c1 || c2, c1, c2, a1, p1, tg1, out1, gout1, st, out, alerts, resolved, res, sum: rd(files.sum), gout: rd(files.gout), w: k => res?.workers.find(x => x.key === k || x.name === k) };
    };
    const writes = st => st.calls.filter(c => !c.startsWith("GET "));
    const noSecrets = (r, m) => {
      const all = [r.out.join("\n"), r.sum, r.gout, JSON.stringify(r.res), r.alerts.map(a => a.text).join("\n")].join("\n");
      ok(![TOKEN, TG, CHAT, "SECRETKEYMATERIAL1234567890", "ghs_SECRETSECRETSECRET", ACC, BREVO].some(s => all.includes(s)), "no secret value in any output: " + m);
    };
    const KVE = [{ id: "e".repeat(32), title: "luchit-alerts" }], PUSH = { EVENT: "push", MODE: undefined, WORKERS: undefined };
    // a version this script deployed from sha and checked (the "ship-tail verified" deployment marker)
    const shipped = (x, sha) => { x.versions[x.versions.length - 1].message = sha; x.depAnn = { "workers/message": "ship-tail verified " + sha }; };
    const activeCode = (st, name) => { const x = st.S[name]; return x.versions.find(v => v.id === x.active[0].version_id).code; };
    const keys = r2 => r2.alerts.map(a => a.level + " " + a.key);

    // kill switch and missing secrets
    let r = await runWith({ env: { SHIP_TAIL: "off" } });
    ok(r.code === 0 && r.st.calls.length === 0 && r.out.length === 1 && /SHIP_TAIL=off/.test(r.out[0]) && r.res.outcome === "off", "SHIP_TAIL=off: one line, no calls");
    r = await runWith({ env: { CLOUDFLARE_API_TOKEN: undefined } });
    ok(r.code === 0 && r.out.length === 1 && r.out[0].startsWith("::notice::") && r.st.calls.length === 0 && r.alerts.length === 0 && r.res.outcome === "skipped" && !r.sum, "missing token: one notice, green, nothing else");
    r = await runWith({ env: { CF_ACCOUNT_ID: "" } });
    ok(r.code === 0 && r.out.length === 1 && r.st.calls.length === 0, "missing account id: green skip");
    // a token pasted with direction marks, a space and a line break: every call and wrangler get the clean token, one notice says so
    r = await runWith({ env: { MODE: "dry", CLOUDFLARE_API_TOKEN: "\u200f " + TOKEN + "\u200e\r\n" } });
    ok(r.code === 0 && r.res.mode === "dry" && r.w("og").action === "planned" && r.w("api").action === "planned" && r.st.dryRuns.length === 4 &&
      r.out.filter(l => /^::notice::CLOUDFLARE_API_TOKEN: dropped 5 invisible/.test(l)).length === 1, "pasted token with invisible marks: cleaned " + r.out.slice(0, 3));
    noSecrets(r, "cleaned token");
    r = await runWith({ env: { MODE: "dry", CLOUDFLARE_API_TOKEN: "Bearer: " + TOKEN } });
    ok(r.c1 === 1 && r.st.calls.length === 0 && r.st.dryRuns.length === 0 && /::error::CLOUDFLARE_API_TOKEN has 1 character\(s\) no Cloudflare/.test(r.out.join("\n")), "token with a character no token has: stops before any call " + r.out);
    noSecrets(r, "bad token");
    r = await runWith({ env: { MODE: "dry", CLOUDFLARE_API_TOKEN: `curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \\\n     -H "Authorization: Bearer ${TOKEN}"\n` } });
    ok(r.code === 0 && r.w("og").action === "planned" && r.st.dryRuns.length === 4 && r.out.filter(l => /^::notice::CLOUDFLARE_API_TOKEN holds Cloudflare's test command/.test(l)).length === 1,
      "the whole test command pasted: the token after Bearer is used " + r.out.slice(0, 2));
    noSecrets(r, "test command pasted");
    r = await runWith({ env: { MODE: "dry", CLOUDFLARE_API_TOKEN: `-H "Authorization: Bearer ${TOKEN}" -H "Authorization: Bearer ${TOKEN}x"` } });
    ok(r.c1 === 1 && r.st.calls.length === 0, "two Bearer tokens in the paste: no guessing, stops");
    r = await runWith({ env: { MODE: "dry", CLOUDFLARE_API_TOKEN: " \u200f\n" } });
    ok(r.c1 === 1 && r.st.calls.length === 0 && /is only spaces or invisible marks/.test(r.out.join("\n")), "token of invisible marks only: stops " + r.out);
    { const f = IO.fetch, m = [];
      for (const thrown of [Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }), new TypeError("Cannot convert argument to a ByteString: " + TOKEN)]) {
        IO.fetch = async () => { throw thrown; };
        try { need(await cf("GET", "/x"), "the Worker"); } catch (e) { m.push(e.message); }
      }
      IO.fetch = f;
      ok(m.join(" / ") === "the Worker: no answer (ECONNRESET) / the Worker: no answer (TypeError)" && /תו שאי אפשר לשלוח/.test(readHe(m[1])) && /תקלה זמנית/.test(readHe(m[0])),
        "no answer names the network error, never its message: " + m.join(" / ")); }

    // dry mode, every main Worker: reads only, plan in the summary, no alerts, uptime planned before mail, KV planned by uptime
    r = await runWith({ env: { MODE: "dry" } });
    ok(r.code === 0 && writes(r.st).length === 0 && r.st.deploys.length === 0 && r.st.secretPuts.length === 0 && r.alerts.length === 0 && r.st.tg.length === 0, "dry: no writes, no alerts " + writes(r.st));
    ok(r.res.mode === "dry" && r.res.workers.map(w => w.key).join() === "uptime,og,api,mail", "dry: uptime first " + r.res.workers.map(w => w.key));
    ok(r.w("uptime").action === "planned" && r.w("uptime").plan.includes("create KV namespace luchit-alerts") && r.w("uptime").plan.some(p => /put secret TELEGRAM_BOT_TOKEN/.test(p)), "dry: uptime plan " + JSON.stringify(r.w("uptime")));
    ok(r.w("mail").action === "planned" && r.w("mail").plan.some(p => /created in this run by luchit-uptime/.test(p)) && r.w("mail").plan.includes("add binding ALERTS (kv_namespace)"), "dry: mail uses the KV uptime creates " + JSON.stringify(r.w("mail").plan));
    ok(r.w("og").action === "planned" && r.w("og").plan.includes(`code: update (live = worker/og/worker.js at ${C1.slice(0, 7)})`) && r.w("og").plan.includes("add binding CF_VERSION_METADATA (version_metadata)"), "dry: og live code found in history " + JSON.stringify(r.w("og").plan));
    ok(r.w("api").plan.includes("code: unchanged (live = the file at HEAD)") && /vars: BREVO_LIST_ID, NOTIFY_TO; secrets: BREVO_KEY/.test(r.w("api").state) && !/"7"|owner/.test(r.w("api").state), "dry: api live line has names, no values " + r.w("api").state);
    ok(/- live: version v-luchit .*routes: luchit\.app\/\*; crons: none; workers\.dev off, previews off/.test(r.sum), "dry: live line in the summary");
    ok(r.w("api").action === "planned" && r.st.dryRuns.length === 4, "dry: api passes with dashboard vars kept; four wrangler dry runs");
    ok(/## Workers deploy: dry/.test(r.sum) && /\| luchit-og \| planned \|/.test(r.sum) && /<details><summary>luchit-mail: planned/.test(r.sum), "dry: job summary table and plan");
    ok(/^result=\{.*\}\noutcome=planned\nmode=dry\n$/.test(r.gout), "dry: step outputs");
    noSecrets(r, "dry");
    // SHIP_TAIL=dry wins over mode=on; an unknown value plans only; another branch plans only; unknown origin/main plans only
    r = await runWith({ env: { SHIP_TAIL: "dry", WORKERS: "og" } });
    ok(r.res.mode === "dry" && writes(r.st).length === 0 && r.st.deploys.length === 0, "SHIP_TAIL=dry wins over mode on");
    r = await runWith({ env: { GITHUB_ACTIONS: "true", GITHUB_REF: "refs/heads/next", WORKERS: "og" } });
    ok(r.res.mode === "dry" && r.st.deploys.length === 0 && writes(r.st).length === 0, "a manual run on another branch plans only");
    r = await runWith({ env: { SHIP_TAIL: "maybe", EVENT: "push", WORKERS: undefined } });
    ok(r.res.mode === "dry" && r.st.deploys.length === 0 && r.out.some(l => /not off, dry or on/.test(l)), "unknown SHIP_TAIL plans only");
    const R7 = path.join(tmpRoot, "repo7");
    fs.cpSync(R0, R7, { recursive: true });
    G(R7, "update-ref", "-d", "refs/remotes/origin/main");
    r = await runWith({ root: R7, env: { WORKERS: "og" } });
    ok(r.res.mode === "dry" && r.st.deploys.length === 0 && r.out.some(l => /origin\/main could not be read/.test(l)), "origin/main unknown: plans only");

    // mode on, all: uptime created first with the KV, then og, api, mail; secrets by the after job through the API; quiet success
    r = await runWith({});
    ok(r.code === 0 && r.res.workers.map(w => w.key + ":" + w.action).join() === "uptime:created,og:deployed,api:deployed,mail:deployed", "on: all deployed " + JSON.stringify(r.res.workers.map(w => [w.key, w.action, w.reasons])));
    ok(r.st.deploys.map(d => d.name).join() === "luchit-uptime,luchit-og,luchit-api,luchit-mail", "on: uptime deploys before mail");
    const R3 = path.join(tmpRoot, "repo3");   // the same with mail listed first in the config: uptime still runs first
    fs.cpSync(R0, R3, { recursive: true });
    const c3 = JSON.parse(fs.readFileSync(path.join(R3, ".github/ship-tail.json"), "utf8"));
    c3.workers.sort((x, y) => (y.key === "mail") - (x.key === "mail"));
    fs.writeFileSync(path.join(R3, ".github/ship-tail.json"), JSON.stringify(c3));
    let r3 = await runWith({ root: R3, env: { WORKERS: "mail,og,uptime" } });
    ok(r3.st.deploys.map(d => d.name).join() === "luchit-uptime,luchit-mail,luchit-og" && r3.w("mail").action === "deployed", "order: uptime first even when listed last " + r3.st.deploys.map(d => d.name));
    ok(writes(r.st).filter(c => c.includes("storage/kv")).length === 1 && r.st.kv.length === 1, "on: the KV namespace is created once");
    ok(r.st.deploys.every(d => /^no_bundle = true$/m.test(d.toml) && /^keep_vars = true$/m.test(d.toml) && d.message === C2 && !d.toml.includes('"KV_NAMESPACE_ID"')), "on: temp toml forced keys, message = sha, no placeholder");
    ok(r.st.deploys.find(d => d.name === "luchit-mail").toml.includes(`id = "${"k".repeat(32)}"`), "on: mail gets the KV id uptime created");
    ok(r.p1 === 0 && r.st.secretPuts.map(s => s.name).join() === "TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID" && r.st.secretPuts[0].text === TG && r.st.secretPuts.every(s => s.worker === "luchit-uptime" && s.type === "secret_text"),
      "on: secrets put once each by the after job, through the API");
    ok(r.a1 === 0 && r.alerts.length === 0 && r.st.tg.length === 0, "on: success is quiet");
    ok(r.st.marks === 4 && ["luchit-uptime", "luchit-og", "luchit-api", "luchit-mail"].every(nm => r.resolved.includes(`workers:refused:${nm}`)), "on: each checked version is marked verified; open items are closed " + r.st.marks);
    ok(r.w("uptime").probe === "ok" && r.w("og").probe === "ok" && r.w("mail").probe === "ok" && r.w("uptime").version === r.st.S["luchit-uptime"].active[0].version_id && /-s\d+$/.test(r.w("uptime").version), "on: probes ok, uptime's version is the secret's version");
    ok(r.res.outcome === "created" && r.res.sha === C2 && /outcome=created/.test(r.gout), "on: result file and outputs");
    noSecrets(r, "on (wrangler echoed a secret)");
    r = await runWith({ deployEnv: { TELEGRAM_BOT_TOKEN: TG }, env: { WORKERS: "api" } });
    ok(r.out.some(l => /::warning::the deploy job has secrets it does not need \(TELEGRAM_BOT_TOKEN\)/.test(l)) && r.w("api").action === "deployed", "a secret in the deploy job's env is called out (and still kept from wrangler)");

    // guards: each refuses only its Worker, the others deploy
    const guardCase = async (m, tweak, key, re, extra = {}) => {
      const g = await runWith({ tweak, ...extra });
      const w = g.w(key);
      ok(w && w.action === "refused" && w.reasons.some(x => re.test(x)), `guard ${m}: ${w && JSON.stringify(w.reasons)}`);
      ok(!g.st.deploys.some(d => d.name === (w && w.name)), `guard ${m}: nothing deployed for it`);
      ok(g.res.workers.filter(x => x.key !== key && x.action !== "refused").every(x => ["deployed", "created"].includes(x.action)), `guard ${m}: the others continue ` + JSON.stringify(g.res.workers.map(x => [x.key, x.action])));
      const a = g.alerts.filter(x => x.key === `workers:refused:${w?.name}`);
      ok(a.length === 1 && a[0].level === "day" && a[0].text.includes("נעצרה") && !/—/.test(a[0].text) && a[0].text.includes("https://github.com/o/r/actions/runs/1"), `guard ${m}: one day alert`);
      noSecrets(g, "guard " + m);
      return g;
    };
    await guardCase("binding dropped", S => S["luchit-api"].settings.bindings.push({ type: "send_email", name: "MAIL", destination_address: "x@example.invalid" }), "api", /live binding MAIL \(send_email\)/);
    await guardCase("KV target differs", S => S["luchit-mail"].settings.bindings.push({ type: "kv_namespace", name: "ALERTS", namespace_id: "other" }), "mail", /binding ALERTS .* points elsewhere/, { state: {}, kv: [{ id: "a".repeat(32), title: "luchit-alerts" }] });
    await guardCase("route not declared", S => S["luchit-api"].routes.push("www.luchit.app/api/*"), "api", /live route www\.luchit\.app\/api\/\* is not in/);
    await guardCase("cron not declared", S => S["luchit-og"].crons.push("0 3 * * *"), "og", /live cron "0 3 \* \* \*"/);
    await guardCase("custom domain not declared", S => S["luchit-mail"].domains.push("mail.luchit.app"), "mail", /custom domain mail\.luchit\.app/);
    await guardCase("workers.dev mismatch", S => { S["luchit-og"].sub = { enabled: true, previews_enabled: false }; }, "og", /workers\.dev is on live, the deploy would turn it off/);
    await guardCase("preview URLs mismatch", S => { S["luchit-mail"].sub = { enabled: true, previews_enabled: false }; }, "mail", /preview URLs are off live/);
    await guardCase("var differs", S => { S["luchit-mail"].settings.bindings[0].text = "someone@example.invalid"; }, "mail", /var FORWARD_TO differs/);
    await guardCase("var over secret", S => { S["luchit-mail"].settings.bindings = [{ type: "secret_text", name: "FORWARD_TO" }]; }, "mail", /would replace the live secret/);
    await guardCase("compat flag dropped", S => { S["luchit-api"].settings.compatibility_flags = ["nodejs_compat"]; }, "api", /compatibility flag nodejs_compat/);
    await guardCase("Workers Logs dropped", S => { S["luchit-og"].settings.observability = { enabled: true }; }, "og", /Workers Logs/);
    await guardCase("dashboard code edit", S => { S["luchit-og"].versions[0].code = OG + "\n// edited in the dashboard\n"; }, "og", /edited in the dashboard/);
    await guardCase("gradual deployment", S => { S["luchit-api"].active = [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }]; }, "api", /gradual deployment/);
    await guardCase("check fails before the deploy", S => { S["luchit-og"].versions[0].bad = true; }, "og", /already fails on the live version: luchit\.app\/ ענה 502/);
    await guardCase("route owned by another Worker", () => {}, "api", /route luchit\.app\/api\/\* belongs to luchit-other/, { tweak: S => { S["luchit-api"].routes = []; }, otherRoutes: [{ pattern: "luchit.app/api/*", script: "luchit-other" }] });
    await guardCase("missing script, create false", S => { delete S["luchit-api"]; }, "api", /does not exist and create is false/);
    const gu = await guardCase("live state unreadable", () => {}, "mail", /live state unreadable: settings: HTTP 403/, { deny: ["/luchit-mail/settings"] });
    ok(/חסרה הרשאה/.test(gu.alerts[0].text), "unreadable 403: the alert names the token permission");
    // the code guard accepts CRLF and trailing newlines, and force_code=<key> overrides a dashboard edit
    r = await runWith({ rawCode: true, tweak: S => { S["luchit-og"].versions[0].code = OG.replace(/\n/g, "\r\n") + "\r\n\r\n"; }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "deployed", "code guard: CRLF and trailing newlines normalised (raw script body)");
    r = await runWith({ tweak: S => { S["luchit-og"].versions[0].code = "export default {}"; }, env: { WORKERS: "og", FORCE_CODE: "og" } });
    ok(r.w("og").action === "deployed" && r.w("og").warnings.some(x => /force_code/.test(x)), "force_code=og replaces a dashboard edit");
    // toml-side guards on a copy of the repo
    const R1 = path.join(tmpRoot, "repo1");
    fs.cpSync(R0, R1, { recursive: true });
    fs.writeFileSync(path.join(R1, "worker/api/wrangler.toml"), file("worker/api/wrangler.toml").replace("[version_metadata]", '[vars]\nBREVO_LIST_ID = ""\n[version_metadata]'));
    fs.writeFileSync(path.join(R1, "worker/og/worker.js"), 'import x from "./x.js";\n' + OG);
    fs.writeFileSync(path.join(R1, "worker/mail/wrangler.toml"), file("worker/mail/wrangler.toml").replace('name = "luchit-mail"', 'name = "luchit-mail2"'));
    r = await runWith({ root: R1 });
    ok(r.w("api").action === "refused" && r.w("api").reasons.some(x => /empty var BREVO_LIST_ID/.test(x)), "guard empty var " + JSON.stringify(r.w("api").reasons));
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /static import/.test(x)), "guard static import");
    ok(r.w("mail").action === "refused" && r.w("mail").reasons.some(x => /names "luchit-mail2"/.test(x)), "guard toml name differs from the config");
    ok(r.w("uptime").action === "created" && r.alerts.length === 3 && r.alerts.every(a => a.level === "day"), "toml guards: three day alerts, uptime still created");
    fs.writeFileSync(path.join(R1, "worker/api/wrangler.toml"), file("worker/api/wrangler.toml").replace(/\[version_metadata\][^\n]*\n[^\n]*\n/, ""));
    r = await runWith({ root: R1, env: { WORKERS: "api" } });
    ok(r.w("api").action === "refused" && r.w("api").reasons.some(x => /no \[version_metadata\] binding/.test(x)), "a version check without [version_metadata] is refused, not rolled back forever " + JSON.stringify(r.w("api").reasons));
    r = await runWith({ dryFail: ["luchit-api"], env: { WORKERS: "api" } });
    ok(r.w("api").action === "refused" && r.w("api").reasons.some(x => /dry-run failed/.test(x)), "guard wrangler dry run");
    // KV: missing for a Worker that only reads it; an existing namespace is resolved, never created
    r = await runWith({ env: { WORKERS: "mail" } });
    ok(r.w("mail").action === "refused" && r.w("mail").reasons.some(x => /KV namespace luchit-alerts does not exist/.test(x)) && r.st.kv.length === 0, "KV missing: mail refused, nothing created");
    r = await runWith({ kv: [{ id: "e".repeat(32), title: "luchit-alerts" }] });
    ok(r.st.kv.length === 1 && !writes(r.st).some(c => c.includes("storage/kv")) && r.st.deploys.filter(d => d.toml.includes(`id = "${"e".repeat(32)}"`)).length === 2, "KV resolved by title for uptime and mail, not created");
    r = await runWith({ noSub: true, env: { WORKERS: "uptime" } });
    ok(r.w("uptime").action === "refused" && r.w("uptime").reasons.some(x => /no workers\.dev subdomain/.test(x)), "no workers.dev subdomain: uptime refused");

    // rollback: og's new version fails its probe; the previous version comes back and passes; one loud alert
    r = await runWith({ bad: ["luchit-og"], env: { WORKERS: "og" } });
    const prevOg = r.st.S["luchit-og"].versions[0].id;
    ok(r.w("og").action === "rolled-back" && r.st.S["luchit-og"].active[0].version_id === prevOg && r.st.rollbacks === 1 && r.w("og").version === prevOg && !r.st.marks, "rollback: previous version active again, nothing marked verified " + JSON.stringify(r.w("og")));
    ok(r.alerts.length === 1 && r.alerts[0].level === "critical" && r.alerts[0].key === "workers:rollback:luchit-og" && /הוחזרה לגרסה הקודמת/.test(r.alerts[0].text) && /הבדיקה עוברת שוב/.test(r.alerts[0].text) && /ענה 502/.test(r.alerts[0].text), "rollback: one loud alert " + r.alerts.map(a => a.text));
    ok(r.code === 0 && r.res.outcome === "rolled-back" && r.a1 === 0, "rollback: green run, outcome rolled-back, the alert from the after job");
    noSecrets(r, "rollback");
    r = await runWith({ bad: ["luchit-api"], rollbackErr: 1, env: { WORKERS: "api" } });
    ok(r.w("api").action === "rolled-back" && writes(r.st).some(c => c.includes("/deployments?force=true")), "rollback retries with force after a secrets-changed refusal");
    r = await runWith({ bad: ["luchit-uptime"], env: { WORKERS: "uptime" } });
    ok(r.w("uptime").action === "failed" && r.alerts.length === 1 && r.alerts[0].level === "critical" && /אין גרסה קודמת/.test(r.alerts[0].text) && r.st.secretPuts.length === 0, "new Worker failing its probe: no rollback, no secrets, loud alert");
    // secrets in the after job: a put that fails is a day alert; a secret version that fails its check goes back to the checked code version
    r = await runWith({ secretFail: true, env: { WORKERS: "uptime" } });
    ok(r.w("uptime").action === "failed" && keys(r).join() === "day workers:failed:luchit-uptime" && /הוספת הסוד TELEGRAM_BOT_TOKEN נכשלה/.test(r.alerts[0].text), "secret put failure: day alert " + keys(r));
    r = await runWith({ secretBad: true, kv: KVE, env: { WORKERS: "uptime" } });
    const upCode = r.st.S["luchit-uptime"].versions.find(v => /-new/.test(v.id)).id;
    ok(r.w("uptime").action === "rolled-back" && r.st.S["luchit-uptime"].active[0].version_id === upCode && keys(r).join() === "critical workers:rollback:luchit-uptime", "secret version failing its check: back to the checked code version " + JSON.stringify([r.w("uptime").action, keys(r)]));
    // a failed deploy that changed nothing: one day alert; an undelivered alert turns the run red
    r = await runWith({ deployFail: ["luchit-api"], env: { WORKERS: "api" } });
    ok(r.w("api").action === "failed" && r.alerts.length === 1 && r.alerts[0].key === "workers:failed:luchit-api" && r.alerts[0].level === "day", "wrangler failure: day alert");
    noSecrets(r, "wrangler error output with the token");
    r = await runWith({ bad: ["luchit-og"], env: { WORKERS: "og" }, undelivered: true });
    ok(r.code === 1 && r.c1 === 0 && r.c2 === 1, "undelivered alert: the after job exits 1 so failure-alert speaks");
    // without the router module, the legacy Telegram send carries the alert
    r = await runWith({ router: null, env: { WORKERS: "api" }, tweak: S => S["luchit-api"].routes.push("x.luchit.app/*") });
    ok(r.st.tg.length === 1 && r.tg1 === 0 && r.st.tg[0].chat_id === CHAT && /נעצרה/.test(r.st.tg[0].text), "no router: legacy Telegram send, from the after job");
    // the real router accepts the keys and has labels for them
    const rtr = await import("./alert.mjs");
    for (const k of ["workers:refused:luchit-og", "workers:rollback:luchit-api", "workers:failed:luchit-uptime", "workers:forced:luchit-og", "workers:refused:cloudflare-read"])
      ok(rtr.validKey(k) && !rtr.label(k).he.startsWith("התראה:"), "router key and label " + k);
    ok(["workers:refused", "workers:rollback", "workers:failed", "workers:forced"].every(f => rtr.FAMILIES_IN_USE.includes(f)), "router families listed");

    // workers=changed (push): Worker deployed from HEAD and checked stays put; the script being missing counts as changed
    r = await runWith({ env: PUSH, tweak: S => { for (const s of ["luchit-og", "luchit-api", "luchit-mail"]) shipped(S[s], C2); S["luchit-og"].versions[0].code = OG; } });
    ok(r.w("og").action === "unchanged" && r.w("api").action === "unchanged" && r.w("mail").action === "unchanged" && r.w("uptime").action === "created", "changed: deployed from HEAD = unchanged, missing = created " + JSON.stringify(r.res.workers.map(x => [x.key, x.action, x.changed])));
    r = await runWith({ env: { ...PUSH, BEFORE: C1 }, kv: KVE, tweak: S => { shipped(S["luchit-api"], C1); delete S["luchit-uptime"]; } });
    ok(r.w("og").action === "deployed" && /this push|not the file at HEAD/.test(r.w("og").changed) && r.w("api").action === "unchanged" && r.w("mail").action === "unchanged", "changed: by hand-deployed code and by sha " + JSON.stringify(r.res.workers.map(x => [x.key, x.action, x.changed])));
    r = await runWith({ bad: ["luchit-og"], env: { WORKERS: "og" } });
    const after1 = r.st.S;
    r = await runWith({ env: PUSH, kv: KVE, tweak: S => { S["luchit-og"] = after1["luchit-og"]; for (const s of ["luchit-api", "luchit-mail"]) shipped(S[s], C2); } });
    ok(r.w("og").action === "unchanged" && /rolled back from/.test(r.w("og").state), "changed: a sha that was rolled back is not retried while its files stay the same " + JSON.stringify(r.w("og")));
    const R2 = path.join(tmpRoot, "repo2");
    fs.cpSync(R0, R2, { recursive: true });
    fs.writeFileSync(path.join(R2, "worker/og/worker.js"), OG + "// fixed\n");
    G(R2, "commit", "-qam", "three");
    for (const v of after1["luchit-og"].versions) v.bad = false;
    r = await runWith({ root: R2, env: PUSH, kv: KVE, tweak: S => { S["luchit-og"] = after1["luchit-og"]; for (const s of ["luchit-api", "luchit-mail"]) shipped(S[s], C2); } });
    ok(r.w("og").action === "deployed" && /files changed since/.test(r.w("og").changed), "changed: a new commit after a rollback deploys again " + JSON.stringify(r.w("og")));
    r = await runWith({ env: { WORKERS: "uptime" } });
    const upS = r.st.S["luchit-uptime"];
    r = await runWith({ env: PUSH, kv: [{ id: "k".repeat(32), title: "luchit-alerts" }], tweak: S => { S["luchit-uptime"] = upS; for (const s of ["luchit-og", "luchit-api", "luchit-mail"]) shipped(S[s], C2); S["luchit-og"].versions[0].code = OG; } });
    ok(r.w("uptime").action === "unchanged" && /from [0-9a-f]{7}/.test(r.w("uptime").state) && !/never checked|chosen by hand/.test(r.w("uptime").state), "changed: after secret versions the deploy sha is still found " + JSON.stringify(r.w("uptime")));
    // deploy off: a Worker named in mode on is never deployed; in dry mode it can be planned
    r = await runWith({ env: { WORKERS: "live,reviews" } });
    ok(r.res.workers.every(w => w.action === "off") && r.st.deploys.length === 0 && r.st.calls.length === 0, "deploy off: never deployed");
    r = await runWith({ env: { WORKERS: "reviews", MODE: "dry" } });
    ok(r.w("reviews").action === "planned" && r.w("reviews").plan.some(p => /put secret REVIEWS_SA_JSON/.test(p)) && writes(r.st).length === 0 && r.st.secretPuts.length === 0, "deploy off: dry plan for reviews");
    noSecrets(r, "reviews plan");

    // ===== red-team regressions: each of these failed before its fix =====
    // H1: a rollback made by hand in the dashboard is never undone by a push
    const handRollback = (ann = { "workers/triggered_by": "rollback" }, sha = C1, code = OG_OLD) => S => {
      const og = S["luchit-og"]; og.versions[0].message = sha; og.versions[0].code = code;
      og.versions.push({ id: "v-luchit-og-2", number: 2, message: C2, code: OG });
      og.depAnn = ann; shipped(S["luchit-api"], C2); shipped(S["luchit-mail"], C2);
    };
    r = await runWith({ env: PUSH, kv: KVE, tweak: handRollback() });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /chosen by hand/.test(x)) && !r.st.deploys.some(d => d.name === "luchit-og") && activeCode(r.st, "luchit-og") === OG_OLD,
      "H1 hand rollback: a push refuses og and leaves the rolled-back version " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    ok(keys(r).filter(k => k === "day workers:refused:luchit-og").length === 1 && r.alerts.find(a => a.key === "workers:refused:luchit-og")?.text.includes("workers=og"), "H1 hand rollback: one day alert naming the manual rerun " + keys(r));
    r = await runWith({ env: PUSH, kv: KVE, tweak: handRollback({}) });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /chosen by hand/.test(x)), "H1 an older version made active by hand (no annotation) is refused too " + JSON.stringify(r.w("og").reasons));
    r = await runWith({ env: { WORKERS: "all" }, kv: KVE, tweak: handRollback() });
    ok(r.w("og").action === "refused", "H1 workers=all does not replace a hand rollback either");
    r = await runWith({ env: { WORKERS: "og" }, kv: KVE, tweak: handRollback() });
    ok(r.w("og").action === "deployed" && activeCode(r.st, "luchit-og") === OG && r.w("og").warnings.some(x => /chosen by hand/.test(x)), "H1 a manual run naming og replaces it " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    r = await runWith({ env: PUSH, kv: KVE, tweak: handRollback(undefined, C2, OG) });
    ok(r.w("og").action === "unchanged" && r.alerts.length === 0 && r.st.deploys.every(d => d.name === "luchit-uptime"), "H1 a hand rollback to the files of HEAD stays quiet " + JSON.stringify([r.w("og").action, r.w("og").changed, keys(r)]));
    // H2: re-running an older run never deploys older files over newer ones
    const R4 = path.join(tmpRoot, "repo4");
    fs.cpSync(R0, R4, { recursive: true });
    G(R4, "checkout", "-q", C1); G(R4, "update-ref", "refs/remotes/origin/main", C2);
    r = await runWith({ root: R4, env: PUSH, kv: KVE, tweak: S => { S["luchit-og"].versions[0].code = OG; for (const s of ["luchit-og", "luchit-api", "luchit-mail"]) shipped(S[s], C2); } });
    ok(r.w("og").action === "superseded" && !r.st.deploys.some(d => d.name === "luchit-og") && activeCode(r.st, "luchit-og") === OG && r.alerts.length === 0, "H2 re-run of an older run: og skipped quietly, the newer code stays " + JSON.stringify([r.w("og").action, r.w("og").reasons, r.w("og").changed]));
    ok(r.w("api").action === "unchanged" && r.w("mail").action === "unchanged", "H2 Workers whose files main did not change are still compared normally");
    G(R4, "update-ref", "refs/remotes/origin/main", C1);
    r = await runWith({ root: R4, env: PUSH, kv: KVE, tweak: S => { S["luchit-og"].versions[0].code = OG; for (const s of ["luchit-og", "luchit-api", "luchit-mail"]) shipped(S[s], C2); } });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /newer than this run/.test(x)) && activeCode(r.st, "luchit-og") === OG, "H2 live from a commit this run does not contain: refused " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    const R8 = path.join(tmpRoot, "repo8");   // push A (og) running while push B (unrelated files) is already main: A still deploys
    fs.cpSync(R0, R8, { recursive: true });
    fs.writeFileSync(path.join(R8, "README.md"), "b\n");
    G(R8, "add", "-A"); G(R8, "commit", "-qm", "b"); G(R8, "update-ref", "refs/remotes/origin/main", "HEAD"); G(R8, "checkout", "-q", C2);
    r = await runWith({ root: R8, env: { WORKERS: "og" } });
    ok(r.w("og").action === "deployed", "H2 main moved on with other files only: this run still deploys " + r.w("og").action);
    // H5: the http check knows which version answered, covers more than "/", and needs two passes in a row
    r = await runWith({ bad: ["luchit-og"], lag: 2, env: { WORKERS: "og" } });
    ok(r.w("og").action === "rolled-back" && r.st.S["luchit-og"].active[0].version_id === r.st.S["luchit-og"].versions[0].id, "H5 edge lag: answers from the old version do not pass a bad new one " + JSON.stringify([r.w("og").action, r.w("og").probe]));
    r = await runWith({ lag: 3, env: { WORKERS: "og" } });
    ok(r.w("og").action === "deployed" && r.w("og").probe === "ok", "H5 edge lag with a good version: deployed once the new version answers " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    r = await runWith({ bad: ["luchit-og"], goodFirst: 5, env: { WORKERS: "og" } });
    ok(r.w("og").action === "rolled-back", "H5 one lucky round of a bad version is not enough: two in a row " + JSON.stringify([r.w("og").action, r.w("og").why]));
    r = await runWith({ lag: 99, env: { WORKERS: "api" } });
    ok(r.w("api").action === "rolled-back" && /ולא החדשה/.test(r.w("api").why), "H5 a new version that never answers is not accepted " + JSON.stringify([r.w("api").action, r.w("api").why]));
    r = await runWith({ badPaths: { "luchit-og": ["/magazine/"] }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "rolled-back" && /magazine/.test(r.w("og").why || ""), "H5 a regression on /magazine/ rolls og back " + JSON.stringify([r.w("og").action, r.w("og").why]));
    r = await runWith({ badPaths: { "luchit-og": ["HEAD /"] }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "rolled-back" && /^HEAD /.test(r.w("og").why), "H5 a regression on HEAD / rolls og back " + r.w("og").why);
    // H6: force_code names the Workers it may overwrite, and says so in a day alert
    r = await runWith({ kv: KVE, env: { WORKERS: "changed", FORCE_CODE: "og" }, tweak: S => { S["luchit-og"].versions[0].code = BUNDLED; S["luchit-api"].versions[0].code = file("worker/api/worker.js") + "\n// hotfix typed in the dashboard\n"; } });
    ok(r.w("og").action === "deployed" && r.w("api").action === "refused" && activeCode(r.st, "luchit-api").includes("hotfix typed"), "H6 force_code=og forces og only " + JSON.stringify([r.w("og").action, r.w("api").action]));
    ok(keys(r).includes("day workers:forced:luchit-og") && keys(r).includes("day workers:refused:luchit-api") && !r.resolved.includes("workers:refused:luchit-og"), "H6 a forced replace sends a day alert " + keys(r));
    r = await runWith({ env: { WORKERS: "og", FORCE_CODE: "1" }, tweak: S => { S["luchit-og"].versions[0].code = "export default {}"; } });
    ok(r.w("og").action === "refused" && r.out.some(l => /force_code names Workers/.test(l)), "H6 the old boolean force_code forces nothing " + r.w("og").action);
    r = await runWith({ env: { WORKERS: "og", FORCE_CODE: "og", EVENT: "push" }, tweak: S => { S["luchit-og"].versions[0].code = "export default {}"; } });
    ok(r.w("og").action === "refused", "H6 force_code only exists in manual runs");
    // H7: code bundled by a plain wrangler deploy is called that, not a dashboard edit
    r = await runWith({ tweak: S => { S["luchit-og"].versions[0].code = BUNDLED; }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /bundled by wrangler/.test(x)) && !r.alerts[0]?.text.includes("מישהו ערך") && r.alerts[0]?.text.includes("force_code=og"), "H7 bundled live code " + JSON.stringify([r.w("og").reasons, r.alerts[0]?.text]));
    // H8: never create a Worker that has a route on the site
    const R6 = path.join(tmpRoot, "repo6");
    fs.cpSync(R0, R6, { recursive: true });
    const c6 = JSON.parse(fs.readFileSync(path.join(R6, ".github/ship-tail.json"), "utf8"));
    c6.workers.find(w => w.key === "og").create = true;
    fs.writeFileSync(path.join(R6, ".github/ship-tail.json"), JSON.stringify(c6));
    r = await runWith({ root: R6, bad: ["luchit-og"], tweak: S => { delete S["luchit-og"]; }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /create is only for Workers without routes/.test(x)) && !r.st.deploys.length, "H8 create with a route is refused " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    r = await runWith({ tweak: S => { delete S["luchit-og"]; }, env: { WORKERS: "og" } });
    ok(r.w("og").action === "refused" && !/create/.test(r.alerts[0]?.text || "create"), "H8 a missing routed Worker: no advice to mark create " + r.alerts[0]?.text);
    // H10: a failed wrangler deploy with a flaky read never posts a rollback
    r = await runWith({ deployFail: ["luchit-api"], depReadFail: 2, env: { WORKERS: "api" } });
    ok(r.w("api").action === "failed" && !writes(r.st).some(c => c.includes("/deployments")) && keys(r).join() === "day workers:failed:luchit-api", "H10 transient read after a failed deploy: no rollback " + JSON.stringify([r.w("api").action, writes(r.st), keys(r)]));
    r = await runWith({ deployFail: ["luchit-api"], depReadFail: 99, env: { WORKERS: "api" } });
    ok(r.w("api").action === "failed" && !writes(r.st).some(c => c.includes("/deployments")) && r.w("api").reasons.some(x => /could not be read/.test(x)), "H10 unreadable after a failed deploy: failed, live state unknown, no write " + JSON.stringify(r.w("api").reasons));
    // H11: the dry plan predicts mode on when the KV creator is refused
    r = await runWith({ dryFail: ["luchit-uptime"], env: { MODE: "dry" } });
    ok(r.w("uptime").action === "refused" && r.w("mail").action === "refused" && r.w("mail").reasons.some(x => /does not exist/.test(x)), "H11 dry: mail refused when uptime is " + JSON.stringify([r.w("mail").action, r.w("mail").plan]));
    // H12: live code from a branch other than main is not replaced silently
    const R5 = path.join(tmpRoot, "repo5");
    fs.cpSync(R0, R5, { recursive: true });
    G(R5, "checkout", "-q", "-b", "next");
    fs.writeFileSync(path.join(R5, "worker/og/worker.js"), OG + "// next-only fix\n");
    G(R5, "commit", "-qam", "next only");
    G(R5, "checkout", "-q", "main");
    r = await runWith({ root: R5, env: { WORKERS: "og" }, tweak: S => { S["luchit-og"].versions[0].code = OG + "// next-only fix\n"; } });
    ok(r.w("og").action === "refused" && r.w("og").reasons.some(x => /not on main/.test(x)), "H12 live from another branch " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    // H13: the deploy job holds only the Cloudflare pair; secrets are put and alerts sent by the after job
    r = await runWith({ tweak: S => S["luchit-api"].routes.push("x.luchit.app/*"), env: { WORKERS: "uptime,api" } });
    ok(r.c1 === 0 && r.a1 === 0 && r.p1 === 0 && r.tg1 === 0, `H13 deploy job: no alert and no secret put (it has no Telegram or GitHub secrets) ${r.c1} ${r.a1} ${r.p1}`);
    ok(r.c2 === 0 && keys(r).join() === "day workers:refused:luchit-api" && r.st.secretPuts.map(s => s.name).join() === "TELEGRAM_BOT_TOKEN,TELEGRAM_CHAT_ID" && r.st.secretPuts[0].text === TG,
      "H13 after job: puts uptime's secrets through the API and sends the alert " + JSON.stringify([r.c2, keys(r), r.st.secretPuts.map(s => s.name)]));
    {   // the after job takes Worker and secret names from its own config, never from the result it is handed
      const st = account({});
      Object.assign(IO, { root: R0, fetch: st.fetch, run: st.run, sleep: async () => {}, out: () => {}, router: { alert: async () => ({ delivered: true }), resolve: async () => 0 } });
      IO.env = { CLOUDFLARE_API_TOKEN: TOKEN, CF_ACCOUNT_ID: ACC, ...LATE, PATH: process.env.PATH, RESULT: JSON.stringify({ mode: "on", sha: C2, workers: [
        { key: "og", name: "luchit-og", action: "deployed", version: "x", secretsMissing: ["TELEGRAM_BOT_TOKEN"] }, { key: "evil", name: "luchit-evil", action: "created", secretsMissing: ["GITHUB_TOKEN"] }] }) };
      const c = await after();
      ok(c === 0 && st.secretPuts.length === 0, "H13 after job: a forged result puts no secret " + JSON.stringify(st.secretPuts.map(s => s.worker + ":" + s.name)));
      IO.env = { ...IO.env, RESULT: "" };
      ok(await after() === 1, "after job without a result: red, so failure-alert speaks");
    }
    // H14: one account-wide read failure is one alert, not one per Worker
    r = await runWith({ deny: ["/workers/domains"], kv: KVE, env: PUSH });
    ok(keys(r).join() === "day workers:refused:cloudflare-read" && /luchit-og/.test(r.alerts[0].text) && /luchit-mail/.test(r.alerts[0].text), "H14 one combined alert " + keys(r));
    r = await runWith({ down: ["/luchit-mail/settings"], env: { WORKERS: "mail" }, kv: KVE });
    ok(r.w("mail").action === "refused" && keys(r).join() === "day workers:refused:luchit-mail" && /תקלה זמנית/.test(r.alerts[0].text) && !/הרשאה/.test(r.alerts[0].text), "a 503 is called a Cloudflare outage, not a missing permission " + r.alerts[0]?.text);
    // H15: dry mode never opens a check that changes state (reviews /health installs the Telegram webhook)
    r = await runWith({ make: ["luchit-reviews"], env: { WORKERS: "reviews", MODE: "dry" } });
    ok(r.w("reviews").action === "planned" && r.st.probes === 0 && writes(r.st).length === 0 && r.w("reviews").plan.some(p => /not opened in dry mode/.test(p)), "H15 dry plan for reviews opens no URL " + JSON.stringify([r.w("reviews").action, r.st.probes]));
    // H16: a version deployed by a run that stopped before its check is checked again
    r = await runWith({ env: PUSH, kv: KVE, tweak: S => { for (const s of ["luchit-og", "luchit-api", "luchit-mail"]) shipped(S[s], C2); S["luchit-og"].versions[0].code = OG; S["luchit-og"].depAnn = {}; } });
    ok(r.w("og").action === "deployed" && /never checked/.test(r.w("og").changed) && r.st.marks >= 1 && r.w("api").action === "unchanged", "H16 unverified live version: deployed and checked again " + JSON.stringify([r.w("og").action, r.w("og").changed, r.st.marks]));
    // H17: skip_precheck lets a fix through when the live version already fails the check
    r = await runWith({ tweak: S => { S["luchit-og"].versions[0].bad = true; }, env: { WORKERS: "og", SKIP_PRECHECK: "og" } });
    ok(r.w("og").action === "deployed" && r.w("og").probe === "ok" && r.w("og").warnings.some(x => /skip_precheck/.test(x)), "H17 skip_precheck=og " + JSON.stringify([r.w("og").action, r.w("og").reasons]));
    r = await runWith({ tweak: S => { S["luchit-og"].versions[0].bad = true; }, env: { WORKERS: "og", SKIP_PRECHECK: "api" } });
    ok(r.w("og").action === "refused" && /skip_precheck=og/.test(r.alerts[0]?.text || ""), "H17 skip_precheck naming another Worker does not apply; the alert names the input");
  } finally {
    Object.assign(IO, keep); Object.assign(T, keepT);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
  process.stdout.write(bad ? `selftest: ${bad} of ${n} checks FAILED\n` : `selftest ok (${n} checks)\n`);
  return bad ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  let code = 1;
  try { code = process.argv.includes("--selftest") ? await selftest() : process.argv.includes("--after") ? await after() : await main(); }
  catch (e) { IO.out("::error::workers-deploy crashed: " + scrub(e?.stack || e)); code = 1; }
  process.exit(code);
}
