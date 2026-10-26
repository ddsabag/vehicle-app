// Ship tail, Play part (ship-tail.yml): uploads a release build of the Android app to Google Play's closed testing track "alpha" and sends
// it for review, as the Play Console does. Never any other track: promoting to production stays the owner's own click in Play Console.
// A build is a release only when Play holds no build of its versionName (APP_VERSION) and the newest build on Play is a known, lower version.
// When Play or GitHub does not answer clearly, nothing is uploaded (fail closed). Data-only rebuilds (bot commits) stand down quietly.
// A release that waits (release notes, SHIP_TAIL=dry, an error) is told by the build that changes APP_VERSION (or the notes), then again
// only when one of them changes or on a manual run: an Android build follows every data push and must not repeat the same Telegram.
// The files come from the Android build's draft release "build-<run number>", which is only read here (never deleted or published), and
// only when that build's commit is on main.
// Node 20, node: builtins only. Commands:
//   node play-alpha.mjs gate        SHIP_TAIL, EVENT, REF, INPUT_MODE, INPUT_STEP, RUN_CONCLUSION, RUN_BRANCH -> outputs mode (on|dry|off), play, ga4
//   node play-alpha.mjs             SHIP_SA_JSON, GITHUB_TOKEN, MODE (on|dry), BUILD (run number, empty = newest draft), EVENT, HEAD_SHA -> outputs result, tell
//   node play-alpha.mjs summary     PLAY_RESULT, GA4_RESULT, GA4_JOB -> ONE Telegram through alert.mjs (legacy: a direct send)
//   node play-alpha.mjs selftest    offline (mocked fetch, virtual clock, captured output)
// The result outputs are base64url JSON: the runner masks every line of a multi-line secret (a pretty-printed key has the lines "{" and "}")
// and drops any job output that contains one. Secrets (the key, the access token, the Telegram token) never reach stdout, outputs or the job summary.
import fs from "node:fs";
import crypto from "node:crypto";
import { msg, heError } from "./tg-text.mjs";

export const TRACK = "alpha";   // the only track this script may write; hard-coded on purpose, no input or variable can change it
export const NOTES_FILE = "android/release-notes.txt", NOTES_MAX = 500, NOTES_LANG = "iw-IL";   // Play counts characters, not bytes; iw-IL = Hebrew
export const PKG = "com.ddsabag.pratirechev";
export const SECRET = "SHIP_SA_JSON";   // a service account used by this workflow only (the GA and reviews keys run in jobs with pip packages)
export const WORKERS_WF = "Workers deploy", SMOKE_WF = "Site smoke test (after deploy)";
export const PERM = "Release apps to testing tracks", PERM_READ = "View app information and download bulk reports (read-only)";
export const BUDGET_MS = 20 * 60000;   // the Play step's own deadline; the job's timeout-minutes (30) leaves room for setup and cleanup
const PLAY = "https://androidpublisher.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const SHA40 = /^[0-9a-f]{40}$/;
// Telegram text (24.10 standard, tg-text.mjs): HTML, so every dynamic piece is escaped; a raw refusal or an English API answer becomes one
// Hebrew sentence and its raw text goes to the folded block
export const escH = t => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function whyHe(why) {
  const s = String(why || "");
  // refused: the script's own guard stopped a request it may not send, before it left the machine
  if (/^refused:/.test(s)) return { he: "הסקריפט עצר בעצמו בקשה שאסור לו לשלוח ל-Google Play (הגנה פנימית, לא תקלה בחשבון)", raw: s };
  if (/^(Google Play החזיר \d+:|תקלה בסקריפט:)/.test(s)) return { he: heError(s).split("\n<blockquote")[0].replace(/\.$/, ""), raw: s };
  return { he: escH(s), raw: "" };
}
const RERUN = b => `Actions ← Ship tail ← Run workflow עם step=play, mode=on${b ? `, build=${b}` : ""}`;

// injectable I/O: the selftest swaps these (mocked fetch, a virtual clock and sleep, captured stdout and step outputs)
const IO = {
  env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), deadline: 0, router: null,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
export const pack = o => Buffer.from(JSON.stringify(o)).toString("base64url");
export const unpack = s => { const t = String(s || "").trim(); return !t ? null : t.startsWith("{") ? J(t) : J(Buffer.from(t, "base64url").toString()); };
const repo = () => IO.env.GITHUB_REPOSITORY || "ddsabag/vehicle-app";
export const chars = s => [...String(s)].length;   // code points: a Hebrew letter is one character (and two bytes)
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
// why/next are the Hebrew text of the one Telegram; status is the HTTP status (0 = no answer, -1 = refused here); gone = a 404 on a draft file
export class Fail extends Error { constructor(why, next = "", status = 0) { super(why); this.why = why; this.next = next; this.status = status; } }

// ---- gate: the kill switch ----
// SHIP_TAIL (repository variable): off (or false/0/no/disabled) = nothing runs, dry = plan and validate only, unset or on = act; any other
// value counts as dry. A manual run brings its own mode, but never above the switch (dry stays dry, off stays off).
// Only main ships: a run started by hand on another branch would run that branch's copy of the scripts and could pick that branch's build.
const OFF = ["off", "false", "0", "no", "disable", "disabled"];
export function gate(env) {
  const v = String(env.SHIP_TAIL || "").trim().toLowerCase(), sw = !v || v === "on" ? "on" : OFF.includes(v) ? "off" : "dry";
  const ev = env.EVENT, step = env.INPUT_STEP || "all", notes = [];
  if (v && v !== "on" && v !== "dry" && !OFF.includes(v)) notes.push(`SHIP_TAIL is "${v.slice(0, 12)}", not on/off/dry: treated as dry`);
  let mode = sw, play = false, ga4 = false;
  if (sw === "off") notes.push("SHIP_TAIL is off: nothing runs");
  else if (env.REF !== "refs/heads/main") notes.push(`Ship tail runs from main only, this run is on ${String(env.REF || "?").replace(/^refs\/heads\//, "").replace(/[^\w./-]/g, "").slice(0, 40)}: nothing runs`);
  else if (ev === "workflow_run") play = env.RUN_CONCLUSION === "success" && env.RUN_BRANCH === "main";
  else if (ev === "push") ga4 = true;
  else if (ev === "workflow_dispatch") {
    mode = env.INPUT_MODE === "on" && sw === "on" ? "on" : "dry";
    if (env.INPUT_MODE === "on" && sw === "dry") notes.push("SHIP_TAIL is dry: this manual run stays dry");
    play = step === "play" || step === "all"; ga4 = step === "ga4" || step === "all";
  }
  return { mode, play, ga4, notes };
}

// ---- HTTP ----
// Google's retry rule: 5xx, 429 and network errors are tried up to 4 times, 2/4/8 s apart (a Retry-After up to 30 s is honoured).
// Any other status comes back at once, so a 4xx is explained, never retried. Every try and every wait fits inside IO.deadline, so the
// script always gets to report before the job's timeout; cleanup calls (dropping an edit, the after-commit look) get a short slot past it.
// once: a send that timed out may still have landed (Telegram), so it is not sent again.
async function call(method, url, { headers = {}, body, binary = false, redirect = "follow", timeout = 120000, cleanup = false, once = false } = {}) {
  for (let i = 0; ; i++) {
    const left = cleanup || !IO.deadline ? Infinity : IO.deadline - IO.now();
    if (left < 1000) return { status: 0, ok: false, text: "network: out of time" };
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), Math.min(cleanup ? 30000 : timeout, left));
    try {
      const r = await IO.fetch(url, { method, headers, body, redirect, signal: c.signal });
      res = { status: r.status, ok: r.ok, location: r.headers?.get?.("location") || "", retryAfter: +(r.headers?.get?.("retry-after") || 0) };
      if (binary && r.ok) res.buf = Buffer.from(await r.arrayBuffer()); else res.text = await r.text();
    } catch (e) {
      const aborted = e?.name === "AbortError";
      res = { status: 0, ok: false, aborted, text: "network: " + (aborted ? "timeout" : String(e?.message || e).slice(0, 80)) };
    } finally { clearTimeout(t); }
    if ((res.status && res.status < 500 && res.status !== 429) || i === (cleanup ? 1 : 3) || (once && res.aborted)) return res;
    const wait = res.retryAfter > 0 && res.retryAfter <= 30 ? res.retryAfter * 1000 : 2000 * 2 ** i;
    if (!cleanup && IO.deadline && IO.deadline - IO.now() < wait + 1000) return res;
    await IO.sleep(wait);
  }
}
// GitHub is only read here (GET by construction): the draft release keeps the build files for the release thread
async function gh(path, accept = "application/vnd.github+json", binary = false) {
  const H = { authorization: "Bearer " + IO.env.GITHUB_TOKEN, accept, "user-agent": "luchit-ship-tail", "x-github-api-version": "2022-11-28" };
  const r = await call("GET", `https://api.github.com/repos/${repo()}${path}`, { headers: H, binary, redirect: "manual" });
  // asset downloads answer with a redirect to storage that must not get the GitHub token
  if (r.status >= 300 && r.status < 400 && r.location) return call("GET", r.location, { headers: { accept, "user-agent": "luchit-ship-tail" }, binary });
  return r;
}

// ---- Google auth (service-account JWT, RS256, signed with node:crypto) ----
export function jwt(sa, scope, now = IO.now()) {
  const b64 = x => Buffer.from(x).toString("base64url"), iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  return `${head}.${claim}.${crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url")}`;
}
async function accessToken(sa) {
  let assertion;
  try { assertion = jwt(sa, SCOPE); } catch { throw new Fail(`המפתח בסוד ${SECRET} לא תקין`, `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בשלמותו בסוד ${SECRET}`); }
  const r = await call("POST", TOKEN_URL, { headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const t = r.ok && J(r.text)?.access_token;
  if (t) return t;
  if (r.status === 400 || r.status === 401) throw new Fail("Google לא קיבל את מפתח חשבון השירות (נמחק, בוטל או הודבק חלקית)", `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בסוד ${SECRET}`, r.status);
  throw new Fail(`ההתחברות ל-Google לא הצליחה (${r.status || "אין חיבור"})`, "להריץ שוב בעוד כמה דקות", r.status);
}

// ---- Play: the only calls this script can make ----
// Anything else (another track, a PATCH, a promotion, a dot segment or an encoded slash in the path) is refused before it leaves the machine,
// and a dry run cannot upload or commit even by mistake.
const APP = "/androidpublisher/v3/applications/[\\w.]+/edits";
const ALLOWED = [
  ["POST", new RegExp(`^${APP}$`)],                                       // edits.insert
  ["GET", new RegExp(`^${APP}/[\\w-]+/tracks$`)],                         // edits.tracks.list
  ["POST", new RegExp(`^/upload${APP}/[\\w-]+/bundles$`)],                // edits.bundles.upload
  ["PUT", new RegExp(`^${APP}/[\\w-]+/tracks/${TRACK}$`)],                // edits.tracks.update, alpha only
  ["POST", new RegExp(`^${APP}/[\\w-]+:(validate|commit)$`)],             // edits.validate, edits.commit
  ["DELETE", new RegExp(`^${APP}/[\\w-]+$`)],                             // edits.delete (throwaway and failed edits)
];
export function allowed(method, url, dry) {
  let u; try { u = new URL(url); } catch { return false; }
  const raw = url.startsWith(PLAY + "/") ? url.slice(PLAY.length).split("?")[0] : "";
  if (u.origin !== PLAY || raw !== u.pathname) return false;
  if (dry && /(:commit|\/bundles)$/.test(raw)) return false;
  return ALLOWED.some(([m, re]) => m === method && re.test(raw));
}
// Play's answer to a 4xx/5xx as the Hebrew why/next of the Telegram
export function playFail(r, vc = "") {
  const msg = String(J(r.text)?.error?.message || r.text || "").replace(/\s+/g, " ").slice(0, 160);
  if (/has not been used in project|SERVICE_DISABLED|API .*is disabled/i.test(msg))
    return new Fail("ה-API של Google Play כבוי בפרויקט של חשבון השירות", "להפעיל את Google Play Android Developer API ב-Google Cloud Console, בפרויקט של חשבון השירות", r.status);
  if (/changesNotSentForReview/i.test(msg))
    return new Fail("Google Play לא מקבל כרגע שליחה אוטומטית לסקירה (כנראה שינוי קודם עדיין בסקירה או נדחה)", "לפתוח את Publishing overview ב-Play Console, לסיים את השינוי הקודם ולהריץ שוב", r.status);
  if (/in review|under review|pending review/i.test(msg))
    return new Fail("גרסה קודמת עדיין בסקירה של Google", "לחכות שהסקירה תסתיים ולהריץ שוב", r.status);
  if (/version ?code.*(already been used|already used|already exists)/i.test(msg))
    return new Fail(`הבנייה ${vc} כבר קיימת ב-Play`, "להריץ את Android build מחדש (הבנייה החדשה מקבלת מספר חדש)", r.status);
  if (r.status === 401 || r.status === 403)
    return new Fail("לחשבון השירות אין הרשאה מתאימה ב-Play Console", `Play Console ← Users and permissions ← חשבון השירות ← App permissions: לסמן באפליקציה "${PERM}" ו-"${PERM_READ}"`, r.status);
  if (r.status === 404) return new Fail("Google Play לא מצא את האפליקציה או את העריכה", "לבדוק שחשבון השירות הוזמן ל-Play Console עם הרשאה לאפליקציה", r.status);
  if (!r.status || r.status >= 500 || r.status === 429) return new Fail(`Google Play לא ענה (${r.status || "אין חיבור"}) גם אחרי כמה ניסיונות`, "להריץ שוב בעוד כמה דקות", r.status);
  return new Fail(`Google Play החזיר ${r.status}: ${msg || "בלי פירוט"}`, "", r.status);
}
async function play(ctx, method, path, { json, buf, cleanup = false } = {}) {
  const url = PLAY + path;
  if (!allowed(method, url, ctx.dry)) throw new Fail(`refused: ${method} ${path.replace(/edits\/[\w-]+/, "edits/<id>")}`, "", -1);
  const headers = { authorization: "Bearer " + ctx.token, ...(json ? { "content-type": "application/json" } : buf ? { "content-type": "application/octet-stream" } : {}) };
  const r = await call(method, url, { headers, body: json ? JSON.stringify(json) : buf, timeout: buf ? 480000 : 120000, cleanup });
  if (!r.ok) throw playFail(r, ctx.vc);
  return J(r.text) || {};
}
const EDITS = ctx => `/androidpublisher/v3/applications/${ctx.pkg}/edits`;
const insertEdit = async (ctx, cleanup = false) => (await play(ctx, "POST", EDITS(ctx), { json: {}, cleanup })).id;
async function listTracks(ctx, id, cleanup = false) {
  const t = (await play(ctx, "GET", `${EDITS(ctx)}/${id}/tracks`, { cleanup })).tracks;
  if (!Array.isArray(t)) throw new Fail("Google Play החזיר תשובה בלי רשימת מסלולים", "להריץ שוב בעוד כמה דקות");
  return t;
}
const dropEdit = (ctx, id) => play(ctx, "DELETE", `${EDITS(ctx)}/${id}`, { cleanup: true }).catch(() => null);   // best effort: an edit expires on its own
export async function updateTrack(ctx, id, track, releases) {
  if (track !== TRACK) throw new Fail(`refused: track "${track}" (only "${TRACK}" may be written)`, "", -1);
  return play(ctx, "PUT", `${EDITS(ctx)}/${id}/tracks/${track}`, { json: { track, releases } });
}

// ---- release or data rebuild ----
// version tokens in a release name: "1.33", "v1.33", "110 (1.33)", "לוחית 1.33.0"; "1.330" and "11.33" are other versions
export const versionsIn = name => [...String(name || "").matchAll(/(?<![\w.])v?(\d+(?:\.\d+)+)(?!\w|\.\d)/gi)].map(m => m[1]);
// numeric, part by part ("1.9" < "1.10", "1.33.0" = "1.33"); NaN when either is not a dotted number
export function cmpVersion(a, b) {
  const p = s => String(s).split(".").map(Number), x = p(a), y = p(b);
  if (![...x, ...y].every(Number.isInteger)) return NaN;
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return Math.sign(d); }
  return 0;
}
export const carries = (name, vn) => versionsIn(name).some(t => cmpVersion(t, vn) === 0);
// shipped: versionCode -> APP_VERSION of the commit it was built from (versionCode = the Android build's run number), so a release
// renamed by hand in the console still counts. Every way to "not a release" is safe; "release" needs a clear picture of Play.
// unknown: Play's answer is not clear enough to act on (he = the Hebrew why); lookup: the commit map may settle it
export function decide(tracks, vn, vc, shipped = new Map()) {
  const rel = (Array.isArray(tracks) ? tracks : []).flatMap(t => (t?.releases || []).map(r => ({ track: t.track, name: r.name || "",
    codes: (r.versionCodes || []).map(Number).filter(Number.isFinite) })));
  const named = rel.find(r => carries(r.name, vn));
  if (named) return { release: false, why: `${vn} is already on Play (track ${named.track})` };
  const codes = rel.flatMap(r => r.codes), max = codes.length ? Math.max(...codes) : 0;
  if (codes.length && vc <= max) return { release: false, why: `versionCode ${vc} is not above ${max}, the highest on Play` };
  const built = rel.find(r => r.codes.some(c => shipped.get(c) === vn));
  if (built) return { release: false, why: `track ${built.track} already holds a build of ${vn}` };
  if (!/^\d+(\.\d+)+$/.test(vn)) return { release: false, unknown: true, why: `versionName "${vn}" is not a version number`, he: `versionName "${vn.slice(0, 20)}" אינו מספר גרסה` };
  // the app already has builds on Play (alpha at least; production access was requested in 10/2026): an answer with none is not a picture to act on
  if (!codes.length) return { release: false, unknown: true, why: "Play listed no release on any track", he: "Google Play לא החזיר אף גרסה באף מסלול" };
  const top = [...new Set([shipped.get(max), ...rel.filter(r => r.codes.includes(max)).flatMap(r => versionsIn(r.name))].filter(Boolean))];
  if (!top.length) return { release: false, unknown: true, lookup: true, why: `the version of versionCode ${max}, the newest on Play, is not known`, he: `לא ידוע מאיזו גרסה נבנתה הבנייה ${max}, החדשה ביותר ב-Play` };
  if (!top.every(t => cmpVersion(vn, t) > 0)) return { release: false, why: `${vn} is not above ${top.join(" / ")}, the newest on Play (versionCode ${max})` };
  return { release: true, max, top: top.join(" / ") };
}
const topCodes = tracks => [...new Set(tracks.flatMap(t => (t?.releases || []).flatMap(r => (r.versionCodes || []).map(Number))))].filter(Number.isFinite).sort((a, b) => b - a).slice(0, 6);
// APP_VERSION at a commit; "" when GitHub says the file is not there, a Fail when GitHub does not answer
async function versionAt(sha) {
  const f = await gh(`/contents/index.html?ref=${sha}`, "application/vnd.github.raw");
  if (f.status === 404) return "";
  if (!f.ok) throw new Fail(`index.html של ${sha.slice(0, 7)} לא נקרא מ-GitHub (${f.status || "אין חיבור"})`, "להריץ שוב", f.status);
  return /APP_VERSION = "([^"]+)"/.exec(f.text || "")?.[1] || "";
}
// versionCode -> APP_VERSION through the Android build runs; a run that is not found leaves its code out, a GitHub error stops (fail closed)
async function versionsOf(codes) {
  const want = new Set(codes), sha = new Map(), out = new Map();
  for (let page = 1; page <= 10 && sha.size < want.size; page++) {
    const r = await gh(`/actions/workflows/android.yml/runs?per_page=100&page=${page}`);
    const runs = r.ok ? J(r.text)?.workflow_runs : null;
    if (!Array.isArray(runs)) throw new Fail(`רשימת הבניות של Android לא נקראה מ-GitHub (${r.status || "אין חיבור"})`, "להריץ שוב", r.status);
    for (const x of runs) if (want.has(x.run_number) && !sha.has(x.run_number) && SHA40.test(x.head_sha || "")) sha.set(x.run_number, x.head_sha);
    if (runs.length < 100 || Math.min(...runs.map(x => x.run_number)) <= Math.min(...want)) break;
  }
  for (const [code, s] of sha) { const v = await versionAt(s); if (v) out.set(code, v); }
  return out;
}

// ---- inputs from GitHub ----
export function parseVersion(txt) {
  const o = {};
  for (const l of String(txt || "").split(/\r?\n/)) { const m = /^(\w+)=(.*)$/.exec(l.trim()); if (m) o[m[1]] = m[2].trim(); }
  return { vc: +o.versionCode || 0, vn: o.versionName || "", sha: SHA40.test(o.commit || "") ? o.commit : "", signed: o.signed === "true" };
}
// android/release-notes.txt: line 1 "# <VN>"; later lines starting with "#" are comments; the rest is the he-IL text (at most 500 characters)
export function parseNotes(src, vn) {
  if (src == null) return { ok: false, code: "missing" };
  const lines = String(src).replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const head = /^#\s*(\S+)\s*$/.exec(lines[0] || "");
  if (!head) return { ok: false, code: "format" };
  if (head[1] !== vn) return { ok: false, code: "stale", got: head[1].slice(0, 20) };
  const text = lines.slice(1).filter(l => !l.startsWith("#")).join("\n").trim();
  if (!text) return { ok: false, code: "empty" };
  const n = chars(text);
  return n > NOTES_MAX ? { ok: false, code: "long", n } : { ok: true, text, n };
}
async function notesAt(ref) {
  const r = await gh(`/contents/${NOTES_FILE}?ref=${encodeURIComponent(ref)}`, "application/vnd.github.raw");
  if (r.status === 404) return null;
  if (!r.ok) throw new Fail(`הקריאה של ${NOTES_FILE} מ-GitHub נכשלה (${r.status || "אין חיבור"})`, "להריץ שוב", r.status);
  return r.text;
}
async function findDraft(build) {
  const r = await gh("/releases?per_page=100");
  const list = r.ok ? J(r.text) : null;
  if (!Array.isArray(list)) throw new Fail(`רשימת ה-releases ב-GitHub לא נקראה (${r.ok ? "תשובה לא צפויה" : r.status || "אין חיבור"})`, "להריץ שוב", r.ok ? 0 : r.status);
  const drafts = list.filter(x => x?.draft && /^build-\d+$/.test(x.name || "")).sort((a, b) => +b.name.slice(6) - +a.name.slice(6));
  const d = build ? drafts.find(x => x.name === "build-" + build) : drafts[0], newest = drafts[0] ? +drafts[0].name.slice(6) : 0;
  return d ? { n: +d.name.slice(6), assets: Array.isArray(d.assets) ? d.assets : [], newest } : { n: 0, newest };
}
async function asset(a, binary = false) {
  const r = await gh(`/releases/assets/${a.id}`, "application/octet-stream", binary);
  if (!r.ok) throw Object.assign(new Fail(`הקובץ ${a.name} לא ירד מה-draft ב-GitHub (${r.status || "אין חיבור"})`, "להריץ שוב", r.status), { gone: r.status === 404 });
  return binary ? r.buf : r.text;
}
// the draft's commit must be on main: an Android build started by hand on another branch makes a draft too, and it may be the newest
async function onMain(sha) {
  if (!SHA40.test(sha || "")) return false;
  const r = await gh(`/compare/main...${sha}?per_page=1`);
  if (r.status === 404) return false;
  if (!r.ok) throw new Fail(`GitHub לא השווה את ${sha.slice(0, 7)} ל-main (${r.status || "אין חיבור"})`, "להריץ שוב", r.status);
  return ["behind", "identical"].includes(J(r.text)?.status);
}
// what this build changed against the newest successful Android build on main that had finished when this one started. A build that
// overlapped this one is passed over: this build deleted its draft, maybe before that build's own Ship tail run read it, so it may never
// have been told. null = not known (that counts as changed: a release must not go untold).
async function changeOf(sha, vc, vn) {
  try {
    const r = await gh("/actions/workflows/android.yml/runs?branch=main&status=success&per_page=50");
    const runs = r.ok ? J(r.text)?.workflow_runs : null;
    if (!Array.isArray(runs) || !SHA40.test(sha || "")) return null;
    const self = runs.find(x => x.run_number === vc), start = Date.parse(self?.run_started_at || self?.created_at || "") || Infinity;
    const prev = runs.filter(x => x.run_number < vc && SHA40.test(x.head_sha || "") && !(Date.parse(x.updated_at) > start)).sort((a, b) => b.run_number - a.run_number)[0];
    if (!prev) return null;
    const was = await versionAt(prev.head_sha), now = vn || await versionAt(sha);
    if (!was || !now) return null;
    return { prev: prev.run_number, was, now, version: was !== now, notes: (await notesAt(sha)) !== (await notesAt(prev.head_sha)) };
  } catch { return null; }
}

// ---- the Play step ----
const note = s => IO.out("::notice::" + s);
const fmtTracks = tracks => (tracks || []).map(t => `${t.track}: ${(t.releases || []).map(r => `${r.name || "?"} (${(r.versionCodes || []).join("+") || "-"}, ${r.status || "?"})`).join(", ") || "-"}`);
export async function ship() {
  IO.deadline = IO.now() + BUDGET_MS;
  const manual = IO.env.EVENT === "workflow_dispatch";
  const R = await judge(manual);
  // who hears about it: an upload, always. A release that waits or an error: a manual run, or the build that changed APP_VERSION (once
  // Play said it is a release, also the notes), or when that is not known. Every other build only logs it.
  if (R.code === "uploaded") R.tell = true;
  else if (["notes", "dry", "error"].includes(R.code)) R.tell = manual || await changed(R, R.release);
  if (R.code === "error") IO.out(`${R.tell ? "::error::" : "::warning::"}Play ${R.stage} failed${R.status > 0 ? ` (${R.status})` : ""}: ${R.why}${R.tell ? "" : ` (no Telegram: ${R.change})`}`);
  else if (!R.tell && (R.code === "notes" || R.code === "dry")) IO.out(`${R.code}: ${R.vn} still waits, no Telegram (${R.change})`);
  return R;
}
async function changed(R, withNotes) {
  const c = await changeOf(R.sha, R.vc || +IO.env.BUILD || 0, R.vn);
  R.change = !c ? "the previous build on main is not known" : `against build ${c.prev}: APP_VERSION ${c.version ? `${c.was} -> ${c.now}` : "unchanged"}` +
    (withNotes ? `, release notes ${c.notes ? "changed" : "unchanged"}` : "");
  return !c || c.version || (withNotes && c.notes);
}
async function judge(manual) {
  const env = IO.env, mode = env.MODE === "on" ? "on" : "dry";
  const R = { release: false, tell: false, code: "", mode, vn: "", vc: 0, sha: SHA40.test(env.HEAD_SHA || "") ? env.HEAD_SHA : "", build: 0, n: 0, why: "", next: "", stage: "" };
  const raw = String(env[SECRET] || "").trim();
  if (!raw) { note(`${SECRET} is not set: the Play step is skipped`); return { ...R, code: "nosecret" }; }
  const sa = J(raw), keyOk = !!(sa?.client_email && sa?.private_key);
  const build = String(env.BUILD || "").trim();
  if (build && !/^\d{1,7}$/.test(build)) return { ...R, code: "no-build", why: "build must be an Android build run number" };
  R.vc = +build || 0;

  // 1 the build: its draft release and version.txt (a newer build deletes the older drafts; its own Ship tail run handles this version)
  let d, v;
  try {
    d = await findDraft(build);
    if (!d.n) {
      const why = build ? `no draft release build-${build}${d.newest ? ` (the newest is build-${d.newest})` : ""}` : "no build draft release";
      if (manual) return { ...R, code: "no-build", why };
      note(`${why}: a newer build replaced it, nothing to do`); return { ...R, code: "superseded" };
    }
    const vt = d.assets.find(a => a.name === "version.txt");
    if (!vt) return { ...R, code: "no-build", why: `build-${d.n} has no version.txt` };
    v = parseVersion(await asset(vt));
  } catch (e) {
    if (e?.gone && !manual) { note("the draft went away while it was read: a newer build replaced it, nothing to do"); return { ...R, code: "superseded" }; }
    return failed(R, e, "github");
  }
  if (v.vc !== d.n || !v.vn) return { ...R, code: "no-build", why: `version.txt of build-${d.n} does not match the build` };
  Object.assign(R, { vn: v.vn, vc: v.vc, sha: v.sha, build: d.n });
  try {
    // an automatic run's build is the Android build on main that triggered it; any other draft is checked against main
    if (!(!manual && v.sha && v.sha === env.HEAD_SHA) && !(await onMain(v.sha)))
      return { ...R, code: "not-main", why: `build-${d.n} (commit ${v.sha.slice(0, 7) || "?"}) is not on main: nothing is uploaded` };
  } catch (e) { return failed(R, e, "github"); }
  if (!keyOk) return failed(R, new Fail(`הסוד ${SECRET} מוגדר אבל אינו מפתח JSON של חשבון שירות`, `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח, כמו שהורד`), "secret");
  const ctx = { pkg: env.PLAY_PACKAGE || PKG, dry: mode !== "on", vc: v.vc };

  // 2 release or data rebuild: every track's releases, read inside a throwaway edit, then the commits Play's newest builds came from
  let tracks, dec;
  try {
    ctx.token = await accessToken(sa);
    const id = await insertEdit(ctx);
    try { tracks = await listTracks(ctx, id); } finally { await dropEdit(ctx, id); }
    R.tracks = fmtTracks(tracks);
    dec = decide(tracks, v.vn, v.vc);
    if (dec.release || dec.lookup) dec = decide(tracks, v.vn, v.vc, await versionsOf(topCodes(tracks)));
    if (dec.unknown) { IO.out(`decide: ${dec.why}`); throw new Fail(dec.he, "לבדוק ב-Play Console מה יש במסלולים"); }
  } catch (e) { return failed(R, e, "decide"); }
  if (!dec.release) { IO.out(`data rebuild, nothing to upload: ${dec.why}`); return { ...R, code: "rebuild", why: dec.why }; }
  R.release = true;
  IO.out(`release: ${v.vn} (versionCode ${v.vc}) is not on Play yet; the newest there is ${dec.top} (versionCode ${dec.max})`);

  try {
    // 3 release notes from the build's commit; a manual re-run also looks at main, where the owner adds them after the build
    let nt = parseNotes(await notesAt(R.sha), v.vn);
    if (!nt.ok && manual) { const m = parseNotes(await notesAt("main"), v.vn); if (m.ok) nt = m; }
    if (!nt.ok) { IO.out(`release notes ${nt.code}: nothing uploaded`); return { ...R, code: "notes", notes: nt.code, got: nt.got || "", n: nt.n || 0 }; }
    R.n = nt.n;
    if (!v.signed) throw new Fail(`הבנייה ${v.vc} לא חתומה (חסרים סודות החתימה ב-Android build)`, "להוסיף ב-GitHub את סודות החתימה של האנדרואיד ולהריץ את Android build מחדש");
    const aab = d.assets.find(a => a.name === `luchit-${v.vn}.aab`);
    if (!aab) throw new Fail(`ב-draft של build-${d.n} אין luchit-${v.vn}.aab`, "להריץ את Android build מחדש");

    // 4 dry: a throwaway edit gets the alpha track written back exactly as it is (which needs the release permission and changes
    // nothing), is validated and deleted; nothing is uploaded or committed
    if (ctx.dry) {
      const alpha = tracks.find(t => t.track === TRACK && (t.releases || []).length);
      const id = await insertEdit(ctx);
      try {
        if (alpha) await updateTrack(ctx, id, TRACK, alpha.releases);
        await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
      } finally { await dropEdit(ctx, id); }
      R.checked = alpha ? "permission" : "access";
      IO.out(`dry run: would upload ${aab.name} as ${v.vn} (versionCode ${v.vc}) to ${TRACK}, notes ${nt.n} characters; ${alpha ? "the alpha permission was checked" : "alpha is empty, so the permission was not checked"}`);
      return { ...R, code: "dry" };
    }

    // 5 on: upload -> alpha -> validate -> commit (commit sends for review, as the console's "Send for review")
    const buf = await asset(aab, true);
    if (buf.length < 1000 || buf.readUInt32LE(0) !== 0x04034b50) throw new Fail(`${aab.name} ב-draft אינו קובץ AAB תקין`, "להריץ את Android build מחדש");
    const id = await insertEdit(ctx);
    let committed = false;
    try {
      const up = await play(ctx, "POST", `/upload${EDITS(ctx)}/${id}/bundles?uploadType=media`, { buf });
      if (+up.versionCode !== v.vc) throw new Fail(`Google Play קרא מהקובץ מספר בנייה ${up.versionCode} ולא ${v.vc}`);
      if (up.sha256 && up.sha256 !== sha256(buf)) throw new Fail("הקובץ שהגיע ל-Google Play שונה מהקובץ שנבנה", "להריץ שוב");
      await updateTrack(ctx, id, TRACK, [{ name: v.vn, versionCodes: [String(v.vc)], status: "completed", releaseNotes: [{ language: NOTES_LANG, text: nt.text }] }]);
      await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
      try { await play(ctx, "POST", `${EDITS(ctx)}/${id}:commit`); committed = true; }
      catch (e) {
        // a commit that got no answer may still have landed (its retry then finds no edit): look at alpha before reporting
        if (await onAlpha(ctx, v.vc)) committed = true; else throw e;
      }
    } finally { if (!committed) await dropEdit(ctx, id); }
    IO.out(`uploaded: ${v.vn} (versionCode ${v.vc}) is on ${TRACK} and sent for review`);
    return { ...R, code: "uploaded" };
  } catch (e) {
    // the draft was deleted by a newer build between the steps: that build's own run uploads this version
    if (e?.gone && !manual) { note("the draft went away while it was read: a newer build replaced it, nothing to do"); return { ...R, code: "superseded" }; }
    return failed(R, e, "upload");
  }
}
async function onAlpha(ctx, vc) {
  try {
    const id = await insertEdit(ctx, true);
    try { return (await listTracks(ctx, id, true)).some(t => t.track === TRACK && (t.releases || []).some(r => (r.versionCodes || []).map(Number).includes(vc))); }
    finally { await dropEdit(ctx, id); }
  } catch { return false; }
}
function failed(R, e, stage) {
  const f = e instanceof Fail ? e : new Fail("תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג של Ship tail");
  return { ...R, code: "error", stage, why: f.why, next: f.next, status: f.status };
}
function report(R) {
  const lines = [`### Ship tail: Play (${R.mode})`, "", `- result: **${R.code}**${R.stage ? ` (${R.stage})` : ""}${R.why ? `: ${R.why}` : ""}`];
  if (R.vn) lines.push(`- build ${R.build}: versionName ${R.vn}, versionCode ${R.vc}, commit ${(R.sha || "?").slice(0, 7)}`);
  if (R.tracks) lines.push(`- on Play: ${R.tracks.join("; ") || "no tracks"}`);
  if (R.code === "notes") lines.push(`- ${NOTES_FILE}: ${R.notes}${R.got ? ` (header ${R.got})` : ""}${R.n ? ` (${R.n} characters)` : ""}`);
  else if (R.n) lines.push(`- release notes: ${R.n} of ${NOTES_MAX} characters`);
  lines.push(`- Telegram: ${R.tell ? "yes" : "no"}${R.change ? ` (${R.change})` : ""}`);
  IO.summary(lines.join("\n"));
}

// ---- the one Telegram ----
const mark = (run, label, none) => !run ? none : run.status !== "completed" ? `${label}: עוד רץ` : run.conclusion === "success" ? `${label} ✓` :
  run.conclusion === "cancelled" ? `${label}: בוטל` : `${label} ✗`;
export function ga4Mark(G, job) {
  if (!G) return job === "failure" ? "GA4 ✗" : null;
  return { ok: "GA4 ✓", created: "GA4 ✓", "needs-editor": "GA4: חסר תפקיד Editor", "api-off": "GA4: ה-API כבוי", mismatch: "GA4: מספר הנכס לא תואם",
    error: "GA4 ✗", dry: G.missing?.length ? `GA4: חסרים ${G.missing.length}` : "GA4 ✓" }[G.code] || null;
}
export function compose(P, G, runs, env = {}) {
  const dev = env.PLAY_DEVELOPER_ID, app = env.PLAY_APP_ID;
  const pc = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/closed-testing` : "https://play.google.com/console";
  const site = runs.ok === false ? "אתר: לא ידוע" : runs.smoke ? mark(runs.smoke, "אתר") : "אתר: לא נבדק";
  const parts = [site, mark(runs.workers, "Workers", null), ga4Mark(G, env.GA4_JOB)].filter(Boolean);
  const status = parts.join(" · ");
  const fix = [];
  if (runs.smoke?.status === "completed" && runs.smoke.conclusion !== "success") fix.push(`אתר: ${runs.smoke.html_url}`);
  if (runs.workers?.status === "completed" && runs.workers.conclusion !== "success") fix.push(`Workers: ${runs.workers.html_url}`);
  if (G?.why && G.code !== "ok" && G.code !== "created" && G.code !== "dry") fix.push(`GA4: ${G.why}${G.next ? `. ${G.next}` : ""}.`);
  const vn = P.vn, vc = P.vc, run = env.RUN_URL || "";
  const tech = [vc ? `versionCode ${vc}` : "", P.sha ? `commit ${String(P.sha).slice(0, 7)}` : ""].filter(Boolean);
  let level = "day", key, today = "loud", m;
  if (P.code === "uploaded") {
    key = `ship:done:${vn}`; today = "silent";   // a step that finished as planned is quiet
    m = { kind: "done", title: `לוחית ${escH(vn)} עלתה ל-Alpha ונשלחה לבדיקה של גוגל`,
      text: `${escH(status)}.\nאחרי האישור של גוגל הבודקים מקבלים אותה. משתמשי החנות מקבלים אותה רק אחרי "פרסם".`,
      what: `כשרוצים להפיץ לכולם: לכתוב "פרסם" בשרשור "מוצר ושחרורים". <a href="${escH(pc)}">Play Console</a>` };
  } else if (P.code === "dry") {
    key = `ship:dry:${vn}`;
    const checked = P.checked === "permission" ? "נבדקו הגישה ל-Play וההרשאה ל-Alpha, לא ההעלאה עצמה" : "נבדקה הגישה ל-Play, לא ההרשאה ל-Alpha (המסלול ריק) ולא ההעלאה עצמה";
    m = { kind: "info", title: `בדיקה יבשה: לוחית ${escH(vn)} מוכנה ל-Alpha`, text: `${checked}. לא הועלה כלום. ${escH(status)}.`,
      what: (gate({ ...env, REF: "refs/heads/main" }).mode === "dry" && String(env.SHIP_TAIL || "").trim() ? `להפעיל את ההעלאה האוטומטית (המשתנה בפרטים הטכניים: on, או למחוק אותו), ואז ${escH(RERUN(vc))}.` : `כדי להעלות באמת: ${escH(RERUN(vc))}.`) };
    tech.push(`הערות שחרור: ${P.n} תווים`);
    if (String(env.SHIP_TAIL || "").trim()) tech.push(`SHIP_TAIL=${String(env.SHIP_TAIL).trim().slice(0, 12)}`);
  } else if (P.code === "notes") {
    key = `ship:notes:${vn}`;
    const why = { missing: " (הקובץ חסר)", format: ` (השורה הראשונה צריכה להיות "# ${vn}")`, stale: ` (בקובץ כתוב ${P.got})`, empty: " (אין טקסט מתחת לכותרת)",
      long: ` (${P.n} תווים, המקסימום ${NOTES_MAX})` }[P.notes] || "";
    m = { kind: "today", title: `העלאת לוחית ${escH(vn)} ל-Alpha מחכה להערות שחרור${escH(why)}`, text: `בלי "מה חדש" בעברית הגרסה לא עולה לגוגל. ${escH(status)}.`,
      what: escH(`ב-main, בקובץ ${NOTES_FILE}, שורה ראשונה "# ${vn}" ומתחתיה ההערות בעברית (עד ${NOTES_MAX} תווים). השמירה בונה את האפליקציה מחדש וההעלאה רצה לבד. אם לא: ${RERUN(vc)}.`) };
  } else {
    key = P.stage === "decide" || P.stage === "secret" ? "ship:fail:access" : P.stage === "github" ? "ship:fail:github" : `ship:fail:${vn}`;
    const w = whyHe(P.why);
    const head = P.stage === "decide" ? `לא ברור אם לוחית ${escH(vn)} כבר ב-Google Play` : P.stage === "secret" ? "ההעלאה האוטומטית לא מתחברת ל-Google Play"
      : P.stage === "github" ? `ההעלאה לא קראה מ-GitHub את בניית האנדרואיד${vc ? ` ${vc}` : ""}` : `העלאת לוחית ${escH(vn)} ל-Alpha נכשלה`;
    // "run again (in a few minutes)" is the re-run itself, not a step before it
    const again = /^להריץ שוב/.test(P.next || ""), next = again ? RERUN(vc) + P.next.slice(9) : `${P.next ? P.next + ", ואז " : ""}${RERUN(vc)}`;
    m = { kind: "today", title: head, text: `${w.he}.${P.stage === "upload" || !P.stage ? ` ${escH(status)}.` : ""} הגרסה לא מגיעה לבודקים עד שזה מתוקן.`.replace("..", "."),
      what: `${escH(next)}.${run ? ` <a href="${escH(run)}">הלוג</a>` : ""}` };
    if (w.raw) tech.push(w.raw);
  }
  if (fix.length) m.text += "\n" + fix.map(escH).join("\n");
  const text = msg({ ...m, area: "app", raw: tech.join(" · ") });
  return { level, key, text, today, link: P.code === "uploaded" ? pc : run };
}
async function runsFor(sha) {
  if (!SHA40.test(sha || "")) return { ok: false };
  const r = await gh(`/actions/runs?head_sha=${sha}&per_page=100`);
  const runs = r.ok ? J(r.text)?.workflow_runs : null;
  if (!Array.isArray(runs)) return { ok: false };
  const pick = name => runs.filter(x => x.name === name).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
  return { ok: true, workers: pick(WORKERS_WF), smoke: pick(SMOKE_WF) };
}
async function telegram(text) {
  const r = await call("POST", `https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), timeout: 20000, once: true });
  IO.out(`telegram ${r.status || "no answer"}`);
  return r.ok;
}
export async function summary() {
  const env = IO.env, P = unpack(env.PLAY_RESULT), G = unpack(env.GA4_RESULT);
  IO.deadline = IO.now() + 3 * 60000;   // the summary job has 5 minutes
  if (!P?.tell) { IO.out("nothing to tell: no message"); return 0; }
  const runs = await runsFor(P.sha).catch(() => ({ ok: false }));
  const m = compose(P, G, runs, env);
  // the job summary of a public repository: the Play Console link (developer and app ids) stays in the Telegram only
  IO.summary(`### Ship tail: message\n\n${m.text.replace(/https:\/\/play\.google\.com\/console\S*/g, "Play Console").replace(/\n/g, "  \n")}`);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { note("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: the message is only in the job summary"); return 0; }
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const fresh = env.EVENT === "workflow_dispatch" && P.code !== "dry";   // a manual re-run always reports, even inside the 24 h dedupe
  const r = router ? await router.alert(m.level, m.key, m.text, m.link, { today: m.today || "loud", fresh, legacy: () => telegram(m.text) })
    : { delivered: await telegram(m.text) };
  // an upload that went through ends every Ship tail failure before it (access, GitHub, an upload): the router tells each one "חזר לתקין"
  if (router?.resolve && P.code === "uploaded") try { await router.resolve(["ship:fail:"]); } catch { /* the morning ledger still shows it */ }
  return r.delivered ? 0 : 1;
}

// ---- CLI ----
export async function cli(argv) {
  const cmd = argv[0] || "";
  if (cmd === "gate") {
    const g = gate(IO.env);
    for (const n of g.notes) note(n);
    for (const k of ["mode", "play", "ga4"]) IO.output(k, String(g[k]));
    IO.out(`gate: mode=${g.mode} play=${g.play} ga4=${g.ga4}`);
    return 0;
  }
  if (cmd === "summary") return summary();
  if (cmd === "selftest") return selftest();
  if (cmd) { IO.out("usage: play-alpha.mjs [gate|summary|selftest]"); return 2; }
  const R = await ship();
  const { tracks, ...out } = R;
  IO.output("result", pack(out));
  IO.output("tell", String(!!R.tell));
  report(R);
  // a run that names a missing build, or a draft from another branch, is the caller's to see
  if (R.code === "no-build" || (R.code === "not-main" && IO.env.EVENT === "workflow_dispatch")) { IO.out("::error::" + R.why); return 1; }
  if (R.code === "not-main") IO.out("::warning::" + R.why);
  return 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  // one group of cases; a crash fails that group only (so a missing feature shows as its own failures)
  const group = async (name, fn) => { try { await fn(); } catch (e) { fails.push(`${name} crashed: ${String(e?.stack || e).split("\n").slice(0, 3).join(" | ")}`); } };
  const saved = { ...IO }, realFetch = globalThis.fetch;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
  const SA = { type: "service_account", client_email: "ship@luchit-test.iam.gserviceaccount.com", private_key: PEM };
  // a key as Google hands it out: pretty-printed over many lines (the runner masks each line, "{" and "}" included)
  const SA_FILE = JSON.stringify(SA, null, 2);
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN-a1b2c3", TG = "777:SECRET-BOT-TOKEN-x9y8", GHT = "ghs_SECRET-GITHUB-TOKEN";
  const S = c => c.repeat(40), SHA = S("a"), SHA_OLD = S("b"), SHA_109 = S("9"), SHA_111 = S("1"), SHA_112 = S("2"), SHA_113 = S("3"), SHA_114 = S("4"), SHA_115 = S("5");
  const SHA_100 = S("0"), SHA_NEXT = S("c"), PKGP = `/androidpublisher/v3/applications/${PKG}/edits`;
  const AAB = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), crypto.randomBytes(4000)]);
  const HE = "• חיפוש מהיר יותר\n• תיקון ריקולים לדגם", TPL = "# 1.33\n# a comment: the template on main\n", N133 = `# 1.33\n# comment line\n${HE}\n`;
  const T0 = Date.UTC(2026, 9, 18, 6), MIN = 60000;
  // an Android build on GitHub: run number, commit, APP_VERSION and release notes at that commit; it ran from minute s to minute e
  const B = (n, sha, vn, notes, x = {}) => ({ n, sha, vn, notes, branch: "main", ok: true, s: (n - 100) * 30, e: (n - 100) * 30 + 10, ...x });
  const PROD_132 = [{ track: "production", releases: [{ name: "1.32", versionCodes: ["108"], status: "completed" }] }, { track: "alpha", releases: [{ name: "1.32", versionCodes: ["108"], status: "completed" }] }];
  // a fake GitHub + Play + Telegram on a virtual clock; fail[op] = statuses served before the real answer; took[op] = minutes a request takes
  function world(o = {}) {
    const W = { calls: [], printed: [], outputs: {}, sums: [], tg: [], tgTries: 0, seq: 0, clock: T0 + 400 * MIN, fail: structuredClone(o.fail || {}),
      tracks: structuredClone(o.tracks ?? PROD_132), edits: new Map() };
    const notes = "notes" in o ? o.notes : N133;
    const builds = o.builds ?? [B(108, SHA_OLD, o.oldVersion ?? "1.32", TPL), B(109, SHA_109, "1.32", TPL), B(110, SHA, "1.33", notes)];
    const dr = o.draft ?? { n: 110, vn: "1.33", sha: SHA };
    const vtxt = o.version ?? `versionCode=${dr.n}\nversionName=${dr.vn}\ncommit=${dr.sha}\nsigned=true\n`;
    const bySha = sha => builds.find(b => b.sha === sha), mainTip = [...builds].filter(b => b.branch === "main").sort((a, b) => b.n - a.n)[0];
    const iso = m => new Date(T0 + m * MIN).toISOString();
    const res = (status, body, headers = {}) => new Response(status === 204 ? null : typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body ?? {}), { status, headers });
    const take = op => { const q = W.fail[op]; if (q && q.length) { const s = q.shift(); return typeof s === "object" ? res(s.status, s.body ?? { error: { message: s.msg || "x" } }, s.headers) : res(s, { error: { message: "scripted " + s } }); } return null; };
    W.fetch = async (url, opt = {}) => {
      const method = opt.method || "GET", u = new URL(url), p = u.pathname;
      W.calls.push({ method, url, body: opt.body, headers: opt.headers || {}, at: W.clock });
      if (url === TOKEN_URL) {
        const a = new URLSearchParams(opt.body).get("assertion") || "";
        return take("token") || (a.split(".").length === 3 ? res(200, { access_token: TOKEN, expires_in: 3599 }) : res(400, { error: "invalid_grant" }));
      }
      if (u.host === "api.telegram.org") {
        W.tgTries++;
        if (o.tgTimeout) throw Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
        W.tg.push(J(opt.body)); return take("tg") || res(200, { ok: true });
      }
      if (u.host === "storage.example") return p === "/1" ? res(200, vtxt) : res(200, AAB);
      if (u.host === "api.github.com") {
        const rp = p.replace("/repos/ddsabag/vehicle-app", ""), q = u.searchParams;
        if (rp === "/releases") return take("releases") || res(200, o.releases ?? [{ draft: true, name: `build-${dr.n}`, assets: [{ id: 1, name: "version.txt" }, { id: 2, name: `luchit-${dr.vn}.aab` }, { id: 3, name: `luchit-${dr.vn}.apk` }] }]);
        if (rp === "/releases/assets/1") return res(302, "", { location: "https://storage.example/1" });
        if (rp === "/releases/assets/2") return take("aab") || res(302, "", { location: "https://storage.example/2" });
        if (rp === `/contents/${NOTES_FILE}`) {
          const ref = q.get("ref"), n = ref === "main" ? ("mainNotes" in o ? o.mainNotes : mainTip?.notes) : bySha(ref)?.notes;
          return take("notes") || (n == null ? res(404, { message: "Not Found" }) : res(200, n));
        }
        if (rp === "/contents/index.html") { const b = bySha(q.get("ref")); return take("index") || (b ? res(200, `<script>\nconst APP_VERSION = "${b.vn}";\n</script>`) : res(404, { message: "Not Found" })); }
        if (rp === "/actions/workflows/android.yml/runs") {
          const e = take("runs"); if (e) return e;
          const per = +(q.get("per_page") || 30), page = +(q.get("page") || 1);
          const list = builds.filter(b => (!q.get("branch") || b.branch === q.get("branch")) && (!q.get("status") || (q.get("status") === "success") === b.ok)).sort((a, b) => b.n - a.n)
            .map(b => ({ run_number: b.n, head_sha: b.sha, head_branch: b.branch, conclusion: b.ok ? "success" : "failure", created_at: iso(b.s), run_started_at: iso(b.s), updated_at: iso(b.e) }));
          return res(200, { total_count: list.length, workflow_runs: list.slice((page - 1) * per, page * per) });
        }
        if (rp.startsWith("/compare/main...")) { const b = bySha(rp.slice(16)); return take("compare") || res(200, { status: b?.branch === "main" ? (b === mainTip ? "identical" : "behind") : "diverged" }); }
        if (rp === "/actions/runs") return res(200, { workflow_runs: o.headRuns ?? [] });
        return res(404, { message: "Not Found" });
      }
      if (u.origin === PLAY) {
        if (opt.headers?.authorization !== "Bearer " + TOKEN) return res(401, { error: { message: "no auth" } });
        const id = p.match(/edits\/([\w-]+)/)?.[1];
        if (method === "POST" && p === PKGP) { const e = take("insert"); if (e) return e; const nid = "e" + ++W.seq; W.edits.set(nid, { upload: null, alpha: null }); return res(200, { id: nid }); }
        const ed = W.edits.get(id);
        if (!ed) return res(404, { error: { message: "edit not found" } });
        if (method === "GET" && p.endsWith("/tracks")) return take("list") || res(200, "listBody" in o ? o.listBody : { tracks: W.tracks });
        if (method === "DELETE") { W.edits.delete(id); return res(204); }
        if (method === "POST" && p.endsWith("/bundles")) {
          W.clock += (o.took?.upload || 0) * MIN;
          const e = take("upload"); if (e) return e; ed.upload = Buffer.from(opt.body); return res(200, { versionCode: o.readCode ?? dr.n, sha256: sha256(ed.upload) });
        }
        if (method === "PUT" && p.endsWith("/tracks/alpha")) { ed.alpha = J(opt.body); return take("track") || res(200, ed.alpha); }
        if (p.endsWith(":validate")) return take("validate") || res(200, {});
        if (p.endsWith(":commit")) {
          const e = take("commit"); if (e && !o.commitLands) return e;
          if (ed.alpha) W.tracks = W.tracks.filter(t => t.track !== "alpha").concat([ed.alpha]);
          W.edits.delete(id); return e || res(200, { id });
        }
        return res(400, { error: { message: "unexpected" } });
      }
      return res(599, "unknown host");
    };
    return W;
  }
  const ENV = { GITHUB_TOKEN: GHT, GITHUB_REPOSITORY: "ddsabag/vehicle-app", [SECRET]: SA_FILE, MODE: "on", BUILD: "110", EVENT: "workflow_run", HEAD_SHA: SHA };
  const run = async (o = {}, env = {}, argv = []) => {
    const W = world(o);
    globalThis.fetch = W.fetch;   // alert.mjs (imported by summary) uses the global fetch: nothing leaves the machine
    Object.assign(IO, { env: { ...ENV, ...env }, fetch: W.fetch, now: () => W.clock, sleep: async ms => { W.clock += ms; }, deadline: 0,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s) });
    W.t0 = W.clock;
    W.code = await cli(argv);
    W.R = unpack(W.outputs.result || "");
    W.writes = W.calls.filter(c => c.method !== "GET" && new URL(c.url).origin === PLAY).map(c => `${c.method} ${new URL(c.url).pathname.replace(/edits\/[\w-]+/, "edits/E")}`);
    return W;
  };
  // ship-tail.yml end to end: the play step, then the summary job when the play step's "tell" output is true
  const pipeline = async (o = {}, env = {}) => {
    const W = await run(o, env);
    const go = (W.outputs.tell ?? W.outputs.release) === "true";
    const S2 = go ? await run(o, { ...env, PLAY_RESULT: W.outputs.result, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]) : { tg: [] };
    return { W, R: W.R, tg: S2.tg.length, texts: S2.tg.map(x => x.text) };
  };
  const playWrites = W => W.writes.filter(w => !/^DELETE|POST \/androidpublisher\/v3\/applications\/[\w.]+\/edits$/.test(w));
  const uploaded = W => W.calls.some(x => x.url.endsWith(":commit")) || W.calls.some(x => x.url.includes("/bundles"));
  const warned = W => W.printed.some(l => l.startsWith("::warning::")) && !W.printed.some(l => l.startsWith("::error::"));
  let W;

  await group("jwt", async () => {
    // JWT shape: three base64url parts, RS256 header, the right claims, one hour, a signature the public key accepts
    const t = jwt(SA, SCOPE, Date.UTC(2026, 9, 18, 12)), [h, c, s] = t.split(".");
    const hd = J(Buffer.from(h, "base64url").toString()), cl = J(Buffer.from(c, "base64url").toString());
    ok(t.split(".").length === 3 && hd.alg === "RS256" && hd.typ === "JWT", "jwt header");
    ok(cl.iss === SA.client_email && cl.scope === SCOPE && cl.aud === TOKEN_URL && cl.exp - cl.iat === 3600 && cl.iat === Date.UTC(2026, 9, 18, 12) / 1000, "jwt claims");
    ok(crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")), "jwt signature verifies");
  });

  await group("gate", async () => {
    const M = "refs/heads/main", g = (v, e) => gate({ SHIP_TAIL: v, REF: M, ...e });
    ok(g("off", { EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "main" }).play === false && g("off", { EVENT: "push" }).ga4 === false, "gate: off runs nothing");
    ok(g("", { EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "main" }).mode === "on" && g("on", { EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "main" }).play, "gate: unset/on acts");
    ok(g("dry", { EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "main" }).mode === "dry" && g("Dry ", { EVENT: "push" }).mode === "dry", "gate: dry");
    ok(g("maybe", { EVENT: "push" }).mode === "dry", "gate: unknown value counts as dry");
    ok(!g("", { EVENT: "workflow_run", RUN_CONCLUSION: "failure", RUN_BRANCH: "main" }).play && !g("", { EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "next" }).play, "gate: failed or non-main build -> no play");
    ok(g("dry", { EVENT: "workflow_dispatch", INPUT_MODE: "on", INPUT_STEP: "play" }).mode === "dry" && g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on", INPUT_STEP: "play" }).mode === "on", "gate: manual on never above the switch");
    ok(g("", { EVENT: "workflow_dispatch", INPUT_STEP: "ga4" }).ga4 && !g("", { EVENT: "workflow_dispatch", INPUT_STEP: "ga4" }).play && g("", { EVENT: "workflow_dispatch" }).mode === "dry", "gate: manual step, default dry");
    ok(g("", { EVENT: "push" }).ga4 && !g("", { EVENT: "push" }).play, "gate: push is GA4 only");
  });

  await group("upload", async () => {
    // a release, uploaded: only alpha is written, with the exact release and Hebrew notes; told
    W = await run();
    ok(W.code === 0 && W.R.release === true && W.R.code === "uploaded" && W.outputs.tell === "true", "upload: " + JSON.stringify(W.R));
    ok(playWrites(W).join() === ["POST /upload/androidpublisher/v3/applications/" + PKG + "/edits/E/bundles", `PUT ${PKGP}/E/tracks/alpha`, `POST ${PKGP}/E:validate`, `POST ${PKGP}/E:commit`].join(), "upload: call sequence " + playWrites(W));
    const put = J(W.calls.find(x => x.method === "PUT").body);
    ok(put.track === "alpha" && put.releases.length === 1 && put.releases[0].name === "1.33" && put.releases[0].versionCodes.join() === "110" && put.releases[0].status === "completed"
      && put.releases[0].releaseNotes[0].language === "iw-IL" && put.releases[0].releaseNotes[0].text === HE, "upload: the alpha release");
    ok(W.tracks.find(t => t.track === "production").releases[0].name === "1.32", "upload: production unchanged");
    ok(W.calls.filter(x => x.url.includes("/bundles")).every(x => Buffer.compare(Buffer.from(x.body), AAB) === 0), "upload: the aab bytes");
    ok(W.calls.filter(x => x.url.startsWith("https://api.github.com")).every(x => x.method === "GET"), "GitHub is only read (the draft is never deleted or published)");
    ok(W.calls.filter(x => x.url.startsWith("https://storage.example")).every(x => !x.headers.authorization), "asset redirect: no GitHub token sent to storage");
    ok(W.edits.size === 0, "upload: no edit left open");
    // closed testing only (no production release yet, as in 10/2026): still a release, still alpha only
    W = await run({ tracks: [PROD_132[1]] });
    ok(W.code === 0 && W.R.release === true && W.R.code === "uploaded", "upload without a production release: " + JSON.stringify(W.R));
    ok(playWrites(W).filter(x => x.startsWith("PUT ")).join() === `PUT ${PKGP}/E/tracks/alpha` && !W.tracks.some(t => t.track === "production"), "upload without a production release: alpha only");
    W = await run({ tracks: [] });
    ok(W.R.release === false && playWrites(W).length === 0, "no release on any track: nothing uploaded " + JSON.stringify(W.R));
  });

  await group("rebuilds", async () => {
    // data rebuilds stand down quietly: name == VN, a name that carries VN, a versionCode not above the highest, a renamed release built from VN
    for (const [name, tracks, o] of [
      ["name == VN", [...PROD_132.slice(0, 1), { track: "alpha", releases: [{ name: "1.33", versionCodes: ["109"], status: "completed" }] }], {}],
      ["name carries VN", [{ track: "production", releases: [{ name: "109 (1.33)", versionCodes: ["109"], status: "completed" }] }], {}],
      ["versionCode not above", [...PROD_132.slice(0, 1), { track: "internal", releases: [{ name: "x", versionCodes: ["110"], status: "completed" }] }], {}],
      ["renamed, built from VN", [...PROD_132.slice(0, 1), { track: "beta", releases: [{ name: "Release seven", versionCodes: ["109"], status: "completed" }] }], { builds: [B(108, SHA_OLD, "1.32", TPL), B(109, SHA_109, "1.33", TPL), B(110, SHA, "1.33", N133)] }]]) {
      W = await run({ tracks, ...o });
      ok(W.code === 0 && W.R.code === "rebuild" && W.R.release === false && W.outputs.tell === "false", `rebuild (${name}): ${JSON.stringify(W.R)}`);
      ok(playWrites(W).length === 0 && W.edits.size === 0, `rebuild (${name}): only the throwaway edit`);
    }
    ok(!carries("1.330", "1.33") && !carries("11.33", "1.33") && carries("לוחית 1.33", "1.33") && carries("110 (1.33)", "1.33") && !carries("1.3", "1.30"), "carries: version tokens");
    W = await run({}, { PLAY_RESULT: pack({ release: false, tell: false, code: "rebuild" }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    ok(W.code === 0 && W.tg.length === 0 && W.calls.length === 0, "rebuild: the summary of a non-release sends nothing");
  });

  await group("notes", async () => {
    // release notes: stale, missing, empty, format, too long -> nothing uploaded; the build that changed APP_VERSION tells it
    for (const [why, notes] of [["stale", "# 1.32\n• ישן"], ["missing", null], ["empty", "# 1.33\n# only a comment\n"], ["format", "1.33\n• x"], ["long", "# 1.33\n" + "א".repeat(501)]]) {
      W = await run({ notes });
      ok(W.R.code === "notes" && W.R.notes === why && W.R.release === true && W.R.tell === true, `notes ${why}: ${JSON.stringify(W.R)}`);
      ok(playWrites(W).length === 0 && !W.calls.some(x => x.url.startsWith("https://storage.example/2")), `notes ${why}: no upload, aab not even downloaded`);
    }
    W = await run({ notes: "# 1.32\n• ישן", mainNotes: `# 1.33\n${HE}` }, { EVENT: "workflow_dispatch" });
    ok(W.R.code === "uploaded", "notes: a manual re-run reads the fixed notes on main " + JSON.stringify(W.R));
    W = await run({ notes: "# 1.32\n• ישן", mainNotes: `# 1.33\n${HE}` });
    ok(W.R.code === "notes", "notes: an automatic run reads the build's commit only");
    // Hebrew is counted in characters, not bytes: 500 letters (1000 bytes) pass, 501 do not
    const he500 = "# 1.33\n" + "ש".repeat(500);
    ok(parseNotes(he500, "1.33").ok && parseNotes(he500, "1.33").n === 500 && Buffer.byteLength("ש".repeat(500)) === 1000 && parseNotes(he500 + "ש", "1.33").code === "long", "notes: 500 Hebrew characters");
    ok(chars("• תיקון 🚗") === 9 && parseNotes("﻿# 1.33\r\n• א\r\n", "1.33").text === "• א", "notes: BOM, CRLF, emoji");
    W = await run({ notes: he500 });
    ok(W.R.code === "uploaded" && J(W.calls.find(x => x.method === "PUT").body).releases[0].releaseNotes[0].text.length === 500, "notes: 500 Hebrew characters upload");
  });

  await group("production guard", async () => {
    // production can never be touched: every way in is refused before any request
    const ctx = { pkg: PKG, dry: false, token: TOKEN };
    IO.fetch = async () => { throw new Error("must not be called"); };
    for (const tr of ["production", "beta", "internal", "Alpha", "alpha ", "alpha/../production", "alpha%2F..%2Fproduction"]) {
      let e = null; try { await updateTrack(ctx, "e1", tr, [{ name: "x", versionCodes: ["1"], status: "completed" }]); } catch (x) { e = x; }
      ok(e instanceof Fail && e.status === -1, "updateTrack refuses " + tr);
    }
    for (const [m, p] of [["PUT", `${PKGP}/e1/tracks/production`], ["PATCH", `${PKGP}/e1/tracks/production`], ["PATCH", `${PKGP}/e1/tracks/alpha`], ["POST", `${PKGP}/e1/tracks/production`],
      ["PUT", `${PKGP}/e1/tracks/alpha/../production`], ["PUT", `${PKGP}/e1/tracks/alpha%2F..%2Fproduction`], ["PUT", `${PKGP}/e1/tracks/production?x=/tracks/alpha`],
      ["PUT", `${PKGP}/e1/tracks/ALPHA`], ["POST", `${PKGP}/e1/apks`], ["DELETE", `${PKGP}/e1/tracks/production`]]) {
      ok(!allowed(m, PLAY + p, false), `allowed() refuses ${m} ${p}`);
    }
    ok(allowed("PUT", `${PLAY}${PKGP}/e1/tracks/alpha`, false) && allowed("POST", `${PLAY}${PKGP}/e1:commit`, false), "allowed() lets the alpha path through");
    let e2 = null; try { await play(ctx, "PUT", `${PKGP}/e1/tracks/production`, { json: {} }); } catch (x) { e2 = x; }
    ok(e2 instanceof Fail && e2.status === -1, "play() refuses production without a request");
    const src = fs.readFileSync(new URL(import.meta.url), "utf8");
    ok(!/tracks\/\$\{(?!track\}|TRACK\})|["'`]production["'`]\s*[,)]/.test(src.split("// ---- selftest")[0]), "source: no other track is ever named in a call");
  });

  await group("dry", async () => {
    // dry mode: the alpha track is written back unchanged inside a throwaway edit (the release permission), validated, deleted;
    // never an upload or a commit, and the guard refuses both even when asked
    W = await run({}, { MODE: "dry" });
    ok(W.R.code === "dry" && W.R.release === true && W.R.n === chars(HE) && W.R.checked === "permission", "dry: " + JSON.stringify(W.R));
    ok(playWrites(W).join() === `PUT ${PKGP}/E/tracks/alpha,POST ${PKGP}/E:validate` && W.edits.size === 0 && !W.calls.some(x => x.url.startsWith("https://storage.example/2")), "dry: alpha as is + validate, edit deleted, aab untouched " + playWrites(W));
    ok(JSON.stringify(J(W.calls.find(x => x.method === "PUT").body)) === JSON.stringify({ track: "alpha", releases: PROD_132[1].releases }), "dry: the alpha track is written back exactly as Play listed it");
    ok(!uploaded(W) && W.tracks.find(t => t.track === "alpha").releases[0].name === "1.32", "dry: nothing committed");
    ok(!allowed("POST", `${PLAY}${PKGP}/e1:commit`, true) && !allowed("POST", `${PLAY}/upload${PKGP}/e1/bundles?uploadType=media`, true), "dry: guard refuses commit and upload");
    W = await run({ tracks: [PROD_132[0], { track: "alpha", releases: [] }] }, { MODE: "dry" });
    ok(W.R.code === "dry" && W.R.checked === "access" && playWrites(W).join() === `POST ${PKGP}/E:validate`, "dry: an empty alpha track is not written, and the message says so");
    ok(/לא ההרשאה ל-Alpha/.test(compose({ ...W.R }, null, { ok: true }, {}).text), "dry message: says the permission was not checked");
    W = await run({ fail: { track: [{ status: 403, msg: "The caller does not have permission" }] } }, { MODE: "dry" });
    ok(W.R.code === "error" && W.R.next.includes(PERM), "dry: a missing release permission is caught by a dry run");
    W = await run({}, { MODE: "maybe" });
    ok(W.R.code === "dry", "dry: any MODE but on is dry");
  });

  await group("retries", async () => {
    // retries: 5xx and 429 are retried with backoff, 4xx are not and say what to do
    W = await run({ fail: { upload: [503, { status: 429, headers: { "retry-after": "1" } }, 502] } });
    ok(W.R.code === "uploaded" && W.calls.filter(x => x.url.includes("/bundles")).length === 4, "retry: upload after 503, 429, 502");
    W = await run({ fail: { upload: [500, 500, 500, 500] } });
    ok(W.R.code === "error" && W.R.stage === "upload" && W.calls.filter(x => x.url.includes("/bundles")).length === 4 && /ניסיונות/.test(W.R.why) && W.edits.size === 0, "retry: gives up after 4, edit dropped");
    W = await run({ fail: { track: [{ status: 403, msg: "The caller does not have permission" }] } });
    ok(W.R.code === "error" && W.calls.filter(x => x.method === "PUT").length === 1 && W.R.next.includes(PERM) && !W.writes.some(w => w.endsWith(":commit")), "403: no retry, names the permission");
    W = await run({ fail: { commit: [{ status: 400, msg: "Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true." }] } });
    ok(W.R.code === "error" && /סקירה/.test(W.R.why) && /Publishing overview/.test(W.R.next), "commit 400: previous change in review");
    W = await run({ fail: { commit: [{ status: 400, msg: "APK specifies a version code that has already been used." }] } });
    ok(W.R.code === "error" && /110/.test(W.R.why), "versionCode already used");
    W = await run({ fail: { commit: [503, 503, 503, 503] }, commitLands: true });
    ok(W.R.code === "uploaded", "commit: no answer, but alpha holds the build -> uploaded");
    W = await run({ fail: { list: [{ status: 403, msg: "Google Play Android Developer API has not been used in project 1 before or it is disabled" }] } });
    ok(W.R.code === "error" && W.R.stage === "decide" && W.R.tell === true && /API/.test(W.R.why), "decide: API disabled is reported on the build that changed APP_VERSION");
    W = await run({ fail: { token: [{ status: 400, body: { error: "invalid_grant" } }] } });
    ok(W.R.code === "error" && W.R.stage === "decide" && W.R.next.includes(SECRET), "token refused");
  });

  await group("inputs", async () => {
    W = await run({ version: `versionCode=110\nversionName=1.33\ncommit=${SHA}\n` });
    ok(W.R.code === "error" && /חתומה/.test(W.R.why) && playWrites(W).length === 0, "unsigned build is not uploaded");
    W = await run({ readCode: 111 });
    ok(W.R.code === "error" && !W.writes.some(w => w.endsWith(":commit")), "versionCode read back differs -> no commit");
    W = await run({}, { [SECRET]: "" });
    ok(W.code === 0 && W.R.code === "nosecret" && W.calls.length === 0 && W.printed.filter(l => l.startsWith("::notice::")).length === 1, "no secret: one notice, no calls");
    W = await run({}, { BUILD: "109" });
    ok(W.code === 0 && W.R.code === "superseded" && playWrites(W).length === 0 && W.R.tell === false, "older build's draft gone: stands down");
    W = await run({}, { BUILD: "109", EVENT: "workflow_dispatch" });
    ok(W.code === 1 && W.R.code === "no-build" && /build-110/.test(W.R.why), "manual run, missing build: red, names the newest");
    W = await run({}, { BUILD: "", EVENT: "workflow_dispatch" });
    ok(W.R.code === "uploaded" && W.R.vc === 110, "manual run without build: newest draft");
    W = await run({}, { BUILD: "11; rm" });
    ok(W.R.code === "no-build" && W.calls.length === 0, "build input must be a number");
  });

  await group("hole 1: Play unreadable", async () => {
    // a data rebuild (APP_VERSION as on the previous build on main) while Play cannot be read: a warning, no Telegram, no upload
    const rb = [B(108, SHA_OLD, "1.32", TPL), B(109, SHA_109, "1.32", TPL), B(111, SHA_111, "1.32", TPL), B(112, SHA_112, "1.32", TPL)];
    let n = 0;
    for (const [b, sha] of [[111, SHA_111], [112, SHA_112]]) {
      const P = await pipeline({ builds: rb, draft: { n: b, vn: "1.32", sha }, fail: { list: [{ status: 403, msg: "The caller does not have permission" }] } }, { BUILD: String(b), HEAD_SHA: sha });
      n += P.tg;
      ok(P.R?.code === "error" && P.R.stage === "decide" && P.R.tell === false && warned(P.W) && !uploaded(P.W), `hole 1: rebuild ${b}, Play 403 -> quiet warning ` + JSON.stringify(P.R));
    }
    ok(n === 0, `hole 1: two data rebuilds while Play is unreadable -> no Telegram (got ${n})`);
    // the build that changes APP_VERSION is told, once, and names the version
    let P = await pipeline({ fail: { list: [{ status: 403, msg: "The caller does not have permission" }] } });
    ok(P.tg === 1 && /לוחית 1\.33/.test(P.texts[0]) && P.texts[0].includes(PERM), "hole 1: the build that changed APP_VERSION is told " + P.texts[0]);
    // the previous build is not known (GitHub's runs list fails): told, rather than a release going untold
    P = await pipeline({ builds: rb, draft: { n: 111, vn: "1.32", sha: SHA_111 }, fail: { list: [403], runs: [500, 500, 500, 500] } }, { BUILD: "111", HEAD_SHA: SHA_111 });
    ok(P.tg === 1, "hole 1: previous build not known -> told");
    // a manual run always reports
    P = await pipeline({ builds: rb, draft: { n: 111, vn: "1.32", sha: SHA_111 }, fail: { list: [403] } }, { BUILD: "111", HEAD_SHA: SHA_111, EVENT: "workflow_dispatch" });
    ok(P.tg === 1, "hole 1: a manual run is told");
  });

  await group("hole 2: a waiting release is told once", async () => {
    // SHIP_TAIL=dry: main is on 1.33, Play on 1.32; the build that changed APP_VERSION is told, the next builds of 1.33 are not
    const db = [B(108, SHA_OLD, "1.32", TPL), B(109, SHA_109, "1.32", TPL), B(110, SHA, "1.33", N133), B(111, SHA_111, "1.33", N133), B(112, SHA_112, "1.33", N133)];
    let n = 0;
    for (const [b, sha] of [[110, SHA], [111, SHA_111], [112, SHA_112]]) {
      const P = await pipeline({ builds: db, draft: { n: b, vn: "1.33", sha } }, { MODE: "dry", SHIP_TAIL: "dry", BUILD: String(b), HEAD_SHA: sha });
      n += P.tg;
      ok(P.R?.code === "dry" && !uploaded(P.W), `hole 2: dry ${b} ` + JSON.stringify(P.R));
    }
    ok(n === 1, `hole 2: three dry builds of one version -> one Telegram (got ${n})`);
    // Play on 1.29 (built as 100), main on 1.32, the notes template says 1.33: builds that change nothing are quiet
    const t8 = [B(100, SHA_100, "1.29", null), B(112, SHA_112, "1.32", TPL), B(113, SHA_113, "1.32", TPL), B(114, SHA_114, "1.32", TPL), B(115, SHA_115, "1.32", "# 1.33\n• טיוטה לגרסה הבאה\n")];
    const p129 = [{ track: "production", releases: [{ name: "1.29", versionCodes: ["100"], status: "completed" }] }];
    n = 0;
    for (const [b, sha] of [[113, SHA_113], [114, SHA_114]]) {
      const P = await pipeline({ builds: t8, tracks: p129, draft: { n: b, vn: "1.32", sha } }, { BUILD: String(b), HEAD_SHA: sha });
      n += P.tg;
      ok(P.R?.code === "notes" && P.R.notes === "stale" && P.R.tell === false && !uploaded(P.W), `hole 2: notes ${b} ` + JSON.stringify(P.R));
    }
    ok(n === 0, `hole 2: stale notes on builds that change nothing -> no Telegram (got ${n})`);
    // a build that changes the notes (still not for 1.32) is told
    let P = await pipeline({ builds: t8, tracks: p129, draft: { n: 115, vn: "1.32", sha: SHA_115 } }, { BUILD: "115", HEAD_SHA: SHA_115 });
    ok(P.tg === 1 && /בקובץ כתוב 1\.33/.test(P.texts[0]), "hole 2: a build that changed the notes is told");
    // a build that overlapped the previous one (which may never have been told) compares one build further back
    const ov = [B(109, SHA_109, "1.32", TPL, { s: 0, e: 10 }), B(110, SHA, "1.33", TPL, { s: 20, e: 31 }), B(111, SHA_111, "1.33", TPL, { s: 22, e: 32 })];
    P = await pipeline({ builds: ov, draft: { n: 111, vn: "1.33", sha: SHA_111 } }, { BUILD: "111", HEAD_SHA: SHA_111 });
    ok(P.R?.code === "notes" && P.R.notes === "empty" && P.tg === 1, "hole 2: overlapping builds -> compared with the build before both, told " + JSON.stringify(P.R));
    // an upload error on a build that changes nothing is not repeated either
    P = await pipeline({ builds: db, draft: { n: 111, vn: "1.33", sha: SHA_111 }, fail: { commit: [{ status: 400, msg: "Changes are under review" }] } }, { BUILD: "111", HEAD_SHA: SHA_111 });
    ok(P.R?.code === "error" && P.R.stage === "upload" && P.tg === 0 && warned(P.W), "hole 2: a repeated upload error is quiet " + JSON.stringify(P.R));
  });

  await group("hole 3: fail closed", async () => {
    // (a) the GitHub runs list fails: a name that carries the version still settles it; a name that does not stops the upload
    const fb = [B(108, SHA_OLD, "1.32", TPL), B(110, SHA, "1.33", N133), B(111, SHA_111, "1.33", N133)];
    for (const name of ["v1.33", "1.33.0", "Recalls update"]) {
      const tracks = [PROD_132[0], { track: "alpha", releases: [{ name, versionCodes: ["110"], status: "completed" }] }];
      W = await run({ builds: fb, tracks, draft: { n: 111, vn: "1.33", sha: SHA_111 }, fail: { runs: [403, 403, 403] } }, { BUILD: "111", HEAD_SHA: SHA_111 });
      ok(!uploaded(W) && ["rebuild", "error"].includes(W.R?.code), `hole 3a: alpha "${name}", runs API 403 -> not uploaded ` + JSON.stringify(W.R));
      W = await run({ builds: fb, tracks, draft: { n: 111, vn: "1.33", sha: SHA_111 } }, { BUILD: "111", HEAD_SHA: SHA_111 });
      ok(W.R?.code === "rebuild" && !uploaded(W), `hole 3a: alpha "${name}", runs API ok -> rebuild ` + JSON.stringify(W.R));
    }
    ok(carries("v1.33", "1.33") && carries("1.33.0", "1.33") && !carries("1.33.1", "1.33"), "hole 3a: carries v1.33 and 1.33.0");
    // (b) tracks.list answers 200 without tracks, or with none: not a picture of Play to act on
    for (const listBody of [{}, { tracks: [] }]) {
      W = await run({ listBody });
      ok(W.R?.code === "error" && W.R.stage === "decide" && !uploaded(W), "hole 3b: tracks.list " + JSON.stringify(listBody) + " -> not uploaded " + JSON.stringify(W.R));
    }
    // (c) the newest build on Play is not known (no version in its name, its run not in the history): not uploaded
    W = await run({ tracks: [{ track: "production", releases: [{ name: "Launch", versionCodes: ["90"], status: "completed" }] }] });
    ok(W.R?.code === "error" && W.R.stage === "decide" && !uploaded(W), "hole 3c: newest on Play unknown -> not uploaded " + JSON.stringify(W.R));
    // (d) the build is older than Play's newest (APP_VERSION went back on main): not uploaded
    W = await run({ tracks: [{ track: "production", releases: [{ name: "Release", versionCodes: ["109"], status: "completed" }] }], builds: [B(109, SHA_109, "1.34", TPL), B(110, SHA, "1.33", N133)] });
    ok(W.R?.code === "rebuild" && !uploaded(W), "hole 3d: lower than Play's newest -> not uploaded " + JSON.stringify(W.R));
    ok(cmpVersion("1.10", "1.9") === 1 && cmpVersion("1.33.0", "1.33") === 0 && cmpVersion("1.3", "1.30") === -1, "hole 3: version order");
  });

  await group("hole 4: main only", async () => {
    // a manual run on another branch runs nothing
    const g = gate({ SHIP_TAIL: "", EVENT: "workflow_dispatch", INPUT_MODE: "on", INPUT_STEP: "all", REF: "refs/heads/next" });
    ok(!g.play && !g.ga4 && g.notes.some(x => /main only/.test(x)), "hole 4: gate refuses a manual run on next " + JSON.stringify(g));
    // the newest draft was built from next: a manual run on main refuses it before Play is touched
    const nb = [B(108, SHA_OLD, "1.32", TPL), B(110, SHA, "1.33", N133), B(120, SHA_NEXT, "1.34", "# 1.34\n• טיוטה מ-next\n", { branch: "next" })];
    W = await run({ builds: nb, draft: { n: 120, vn: "1.34", sha: SHA_NEXT }, tracks: [PROD_132[0], { track: "alpha", releases: [{ name: "1.33", versionCodes: ["110"], status: "completed" }] }] },
      { BUILD: "", EVENT: "workflow_dispatch", HEAD_SHA: S("d") });
    ok(W.R?.code === "not-main" && W.code === 1 && !W.calls.some(x => new URL(x.url).origin === PLAY) && !uploaded(W), "hole 4: draft from next -> refused " + JSON.stringify(W.R));
    W = await run({}, { BUILD: "", EVENT: "workflow_dispatch", HEAD_SHA: S("d") });
    ok(W.R?.code === "uploaded" && W.calls.some(x => x.url.includes("/compare/main...")), "hole 4: a manual run checks the draft's commit against main and goes on");
  });

  await group("hole 5: GitHub errors are reported", async () => {
    const rb = [B(110, SHA, "1.33", N133), B(111, SHA_111, "1.33", N133)];
    for (const [label, o] of [["releases 403", { fail: { releases: [403] } }], ["releases 200 not a list", { releases: { message: "odd" } }]]) {
      W = await run({ builds: rb, draft: { n: 111, vn: "1.33", sha: SHA_111 }, ...o }, { BUILD: "111", HEAD_SHA: SHA_111 });
      ok(W.code === 0 && W.R?.code === "error" && W.R.stage === "github" && W.R.tell === false && warned(W) && W.outputs.tell === "false", `hole 5: ${label}, a build that changed nothing -> quiet ` + JSON.stringify(W.R));
    }
    const P = await pipeline({ fail: { releases: [403] } }, { EVENT: "workflow_dispatch" });
    ok(P.R?.code === "error" && P.tg === 1 && /GitHub/.test(P.texts[0]), "hole 5: a manual run is told " + JSON.stringify(P.R));
  });

  await group("hole 6: a broken key", async () => {
    // set but not a key: an error the build that changed APP_VERSION tells, not a silent skip
    let P = await pipeline({}, { [SECRET]: "{not json" });
    ok(P.R?.code === "error" && P.R.stage === "secret" && P.tg === 1 && P.texts[0].includes(SECRET), "hole 6: broken key on a release build -> told " + JSON.stringify(P.R));
    const rb = [B(110, SHA, "1.33", N133), B(111, SHA_111, "1.33", N133)];
    P = await pipeline({ builds: rb, draft: { n: 111, vn: "1.33", sha: SHA_111 } }, { [SECRET]: '"{\\"type\\": \\"service_account\\"}"', BUILD: "111", HEAD_SHA: SHA_111 });
    ok(P.R?.code === "error" && P.R.stage === "secret" && P.tg === 0 && warned(P.W), "hole 6: broken key on a build that changed nothing -> warning only " + JSON.stringify(P.R));
    ok(!P.W.calls.some(x => new URL(x.url).origin === PLAY || x.url === TOKEN_URL), "hole 6: a broken key never reaches Google");
  });

  await group("hole 8: the deadline", async () => {
    // each upload try takes 7 minutes and fails: the step stops inside its budget, reports, and drops the edit
    W = await run({ took: { upload: 7 }, fail: { upload: [503, 503, 503, 503] } });
    const ups = W.calls.filter(x => x.url.includes("/bundles"));
    ok(W.R?.code === "error" && W.R.stage === "upload" && ups.length < 4 && ups.every(x => x.at < W.t0 + BUDGET_MS), `hole 8: ${ups.length} tries inside the budget ` + JSON.stringify(W.R));
    ok(W.edits.size === 0 && W.outputs.result, "hole 8: edit dropped, result written");
    const yml = (() => { try { return fs.readFileSync(new URL("../workflows/ship-tail.yml", import.meta.url), "utf8"); } catch { return ""; } })();
    if (yml) {
      const job = yml.split(/\n {2}play:\n/)[1]?.split(/\n {2}\w+:\n/)[0] || "";
      ok(+(/timeout-minutes: (\d+)/.exec(job)?.[1] || 0) >= BUDGET_MS / MIN + 10, "hole 8: the play job's timeout-minutes leaves room for setup and cleanup after the budget");
    }
  });

  await group("hole 9 and the workflow", async () => {
    const yml = (() => { try { return fs.readFileSync(new URL("../workflows/ship-tail.yml", import.meta.url), "utf8"); } catch { return null; } })();
    if (yml == null) return;
    ok((yml.match(/secrets\.SHIP_SA_JSON/g) || []).length === 2 && !/secrets\.(GA_SERVICE_ACCOUNT_JSON|PLAY_SA_JSON|PLAY_SERVICE_ACCOUNT_JSON)/.test(yml), "hole 9: one dedicated key, SHIP_SA_JSON, for the play and ga4 jobs only");
    ok(/REF: \$\{\{ github\.ref \}\}/.test(yml), "hole 4: the gate gets github.ref");
    ok(/needs\.play\.outputs\.tell == 'true'/.test(yml) && !/outputs\.release/.test(yml), "the ga4 and summary jobs follow the tell output");
  });

  await group("nits", async () => {
    ok(PERM_READ === "View app information and download bulk reports (read-only)", "the Play Console permission is named as the console names it");
    ok(gate({ SHIP_TAIL: "false", REF: "refs/heads/main", EVENT: "push" }).mode === "off" && gate({ SHIP_TAIL: "0", REF: "refs/heads/main", EVENT: "workflow_run", RUN_CONCLUSION: "success", RUN_BRANCH: "main" }).play === false, "SHIP_TAIL false/0 is off");
    // outputs survive the runner's masking of a multi-line key: no line of the key file appears in them
    W = await run();
    const keyLines = SA_FILE.split("\n").map(l => l.trim()).filter(Boolean);
    ok(W.outputs.result && !keyLines.some(l => W.outputs.result.includes(l)) && unpack(W.outputs.result)?.code === "uploaded", "outputs: no line of the key in the result output");
    // a Telegram send that timed out is not sent again
    W = await run({ tgTimeout: true }, { PLAY_RESULT: pack({ release: true, tell: true, code: "uploaded", vn: "1.33", vc: 110, sha: SHA }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    ok(W.tgTries === 1, "telegram: no second send after a timeout (" + W.tgTries + ")");
    // the AAB went away between the steps (a newer build deleted the draft): stands down quietly, the newer run uploads
    W = await run({ fail: { aab: [404] } });
    ok(W.R?.code === "superseded" && W.R.tell === false && !uploaded(W), "draft deleted mid-run -> superseded " + JSON.stringify(W.R));
    // the job summary of a public repository carries no Play Console developer/app ids
    W = await run({}, { PLAY_RESULT: pack({ release: true, tell: true, code: "uploaded", vn: "1.33", vc: 110, sha: SHA }), PLAY_DEVELOPER_ID: "5551234", PLAY_APP_ID: "4447777" }, ["summary"]);
    ok(W.sums.length && !W.sums.join("\n").includes("5551234") && !W.sums.join("\n").includes("4447777"), "job summary: no developer or app id");
  });

  await group("messages", async () => {
    const runsOk = { ok: true, smoke: { status: "completed", conclusion: "success" }, workers: { status: "completed", conclusion: "success" } };
    let m = compose({ code: "uploaded", vn: "1.33", vc: 110 }, { code: "ok" }, runsOk, { PLAY_DEVELOPER_ID: "1", PLAY_APP_ID: "2" });
    ok(m.text.startsWith("<b>✅ בוצע · אפליקציה</b>\n<b>לוחית 1.33 עלתה ל-Alpha ונשלחה לבדיקה של גוגל</b>\nאתר ✓ · Workers ✓ · GA4 ✓.") && m.text.includes('href="https://play.google.com/console/developers/1/app/2/')
      && /<blockquote expandable>[^]*versionCode 110/.test(m.text) && m.key === "ship:done:1.33" && m.level === "day" && m.today === "silent", "message: uploaded\n" + m.text);
    m = compose({ code: "uploaded", vn: "1.33", vc: 110 }, { code: "needs-editor", why: "לחשבון השירות אין תפקיד Editor בנכס GA4", next: "x" }, { ok: true, smoke: { status: "in_progress" } }, {});
    ok(/אתר: עוד רץ · GA4: חסר תפקיד Editor\./.test(m.text) && !/Workers/.test(m.text) && m.text.includes("GA4: לחשבון השירות אין תפקיד Editor בנכס GA4. x."), "message: smoke still running, no Workers run, GA4 403\n" + m.text);
    m = compose({ code: "notes", notes: "stale", got: "1.32", vn: "1.33", vc: 110 }, null, { ok: true }, {});
    ok(m.key === "ship:notes:1.33" && /מחכה להערות שחרור \(בקובץ כתוב 1\.32\)/.test(m.text) && /# 1\.33/.test(m.text) && /build=110/.test(m.text), "message: notes\n" + m.text);
    m = compose({ code: "error", stage: "upload", vn: "1.33", vc: 110, why: "w", next: "n" }, { code: "error", why: "g" }, { ok: true, smoke: { status: "completed", conclusion: "failure", html_url: "https://github.com/x/1" } }, { RUN_URL: "https://github.com/r/2" });
    ok(m.key === "ship:fail:1.33" && /נכשלה<\/b>\nw\./.test(m.text) && /^<b>🟠 לטיפול היום · אפליקציה<\/b>/.test(m.text) && /אתר ✗/.test(m.text) && /GA4 ✗/.test(m.text) && m.text.includes("https://github.com/x/1") && m.text.includes("https://github.com/r/2"), "message: failure\n" + m.text);
    m = compose({ code: "dry", vn: "1.33", vc: 110, n: 40, checked: "permission" }, null, { ok: true }, { SHIP_TAIL: "dry" });
    ok(/להפעיל את ההעלאה האוטומטית/.test(m.text) && /<blockquote expandable>[^]*SHIP_TAIL=dry/.test(m.text) && m.key === "ship:dry:1.33" && /לא ההעלאה עצמה/.test(m.text), "message: dry under SHIP_TAIL=dry says to switch it, and what was checked\n" + m.text);
    m = compose({ code: "dry", vn: "1.33", vc: 110, n: 40 }, null, { ok: true }, {});
    ok(!/SHIP_TAIL/.test(m.text) && /mode=on, build=110/.test(m.text), "message: manual dry run says to run with mode=on\n" + m.text);
    m = compose({ code: "error", stage: "decide", vn: "1.33", vc: 110, why: "w", next: "n" }, null, { ok: true }, {});
    ok(m.key === "ship:fail:access", "message: access problems share one key");
    m = compose({ code: "error", stage: "github", vn: "", vc: 111, why: "w", next: "n" }, null, { ok: true }, {});
    ok(m.key === "ship:fail:github" && /בניית האנדרואיד 111/.test(m.text) && /build=111/.test(m.text), "message: GitHub stage\n" + m.text);
    for (const P of [{ code: "uploaded" }, { code: "dry", n: 40 }, { code: "notes", notes: "long", n: 600 }, { code: "error", why: "w", next: "n" }, { code: "error", stage: "secret", why: "w", next: "n" }]) {
      const t = compose({ vn: "1.33", vc: 110, ...P }, { code: "created" }, runsOk, {}).text;
      ok(!/[—–]/.test(t) && t.length < 900, "message: no em-dash, short: " + P.code);
    }
    // summary end to end through alert.mjs (shadow: the direct send), and with a fake router
    const headRuns = [{ name: SMOKE_WF, status: "completed", conclusion: "success", created_at: "2026-10-18T10:00:00Z" }, { name: WORKERS_WF, status: "completed", conclusion: "success", created_at: "2026-10-18T10:01:00Z" }];
    const PR = pack({ release: true, tell: true, code: "uploaded", vn: "1.33", vc: 110, sha: SHA });
    W = await run({ headRuns }, { PLAY_RESULT: PR, GA4_RESULT: pack({ code: "ok" }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    ok(W.code === 0 && W.tg.length === 1 && /אתר ✓ · Workers ✓ · GA4 ✓/.test(W.tg[0].text), "summary: one Telegram " + JSON.stringify(W.tg));
    const seen = [];
    IO.router = { alert: async (lv, key, text, link, o) => { seen.push({ lv, key, o }); return { delivered: true }; } };
    W = await run({ headRuns }, { PLAY_RESULT: PR, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42", EVENT: "workflow_dispatch" }, ["summary"]);
    ok(seen.length === 1 && seen[0].lv === "day" && seen[0].key === "ship:done:1.33" && !seen[0].o.plain && seen[0].o.today === "silent" && seen[0].o.fresh && W.tg.length === 0, "summary: through the router, fresh on a manual run");
    // an upload closes the Ship tail failures before it; a failed one leaves them open
    const settled = [];
    IO.router = { alert: async () => ({ delivered: true }), resolve: async p => { settled.push(p.join("|")); return 1; } };
    W = await run({ headRuns }, { PLAY_RESULT: PR, TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    W = await run({}, { PLAY_RESULT: pack({ release: true, tell: true, code: "error", stage: "upload", vn: "1.33", vc: 110, sha: SHA, why: "w", next: "n" }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    ok(settled.join() === "ship:fail:", "summary: only an upload closes the Ship tail failures " + settled);
    IO.router = null;
    W = await run({}, { PLAY_RESULT: PR, TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" }, ["summary"]);
    ok(W.code === 0 && W.tg.length === 0 && W.printed.filter(l => l.startsWith("::notice::")).length === 1, "summary: no Telegram secrets -> one notice");
    W = await run({}, { PLAY_RESULT: pack({ release: true, tell: false, code: "notes", vn: "1.33", vc: 111 }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]);
    ok(W.tg.length === 0, "summary: a result that is not to be told sends nothing");
  });

  await group("secrets", async () => {
    // secrets never printed: not in stdout, step outputs (decoded too), job summary or the Telegram text, on any path
    const pemBody = PEM.split("\n").slice(2, 4).join("");
    const leak = W2 => [...W2.printed, ...Object.values(W2.outputs), JSON.stringify(W2.R || {}), ...W2.sums, ...W2.tg.map(x => x.text)].join("\n");
    const headRuns = [{ name: SMOKE_WF, status: "completed", conclusion: "success", created_at: "2026-10-18T10:00:00Z" }];
    for (const [o, env, argv] of [[{}, {}, []], [{}, { MODE: "dry" }, []], [{ fail: { token: [400] } }, {}, []], [{ fail: { upload: [{ status: 400, msg: "bad" }] } }, {}, []],
      [{ notes: null }, {}, []], [{ headRuns }, { PLAY_RESULT: pack({ release: true, tell: true, code: "uploaded", vn: "1.33", vc: 110, sha: SHA }), TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42" }, ["summary"]],
      [{}, { [SECRET]: JSON.stringify({ ...SA, private_key: "broken" }) }, []], [{}, { [SECRET]: "{not json" }, []], [{ fail: { releases: [403] } }, {}, []]]) {
      W = await run(o, env, argv);
      const all = leak(W);
      ok(![pemBody, TOKEN, TG, GHT, "PRIVATE KEY", SA.client_email].some(x => all.includes(x)), "secrets stay out of the output: " + JSON.stringify(o) + JSON.stringify(env).slice(0, 40));
    }
  });

  Object.assign(IO, saved); globalThis.fetch = realFetch;
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("play-alpha.mjs")) process.exit(await cli(process.argv.slice(2)));
