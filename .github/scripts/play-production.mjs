// Ship tail, Production part. Two commands, one rule: production only ever gets the build that is already on Alpha, and only after the
// owner's word.
//   promote (production.yml, run by hand: the owner's "פרסם" in the release thread, or Actions → Production → Run workflow): copies the
//     newest Alpha release (its build, name and Hebrew notes) to the production track as a staged rollout to 20% of users, and sends it for
//     review. The first production release goes to all users (Google allows no staged rollout for it; the countries are set once in Play
//     Console). Never a version that is not above the one on Production, never over a rollout that is still running.
//   auto (release-watch.yml, after the watch): nothing while Google still reviews the rollout (Play's release lifecycle state). Once it is
//     published: a crash or ANR that is NEW in its build (found by the watch after the rollout was sent) halts it at once; 48 hours after
//     it was first seen published with no such issue, it goes to 100%. The first look at it published sends one Telegram and starts the 48 h
//     (state.live in the watch's watch.json).
// Every write is checked against these rules before the request leaves the machine (track, build, status, fraction), and read back after
// the commit. When Play does not answer clearly, nothing is committed (fail closed). Each step sends one Telegram (alert.mjs).
// Node 20, node: builtins only. Commands:
//   node play-production.mjs gate      SHIP_TAIL, EVENT, REF, INPUT_MODE -> output mode (on|dry|off)
//   node play-production.mjs promote   SHIP_SA_JSON, MODE (on|dry), EVENT, RUN_URL
//   node play-production.mjs auto      SHIP_SA_JSON, MODE (on|dry), STATE (the watch's watch.json; mode on writes state.live back)
//   node play-production.mjs selftest  offline (mocked fetch, virtual clock)
import fs from "node:fs";
import crypto from "node:crypto";
import { jwt, Fail, playFail, gate, PKG, SECRET, TRACK as ALPHA } from "./play-alpha.mjs";

export const PROD = "production", FRACTION = 0.2, FULL_AFTER_H = 48;   // the only track written here, and the only first fraction
export const PERM_PROD = "Release to production, exclude devices, and use Play App Signing";
export const BUDGET_MS = 10 * 60000;
const PLAY = "https://androidpublisher.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const HOUR = 36e5, DAY = 24 * HOUR, KEEP_D = 30;

const IO = {
  env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), deadline: 0, router: null,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
  read: p => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }, write: (p, s) => fs.writeFileSync(p, s),
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const note = s => IO.out("::notice::" + s);
const tag = s => crypto.createHash("sha1").update(String(s)).digest("hex").slice(0, 12).replace(/^\d/, "a");
const codes = r => (r?.versionCodes || []).map(String);
const top = r => Math.max(0, ...codes(r).map(Number).filter(Number.isFinite));

// ---- gate: promote is a manual run only; on main it acts when mode=on and SHIP_TAIL allows; anywhere else it is dry ----
export function prodGate(env) {
  const g = gate({ ...env, REF: "refs/heads/main", INPUT_STEP: "play" }), notes = [...g.notes];
  if (g.mode === "off") return { mode: "off", notes };
  if (env.EVENT !== "workflow_dispatch") return { mode: "off", notes: [...notes, `event ${String(env.EVENT || "?").slice(0, 20)}: Production is never sent without a manual run`] };
  if (env.REF !== "refs/heads/main") return { mode: "dry", notes: [...notes, "not main: dry only"] };
  return { mode: g.mode, notes };
}

// ---- HTTP (Google's retry rule, as in play-alpha.mjs) ----
async function call(method, url, { headers = {}, body, timeout = 120000, cleanup = false, once = false } = {}) {
  for (let i = 0; ; i++) {
    const left = cleanup || !IO.deadline ? Infinity : IO.deadline - IO.now();
    if (left < 1000) return { status: 0, ok: false, text: "network: out of time" };
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), Math.min(cleanup ? 30000 : timeout, left));
    try {
      const r = await IO.fetch(url, { method, headers, body, signal: c.signal });
      res = { status: r.status, ok: r.ok, text: await r.text() };
    } catch (e) {
      const aborted = e?.name === "AbortError";
      res = { status: 0, ok: false, aborted, text: "network: " + (aborted ? "timeout" : String(e?.message || e).slice(0, 80)) };
    } finally { clearTimeout(t); }
    if ((res.status && res.status < 500 && res.status !== 429) || i === (cleanup ? 1 : 3) || (once && res.aborted)) return res;
    const wait = 2000 * 2 ** i;
    if (!cleanup && IO.deadline && IO.deadline - IO.now() < wait + 1000) return res;
    await IO.sleep(wait);
  }
}
async function accessToken(sa) {
  let assertion;
  try { assertion = jwt(sa, SCOPE, IO.now()); } catch { throw new Fail(`המפתח בסוד ${SECRET} לא תקין`, `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בשלמותו בסוד ${SECRET}`); }
  const r = await call("POST", TOKEN_URL, { headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const t = r.ok && J(r.text)?.access_token;
  if (t) return t;
  if (r.status === 400 || r.status === 401) throw new Fail("Google לא קיבל את מפתח חשבון השירות (נמחק, בוטל או הודבק חלקית)", `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בסוד ${SECRET}`, r.status);
  throw new Fail(`ההתחברות ל-Google לא הצליחה (${r.status || "אין חיבור"})`, "להריץ שוב בעוד כמה דקות", r.status);
}

// ---- Play: the only calls, and the only bodies, this script can send ----
const APP = "/androidpublisher/v3/applications/[\\w.]+/edits";
const ALLOWED = [
  ["POST", new RegExp(`^${APP}$`)],                               // edits.insert
  ["GET", new RegExp(`^${APP}/[\\w-]+/tracks$`)],                 // edits.tracks.list
  ["PUT", new RegExp(`^${APP}/[\\w-]+/tracks/${PROD}$`)],         // edits.tracks.update, production only
  ["POST", new RegExp(`^${APP}/[\\w-]+:(validate|commit)$`)],     // edits.validate, edits.commit
  ["DELETE", new RegExp(`^${APP}/[\\w-]+$`)],                     // edits.delete
  ["GET", new RegExp(`^/androidpublisher/v3/applications/[\\w.]+/tracks/(${ALPHA}|${PROD})/releases$`)],   // tracks.releases.list (review state)
];
export function allowed(method, url, dry) {
  let u; try { u = new URL(url); } catch { return false; }
  const raw = url.startsWith(PLAY + "/") ? url.slice(PLAY.length).split("?")[0] : "";
  if (u.origin !== PLAY || raw !== u.pathname) return false;
  if (dry && /:commit$/.test(raw)) return false;
  return ALLOWED.some(([m, re]) => m === method && re.test(raw));
}
// a production write is one release of one known build, in one of the shapes below; "same" = the live releases written back unchanged
// (the dry permission check). Anything else is refused before it is sent.
export function bodyOk(body, want) {
  if (body?.track !== PROD || !Array.isArray(body.releases)) return false;
  if (want.kind === "same") return JSON.stringify(body.releases) === JSON.stringify(want.releases);
  const [r] = body.releases;
  if (body.releases.length !== 1 || codes(r).join() !== want.codes.join() || !want.codes.length) return false;
  if (want.kind === "start") return r.status === "inProgress" && r.userFraction === FRACTION;
  if (want.kind === "halt") return r.status === "halted" && r.userFraction > 0 && r.userFraction < 1;
  if (want.kind === "full" || want.kind === "first") return r.status === "completed" && !("userFraction" in r);
  return false;
}
function prodFail(r) {
  if (r.status === 401 || r.status === 403) {
    const f = playFail(r);
    if (/ה-API של Google Play כבוי/.test(f.why)) return f;
    return Object.assign(new Fail("לחשבון השירות אין הרשאה ל-Production", `Play Console ← Users and permissions ← ship-tail ← App permissions ← לוחית: לסמן "${PERM_PROD}"`, r.status), { access: true });
  }
  return playFail(r);
}
async function play(ctx, method, p, { json, want, cleanup = false, read = false } = {}) {
  const url = PLAY + p;
  if (!allowed(method, url, ctx.dry)) throw new Fail(`refused: ${method} ${p.replace(/edits\/[\w-]+/, "edits/<id>")}`, "", -1);
  if (method === "PUT" && !bodyOk(json, want || {})) throw new Fail(`refused: a production write that is not ${want?.kind || "known"}`, "", -1);
  const r = await call(method, url, { headers: { authorization: "Bearer " + ctx.token, ...(json ? { "content-type": "application/json" } : {}) },
    body: json ? JSON.stringify(json) : undefined, cleanup });
  if (!r.ok) throw read ? playFail(r) : prodFail(r);
  return J(r.text) || {};
}
const EDITS = ctx => `/androidpublisher/v3/applications/${ctx.pkg}/edits`;
const insertEdit = async (ctx, cleanup = false) => (await play(ctx, "POST", EDITS(ctx), { json: {}, cleanup })).id;
const dropEdit = (ctx, id) => play(ctx, "DELETE", `${EDITS(ctx)}/${id}`, { cleanup: true }).catch(() => null);
async function listTracks(ctx, id, cleanup = false) {
  const t = (await play(ctx, "GET", `${EDITS(ctx)}/${id}/tracks`, { cleanup })).tracks;
  if (!Array.isArray(t)) throw new Fail("Google Play החזיר תשובה בלי רשימת מסלולים", "להריץ שוב בעוד כמה דקות");
  return t;
}
const releasesOf = (tracks, name) => tracks.find(t => t.track === name)?.releases || [];
// Play's review state of each release on a track: DRAFT, NOT_SENT_FOR_REVIEW, IN_REVIEW, APPROVED_NOT_PUBLISHED, NOT_APPROVED, PUBLISHED
async function lifecycle(ctx, track) {
  const list = (await play(ctx, "GET", `/androidpublisher/v3/applications/${ctx.pkg}/tracks/${track}/releases`, { read: true })).releases;
  if (!Array.isArray(list)) return [];
  return list.map(x => ({ name: String(x.releaseName || ""), vcs: (x.activeArtifacts || []).map(a => +a.versionCode).filter(Boolean),
    life: String(x.releaseLifecycleState || "").replace("RELEASE_LIFECYCLE_STATE_", "") }));
}
export const lifeOf = (list, r) => (list || []).find(s => s.vcs.includes(top(r)))?.life ?? (list || []).find(s => r?.name && s.name === r.name)?.life ?? "";
const WAITING = { IN_REVIEW: "in review at Google", APPROVED_NOT_PUBLISHED: "approved, waits for Publish in Play Console (managed publishing)",
  NOT_APPROVED: "rejected in Google's review", NOT_SENT_FOR_REVIEW: "not sent for review", DRAFT: "a draft" };

// ---- what to do ----
// promote: the newest completed Alpha release, onto a production track that already has a completed release and no rollout running
export function planPromote(tracks, life = {}) {
  const alpha = releasesOf(tracks, ALPHA).filter(r => r.status === "completed").sort((a, b) => top(b) - top(a))[0];
  const prod = releasesOf(tracks, PROD), live = prod.filter(r => r.status === "completed"), running = prod.find(r => r.status === "inProgress");
  const halted = prod.find(r => r.status === "halted"), base = Math.max(0, ...live.map(top));
  if (!alpha) return { stop: "no-alpha", he: "אין גרסה במסלול Alpha" };
  const vn = alpha.name || String(top(alpha));
  if (lifeOf(life[ALPHA], alpha) === "NOT_APPROVED") return { stop: "rejected", vn, he: `${vn} נדחתה בסקירה של Google ב-Alpha` };
  if (running) return top(running) === top(alpha) ? { stop: "running", vn, he: `${vn} כבר בהפצה הדרגתית ב-Production` }
    : { stop: "busy", vn, he: `${running.name || top(running)} עדיין בהפצה הדרגתית ב-Production: קודם היא צריכה להגיע ל-100% או להיעצר` };
  if (top(alpha) <= base) return { stop: "same", vn, he: `${vn} (versionCode ${top(alpha)}) לא חדשה מהגרסה שכבר ב-Production` };
  if (halted && top(halted) >= top(alpha)) return { stop: "paused", vn, he: `ההפצה של ${halted.name || top(halted)} עצורה ב-Production, ו-${vn} לא חדשה ממנה` };
  const notes = (alpha.releaseNotes || []).filter(n => n?.language && n?.text);
  if (!notes.length) return { stop: "notes", vn, he: `ל-${vn} ב-Alpha אין הערות שחרור` };
  if (!live.length && !halted) return { vn, vc: top(alpha), first: true, release: { name: alpha.name, versionCodes: codes(alpha), status: "completed", releaseNotes: notes } };
  return { vn, vc: top(alpha), release: { name: alpha.name, versionCodes: codes(alpha), status: "inProgress", userFraction: FRACTION, releaseNotes: notes }, replaces: halted ? (halted.name || String(top(halted))) : "" };
}
// auto: the staged rollout on production (if any) and its review state, against what the watch found (state.issues: "<vc>:<issue>" -> first
// found), when the watch first saw the rollout (state.seen["production:<vc>"], i.e. sent) and when this first saw it published (state.live)
export function planAuto(tracks, state, now, life) {
  const r = releasesOf(tracks, PROD).find(x => x.status === "inProgress");
  if (!r) return { act: "idle" };
  const vc = top(r), vn = r.name || String(vc), key = `${PROD}:${vc}`, st = lifeOf(life, r);
  if (!st) throw new Fail(`Google Play לא החזיר את מצב הסקירה של ${vn} ב-Production`, "לבדוק את הלוג של Release watch");
  if (st !== "PUBLISHED") return { act: "wait", vc, vn, why: WAITING[st] || st };
  const out = state?.live?.[key] ?? now, fresh = !state?.live?.[key], since = Math.min(state?.seen?.[key] ?? out, out);
  const base = { vc, vn, key, out, fresh, fraction: r.userFraction || 0 };
  const found = Object.entries(state?.issues || {}).filter(([k, t]) => k.startsWith(vc + ":") && t >= since);
  if (found.length) return { act: "halt", ...base, n: found.length, release: { ...r, status: "halted" } };
  const left = out + FULL_AFTER_H * HOUR - now;
  if (left > 0) return { act: fresh ? "live" : "wait", ...base, why: `${Math.ceil(left / HOUR)} h to go at ${Math.round(base.fraction * 100)}%` };
  const { userFraction, ...rest } = r;
  return { act: "full", ...base, release: { ...rest, status: "completed" } };
}

// ---- one edit: write, validate, commit, read back ----
async function send(ctx, release, kind) {
  const want = { kind, codes: codes(release) }, id = await insertEdit(ctx);
  let committed = false;
  try {
    await play(ctx, "PUT", `${EDITS(ctx)}/${id}/tracks/${PROD}`, { json: { track: PROD, releases: [release] }, want });
    await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
    try { await play(ctx, "POST", `${EDITS(ctx)}/${id}:commit`); committed = true; }
    catch (e) { if (await landed(ctx, release)) committed = true; else throw e; }   // a commit that got no answer may still have landed
  } finally { if (!committed) await dropEdit(ctx, id); }
  if (!(await landed(ctx, release))) throw new Fail("Google Play לא מראה את השינוי ב-Production אחרי השליחה", "לבדוק ב-Play Console ← Production");
}
async function landed(ctx, release) {
  try {
    const id = await insertEdit(ctx, true);
    try { return releasesOf(await listTracks(ctx, id, true), PROD).some(r => codes(r).join() === codes(release).join() && r.status === release.status); }
    finally { await dropEdit(ctx, id); }
  } catch { return false; }
}
// dry: production written back exactly as it is, in an edit that is then deleted (checks the production permission, changes nothing)
async function probe(ctx) {
  const id = await insertEdit(ctx);
  try {
    const releases = releasesOf(await listTracks(ctx, id), PROD);
    try { await play(ctx, "PUT", `${EDITS(ctx)}/${id}/tracks/${PROD}`, { json: { track: PROD, releases }, want: { kind: "same", releases } }); }
    catch (e) { if (releases.length || e.access || e.status === 401 || e.status === -1) throw e; note(`an empty production track could not be written back (${e.status}): the permission is checked by the first real run`); return false; }
    await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
    return true;
  } finally { await dropEdit(ctx, id); }
}
async function readTracks(ctx) {
  const id = await insertEdit(ctx);
  try { return await listTracks(ctx, id); } finally { await dropEdit(ctx, id); }
}
async function setup(env) {
  const raw = String(env[SECRET] || "").trim();
  if (!raw) return null;
  const sa = J(raw);
  if (!sa?.client_email || !sa?.private_key) throw new Fail(`הסוד ${SECRET} אינו מפתח JSON של חשבון שירות`, `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח`);
  return { pkg: env.PLAY_PACKAGE || PKG, dry: env.MODE !== "on", token: await accessToken(sa) };
}
const fmt = (tracks, life = {}) => tracks.filter(t => t.track === ALPHA || t.track === PROD).map(t => `${t.track}: ${(t.releases || []).map(r => `${r.name || "?"} (${codes(r).join("+")}, ${r.status}` +
  `${r.userFraction ? ` ${Math.round(r.userFraction * 100)}%` : ""}${lifeOf(life[t.track], r) ? `, ${lifeOf(life[t.track], r)}` : ""})`).join(", ") || "-"}`).join("; ");

export async function promote() {
  IO.deadline = IO.now() + BUDGET_MS;
  const R = { cmd: "promote", mode: IO.env.MODE === "on" ? "on" : "dry", code: "", vn: "", vc: 0, why: "", next: "" };
  try {
    const ctx = await setup(IO.env);
    if (!ctx) { note(`${SECRET} is not set: nothing is sent`); return { ...R, code: "nosecret" }; }
    const tracks = await readTracks(ctx), life = {};
    // the review state only adds a check (a build Google rejected on Alpha is not sent) and the log line; without it the run goes on
    for (const t of [ALPHA, PROD]) try { life[t] = await lifecycle(ctx, t); } catch (e) { note(`the review state of ${t} could not be read: ${String(e?.why || e?.message || e).slice(0, 120)}`); }
    R.tracks = fmt(tracks, life);
    IO.out(`on Play: ${R.tracks}`);
    const P = planPromote(tracks, life);
    Object.assign(R, { vn: P.vn || "", vc: P.vc || 0 });
    if (P.stop) { IO.out(`not sent: ${P.stop}`); return { ...R, code: P.stop, why: P.he }; }
    if (ctx.dry) { const checked = await probe(ctx); IO.out(`dry run: would send ${P.vn} (${P.vc}) to ${PROD} ${P.first ? "for all users (the first production release)" : `at ${FRACTION * 100}%`}${checked ? "; the production permission was checked" : ""}`); return { ...R, code: "dry", checked }; }
    await send(ctx, P.release, P.first ? "first" : "start");
    IO.out(`sent: ${P.vn} (${P.vc}) to ${PROD} ${P.first ? "for all users (the first production release)" : `at ${FRACTION * 100}%`}, in review`);
    return { ...R, code: "sent", replaces: P.replaces, first: !!P.first };
  } catch (e) { return failed(R, e); }
}
export async function auto() {
  IO.deadline = IO.now() + BUDGET_MS;
  const R = { cmd: "auto", mode: IO.env.MODE === "on" ? "on" : "dry", code: "", vn: "", vc: 0, why: "", next: "" };
  try {
    const ctx = await setup(IO.env);
    if (!ctx) return { ...R, code: "nosecret" };
    const file = IO.env.STATE || "watch.json", tracks = await readTracks(ctx), state = J(IO.read(file)) || {};
    const running = releasesOf(tracks, PROD).some(r => r.status === "inProgress");
    const P = planAuto(tracks, state, IO.now(), running ? await lifecycle(ctx, PROD) : []);
    Object.assign(R, { vn: P.vn || "", vc: P.vc || 0, n: P.n || 0, fraction: P.fraction || 0 });
    if (P.act === "idle" || P.act === "wait") { IO.out(`production: ${P.act}${P.why ? ` (${P.why})` : ""}`); return { ...R, code: P.act }; }
    if (ctx.dry) { IO.out(`dry run: would ${{ live: "record the start of", halt: "halt", full: "complete" }[P.act]} ${P.vn} (${P.vc})`); return { ...R, code: "dry-" + P.act }; }
    // the first look at it published starts the 48 h (kept with the watch's state; the workflow saves the file after this step)
    if (P.fresh) {
      const liveAt = { ...(state.live || {}), [P.key]: P.out };
      for (const k of Object.keys(liveAt)) if (IO.now() - liveAt[k] > KEEP_D * DAY) delete liveAt[k];
      IO.write(file, JSON.stringify({ ...state, live: liveAt }));
    }
    if (P.act === "live") { IO.out(`published: ${P.vn} (${P.vc}) at ${Math.round(P.fraction * 100)}%, ${P.why}`); return { ...R, code: "live" }; }
    await send(ctx, P.release, P.act);
    IO.out(`${P.act === "halt" ? "halted" : "completed"}: ${P.vn} (${P.vc})`);
    return { ...R, code: P.act === "halt" ? "halted" : "full" };
  } catch (e) { return failed(R, e); }
}
function failed(R, e) {
  const f = e instanceof Fail ? e : new Fail("תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג");
  return { ...R, code: "error", why: f.why, next: f.next, status: f.status, access: !!f.access };
}

// ---- the one Telegram ----
export function compose(R, env = {}) {
  const dev = env.PLAY_DEVELOPER_ID, app = env.PLAY_APP_ID, run = env.RUN_URL || "";
  const pc = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/tracks/production` : "https://play.google.com/console";
  const v = `לוחית ${R.vn}`, vc = R.vc || "x";
  if (R.code === "sent" && R.first) return { key: `prod:sent:${vc}`, link: pc, text: `${v} נשלחה ל-Production לכל המשתמשים: זו ההפצה הראשונה, ו-Google לא מאפשרת בה הפצה הדרגתית. ` +
    `היא תתחיל אחרי אישור Google (בהפצה ראשונה זה יכול לקחת כמה ימים). מהגרסה הבאה, "פרסם" מתחיל ב-${FRACTION * 100}%.\n${pc}` };
  if (R.code === "sent") return { key: `prod:sent:${vc}`, link: pc, text: `${v} נשלחה ל-Production בהפצה הדרגתית ל-${FRACTION * 100}% מהמשתמשים. היא תתחיל אחרי אישור Google.` +
    `${R.replaces ? ` היא מחליפה את ${R.replaces}, שההפצה שלה עצורה.` : ""} אם תופיע קריסה חדשה שלא הייתה בגרסאות הקודמות, ההפצה תיעצר לבד. אם לא, היא תגיע ל-100% כ-${FULL_AFTER_H} שעות אחרי שהמעקב יראה אותה.\n${pc}` };
  if (R.code === "live") return { key: `prod:live:${vc}`, link: pc, text: `Google אישרה את ${v}, והיא עלתה ל-${Math.round((R.fraction || FRACTION) * 100)}% מהמשתמשים ב-Production. ` +
    `אם לא תופיע קריסה חדשה, היא תגיע ל-100% לבד בעוד ${FULL_AFTER_H} שעות.` };
  if (R.code === "full") return { key: `prod:full:${vc}`, link: pc, text: `${v} הגיעה ל-100% מהמשתמשים ב-Production: ${FULL_AFTER_H} שעות בלי קריסה חדשה.` };
  if (R.code === "halted") return { key: `prod:halt:${vc}`, link: pc, text: `עצרתי את ההפצה של ${v} ב-Production (${Math.round((R.fraction || 0) * 100)}% מהמשתמשים): ` +
    `${R.n === 1 ? "קריסה חדשה אחת" : `${R.n} קריסות חדשות`} שלא היו בגרסאות הקודמות (הפרטים בהודעה מהמעקב). מי שכבר עדכן נשאר עם ${R.vn}, וכל השאר נשארים עם הגרסה הקודמת.\n` +
    `מה לעשות: לתקן ולשחרר גרסה חדשה. אם זו לא בעיה אמיתית: Play Console ← Production ← Resume rollout.\n${pc}` };
  if (R.code === "error") return { key: `prod:fail:${R.access ? "access" : R.cmd}`, link: run,
    text: `${R.cmd === "promote" ? "הפרסום ל-Production" : "הבדיקה של ההפצה ב-Production"} נכשל${R.cmd === "promote" ? "" : "ה"}: ${R.why}.${R.next ? `\nמה לעשות: ${R.next}.` : ""} שום דבר ב-Production לא השתנה.${run ? `\n${run}` : ""}` };
  // promote stood down (same, busy, running, paused, notes, rejected, no-alpha): the owner asked, so he hears why
  return { key: `prod:stop:${tag(R.code + R.vn)}`, link: run, text: `לא נשלח ל-Production: ${R.why}.` };
}
async function telegram(text) {
  const r = await call("POST", `https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }), timeout: 20000, once: true });
  IO.out(`telegram ${r.status || "no answer"}`);
  return r.ok;
}
// who hears: promote on, always (it is the owner's own request); auto, only when the rollout went live, halted, completed or failed; dry runs only print
export async function tell(R) {
  const quiet = R.mode !== "on" || ["nosecret", "idle", "wait"].includes(R.code) || R.code.startsWith("dry");
  if (quiet) return true;
  const m = compose(R, IO.env);
  IO.summary(`### Production: message\n\n${m.text.replace(/https:\/\/play\.google\.com\/console\S*/g, "Play Console").replace(/\n/g, "  \n")}`);
  if (!IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { note("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: the message is only in the job summary"); return true; }
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const r = router ? await router.alert("day", m.key, m.text, m.link, { today: "loud", plain: true, fresh: R.cmd === "promote", legacy: () => telegram(m.text) })
    : { delivered: await telegram(m.text) };
  return !!r.delivered;
}

// ---- CLI ----
export async function cli(argv) {
  const cmd = argv[0] || "";
  if (cmd === "gate") {
    const g = prodGate(IO.env);
    for (const n of g.notes) note(n);
    IO.output("mode", g.mode);
    IO.out(`gate: mode=${g.mode}`);
    return 0;
  }
  if (cmd === "selftest") return selftest();
  if (cmd !== "promote" && cmd !== "auto") { IO.out("usage: play-production.mjs promote|auto|gate|selftest"); return 2; }
  const R = cmd === "promote" ? await promote() : await auto();
  IO.output("code", R.code);
  IO.summary([`### Production ${R.cmd} (${R.mode})`, "", `- result: **${R.code}**${R.why ? `: ${R.why}` : ""}`, R.tracks ? `- on Play: ${R.tracks}` : ""].filter(Boolean).join("\n"));
  if (R.code === "error") IO.out(`::${cmd === "promote" ? "error" : "warning"}::Production ${cmd} failed${R.status > 0 ? ` (${R.status})` : ""}: ${R.why}`);
  const told = await tell(R);
  // a manual promote that failed is red for its caller; auto reports through the Telegram and stays green unless that was not delivered
  return (R.code === "error" && cmd === "promote") || !told ? 1 : 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const group = async (name, fn) => { try { await fn(); } catch (e) { fails.push(`${name} crashed: ${String(e?.stack || e).split("\n").slice(0, 3).join(" | ")}`); } };
  const saved = { ...IO }, realFetch = globalThis.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const SA = { type: "service_account", client_email: "ship@luchit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN-p1", TG = "777:SECRET-BOT-TOKEN-p2", T0 = Date.UTC(2026, 9, 25, 9), PKGP = `/androidpublisher/v3/applications/${PKG}/edits`;
  const NOTES = [{ language: "iw-IL", text: "• תיקון נתוני גרירה" }];
  const A = (vn, vc, status = "completed", x = {}) => ({ name: vn, versionCodes: [String(vc)], status, ...(status === "completed" ? { releaseNotes: NOTES } : {}), ...x });
  const T = (alpha, prod) => [{ track: "alpha", releases: alpha }, ...(prod ? [{ track: "production", releases: prod }] : []), { track: "internal", releases: [] }];
  const NORMAL = T([A("1.34", 115)], [A("1.33", 110)]);
  function world(o = {}) {
    const W = { calls: [], printed: [], outputs: {}, sums: [], tg: [], seq: 0, clock: o.now ?? T0, fail: structuredClone(o.fail || {}), edits: new Map(), tracks: structuredClone(o.tracks ?? NORMAL),
      files: { "watch.json": o.state ? JSON.stringify(o.state) : null } };
    const res = (s, b) => new Response(s === 204 ? null : JSON.stringify(b ?? {}), { status: s });
    const take = op => { const q = W.fail[op]; if (q && q.length) { const s = q.shift(); return s === 0 ? "drop" : res(s, { error: { message: "scripted " + s } }); } return null; };
    W.fetch = async (url, opt = {}) => {
      const method = opt.method || "GET", u = new URL(url), p = u.pathname;
      W.calls.push({ method, url, body: opt.body });
      if (url === TOKEN_URL) return res(200, { access_token: TOKEN });
      if (u.host === "api.telegram.org") { W.tg.push(J(opt.body)); return res(200, { ok: true }); }
      if (u.origin !== PLAY || opt.headers?.authorization !== "Bearer " + TOKEN) return res(401, {});
      // review state: every release on the track is published unless o.life says otherwise ({ versionCode: state }); o.life.none lists nothing
      const rl = p.match(/\/tracks\/(\w+)\/releases$/);
      if (method === "GET" && rl) {
        const e = take("life"); if (e) return e;
        if (o.life?.none) return res(200, {});
        return res(200, { releases: (W.tracks.find(t => t.track === rl[1])?.releases || []).map(r => ({ track: rl[1], releaseName: r.name, activeArtifacts: r.versionCodes.map(v => ({ versionCode: +v })),
          releaseLifecycleState: "RELEASE_LIFECYCLE_STATE_" + (o.life?.[r.versionCodes[0]] || "PUBLISHED") })) });
      }
      const id = p.match(/edits\/([\w-]+)/)?.[1];
      if (method === "POST" && p === PKGP) { const nid = "e" + ++W.seq; W.edits.set(nid, { tracks: structuredClone(W.tracks) }); return res(200, { id: nid }); }
      const ed = W.edits.get(id);
      if (!ed) return res(404, { error: { message: "edit not found" } });
      if (method === "GET" && p.endsWith("/tracks")) return res(200, { tracks: ed.tracks });
      if (method === "PUT" && p.endsWith("/tracks/production")) {
        const e = take("put"); if (e) return e;
        const b = J(opt.body), keep = (ed.tracks.find(t => t.track === "production")?.releases || []).filter(r => r.status === "completed" && b.releases[0].status !== "completed");
        // Play keeps the completed release under a staged rollout; a completed rollout replaces it
        ed.tracks = ed.tracks.filter(t => t.track !== "production").concat([{ track: "production", releases: b.releases.some(r => r.status === "completed" || JSON.stringify(b.releases) === JSON.stringify(keep)) ? b.releases : [...b.releases, ...keep.filter(k => !b.releases.some(r => r.versionCodes.join() === k.versionCodes.join()))] }]);
        return res(200, b);
      }
      if (method === "DELETE") { W.edits.delete(id); return res(204); }
      if (p.endsWith(":validate")) return take("validate") || res(200, {});
      if (p.endsWith(":commit")) {
        const e = take("commit"); if (e && e !== "drop") return e;
        if (!o.ghost) W.tracks = ed.tracks;   // ghost: Play answers 200 and keeps the old track
        W.edits.delete(id);
        if (e === "drop") throw Object.assign(new Error("aborted"), { name: "AbortError" });
        return res(200, { id });
      }
      return res(400, { error: { message: "unexpected" } });
    };
    return W;
  }
  const ENV = { [SECRET]: JSON.stringify(SA), MODE: "on", EVENT: "workflow_dispatch", TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42", RUN_URL: "https://github.com/ddsabag/vehicle-app/actions/runs/7" };
  const run = async (o = {}, env = {}, argv = ["promote"]) => {
    const W = world(o);
    globalThis.fetch = W.fetch;
    Object.assign(IO, { env: { ...ENV, ...env }, fetch: W.fetch, now: () => W.clock, sleep: async ms => { W.clock += ms; }, deadline: 0, router: o.router || null,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s), read: p => W.files[p] ?? null, write: (p, s) => { W.files[p] = s; } });
    W.code = await cli(argv);
    W.state = J(W.files["watch.json"] || "null");
    W.puts = W.calls.filter(c => c.method === "PUT").map(c => J(c.body));
    W.prod = W.tracks.find(t => t.track === "production")?.releases || [];
    return W;
  };
  const committed = W => W.calls.some(c => c.url.endsWith(":commit"));
  let W;

  await group("allowed and bodies", async () => {
    const E = `${PLAY}${PKGP}/e1`;
    ok(allowed("PUT", `${E}/tracks/production`, false) && allowed("PUT", `${E}/tracks/production`, true) && allowed("GET", `${E}/tracks`, true), "allowed: production write, reads");
    ok(allowed("POST", `${E}:commit`, false) && !allowed("POST", `${E}:commit`, true), "allowed: commit on only");
    for (const [m, u] of [["PUT", `${E}/tracks/alpha`], ["PUT", `${E}/tracks/beta`], ["PUT", `${E}/tracks/internal`], ["PATCH", `${E}/tracks/production`], ["PUT", `${E}/tracks/production/../alpha`],
      ["PUT", `${E}/tracks/production%2F..%2Falpha`], ["POST", `${PLAY}/upload${PKGP}/e1/bundles`], ["PATCH", `${E}/listings/iw-IL`], ["PUT", `https://evil.example${PKGP}/e1/tracks/production`]])
      ok(!allowed(m, u, false), `allowed: refuses ${m} ${u.replace(PLAY, "")}`);
    const S = r => ({ track: "production", releases: [r] }), C = ["115"];
    ok(bodyOk(S({ versionCodes: C, status: "inProgress", userFraction: 0.2 }), { kind: "start", codes: C }), "body: start at 20%");
    for (const [b, w, m] of [[S({ versionCodes: C, status: "inProgress", userFraction: 1 }), "start", "100% start"], [S({ versionCodes: C, status: "completed" }), "start", "completed start"],
      [S({ versionCodes: ["116"], status: "inProgress", userFraction: 0.2 }), "start", "another build"], [{ track: "alpha", releases: [{ versionCodes: C, status: "inProgress", userFraction: 0.2 }] }, "start", "alpha"],
      [{ track: "production", releases: [{ versionCodes: C, status: "inProgress", userFraction: 0.2 }, { versionCodes: ["110"], status: "completed" }] }, "start", "two releases"],
      [S({ versionCodes: C, status: "completed", userFraction: 0.2 }), "full", "full with fraction"], [S({ versionCodes: C, status: "halted" }), "halt", "halt without fraction"], [S({ versionCodes: C, status: "draft" }), "full", "draft"]])
      ok(!bodyOk(b, { kind: w, codes: C }), "body: refuses " + m);
    ok(bodyOk(S({ versionCodes: C, status: "completed" }), { kind: "full", codes: C }) && bodyOk(S({ versionCodes: C, status: "halted", userFraction: 0.2 }), { kind: "halt", codes: C }), "body: full and halt");
  });

  await group("gate", async () => {
    const g = (v, e) => prodGate({ SHIP_TAIL: v, REF: "refs/heads/main", ...e }).mode;
    ok(g("", { EVENT: "workflow_dispatch" }) === "dry" && g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "on" && g("dry", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "dry", "gate: manual, default dry, never above the switch");
    ok(g("", { EVENT: "push" }) === "off" && g("", { EVENT: "schedule" }) === "off" && g("", { EVENT: "workflow_run" }) === "off", "gate: never without a manual run");
    ok(g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on", REF: "refs/heads/x" }) === "dry" && g("off", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "off", "gate: branch dry, off off");
  });

  await group("promote", async () => {
    W = await run();
    ok(W.outputs.code === "sent" && W.code === 0 && committed(W), "promote: sent " + W.printed.join(" | "));
    ok(W.puts.length === 1 && W.puts[0].releases.length === 1 && W.puts[0].releases[0].status === "inProgress" && W.puts[0].releases[0].userFraction === 0.2 && W.puts[0].releases[0].versionCodes.join() === "115"
      && W.puts[0].releases[0].name === "1.34" && W.puts[0].releases[0].releaseNotes[0].text === NOTES[0].text, "promote: the alpha build at 20% with its notes " + JSON.stringify(W.puts));
    ok(W.tracks.find(t => t.track === "alpha").releases[0].versionCodes.join() === "115" && W.prod.some(r => r.status === "completed" && r.versionCodes.join() === "110"), "promote: alpha untouched, 1.33 still serves the rest");
    ok(W.tg.length === 1 && W.tg[0].text.includes("1.34") && W.tg[0].text.includes("20%") && W.edits.size === 0, "promote: one Telegram, no edit left " + W.tg.map(x => x.text));
    // stand-downs: each one sends nothing to Play, tells why
    // the first production release: all users, completed, its own message
    for (const tracks of [T([A("1.33", 110)]), T([A("1.33", 110)], [])]) {
      W = await run({ tracks });
      ok(W.outputs.code === "sent" && W.puts.length === 1 && W.puts[0].releases.length === 1 && W.puts[0].releases[0].status === "completed" && !("userFraction" in W.puts[0].releases[0])
        && W.puts[0].releases[0].versionCodes.join() === "110" && W.prod.some(r => r.status === "completed" && r.versionCodes.join() === "110") && W.tg[0]?.text.includes("ההפצה הראשונה"), "promote: first release to all users " + JSON.stringify(W.puts) + W.tg.map(x => x.text));
    }
    W = await run({ tracks: T([A("1.33", 110)], []) }, { MODE: "dry" });
    ok(W.outputs.code === "dry" && !committed(W) && W.puts.length === 1 && W.puts[0].releases.length === 0 && W.printed.some(l => l.includes("first production release")), "dry first: empty production written back " + W.printed.join(" | "));
    W = await run({ tracks: T([A("1.33", 110)], []), fail: { put: [400] } }, { MODE: "dry" });
    ok(W.outputs.code === "dry" && W.edits.size === 0, "dry first: Play refuses an empty write = still dry, edit dropped");
    W = await run({ tracks: T([A("1.33", 110)], []), fail: { put: [403] } }, { MODE: "dry" });
    ok(W.outputs.code === "error" && W.tg.length === 0 && W.edits.size === 0, "dry first: 403 = the permission is missing");
    for (const [name, tracks, code] of [["same", T([A("1.33", 110)], [A("1.33", 110)]), "same"],
      ["older", T([A("1.33", 110)], [A("1.34", 115)]), "same"], ["running", T([A("1.34", 115)], [A("1.34", 115, "inProgress", { userFraction: 0.2 }), A("1.33", 110)]), "running"],
      ["busy", T([A("1.35", 120)], [A("1.34", 115, "inProgress", { userFraction: 0.2 }), A("1.33", 110)]), "busy"], ["no alpha", T([A("1.34", 115, "draft")], [A("1.33", 110)]), "no-alpha"],
      ["halted newer", T([A("1.34", 115)], [A("1.34", 115, "halted", { userFraction: 0.2 }), A("1.33", 110)]), "paused"], ["no notes", T([{ name: "1.34", versionCodes: ["115"], status: "completed" }], [A("1.33", 110)]), "notes"]]) {
      W = await run({ tracks });
      ok(W.outputs.code === code && !W.puts.length && !committed(W) && W.tg.length === 1 && W.tg[0].text.startsWith("לא נשלח ל-Production") && W.code === 0, `promote ${name}: ${W.outputs.code} ${W.tg.map(x => x.text)}`);
    }
    W = await run({ life: { 115: "NOT_APPROVED" } });
    ok(W.outputs.code === "rejected" && !W.puts.length && W.tg[0]?.text.includes("נדחתה"), "promote: a build Google rejected on Alpha is not sent");
    W = await run({ fail: { life: [403, 403] } });
    ok(W.outputs.code === "sent" && W.printed.some(l => l.includes("review state of alpha could not be read")), "promote: no review state = goes on " + W.printed.join(" | "));
    W = await run({ life: { 115: "IN_REVIEW" } });
    ok(W.outputs.code === "sent" && W.printed.some(l => l.includes("IN_REVIEW")), "promote: an Alpha build still in review is sent (both reviews run together)");
    // a halted older rollout is replaced by the new build
    W = await run({ tracks: T([A("1.35", 120)], [A("1.34", 115, "halted", { userFraction: 0.2 }), A("1.33", 110)]) });
    ok(W.outputs.code === "sent" && W.puts[0].releases[0].versionCodes.join() === "120" && W.tg[0].text.includes("מחליפה את 1.34"), "promote over a halted older rollout " + W.tg.map(x => x.text));
  });

  await group("promote dry and errors", async () => {
    W = await run({}, { MODE: "dry" });
    ok(W.outputs.code === "dry" && !committed(W) && W.puts.length === 1 && JSON.stringify(W.puts[0].releases) === JSON.stringify(NORMAL[1].releases) && W.tg.length === 0 && W.edits.size === 0, "dry: production written back as is, nothing sent " + JSON.stringify(W.puts));
    W = await run({ fail: { put: [403] } });
    ok(W.outputs.code === "error" && W.code === 1 && !committed(W) && W.edits.size === 0 && W.tg[0]?.text.includes(PERM_PROD), "403: the permission to add " + W.tg.map(x => x.text));
    W = await run({ fail: { commit: [0] } });
    ok(W.outputs.code === "sent", "commit without an answer that landed = sent");
    W = await run({ fail: { commit: [500, 500, 500, 500] } });
    ok(W.outputs.code === "error" && W.prod.every(r => r.versionCodes.join() !== "115"), "commit 5xx: error, production unchanged");
    W = await run({ ghost: true });
    ok(W.outputs.code === "error" && W.code === 1 && W.tg[0]?.text.includes("לא מראה את השינוי"), "a commit Play answered but does not show: error " + W.tg.map(x => x.text));
    W = await run({}, { [SECRET]: "" });
    ok(W.outputs.code === "nosecret" && W.calls.length === 0 && W.tg.length === 0, "no secret: nothing");
  });

  await group("auto", async () => {
    const RUN = [A("1.34", 115, "inProgress", { userFraction: 0.2, releaseNotes: NOTES }), A("1.33", 110)], TR = T([A("1.34", 115)], RUN), AUTO = { EVENT: "schedule" };
    const at = (seenH, liveH, x = {}) => ({ seen: seenH == null ? {} : { "production:115": T0 - seenH * HOUR }, ...(liveH == null ? {} : { live: { "production:115": T0 - liveH * HOUR } }), ...x });
    // in Google's review: nothing, quiet, state untouched
    W = await run({ tracks: TR, life: { 115: "IN_REVIEW" }, state: at(30) }, AUTO, ["auto"]);
    ok(W.outputs.code === "wait" && !W.puts.length && W.tg.length === 0 && !W.state.live && W.printed.some(l => l.includes("in review")), "auto: in review = wait " + W.printed.join(" | "));
    W = await run({ tracks: TR, life: { 115: "APPROVED_NOT_PUBLISHED" }, state: at(60) }, AUTO, ["auto"]);
    ok(W.outputs.code === "wait" && !W.puts.length && W.tg.length === 0, "auto: approved, not published = wait");
    // first look at it published: one Telegram, the 48 h start now
    W = await run({ tracks: TR, state: at(30) }, AUTO, ["auto"]);
    ok(W.outputs.code === "live" && !W.puts.length && W.tg.length === 1 && W.tg[0].text.includes("אישרה") && W.tg[0].text.includes("20%") && W.state.live["production:115"] === T0 && W.state.seen["production:115"] === T0 - 30 * HOUR, "auto: published = told once, 48 h start " + JSON.stringify(W.state) + W.tg.map(x => x.text));
    W = await run({ tracks: TR, state: at(40, 10) }, AUTO, ["auto"]);
    ok(W.outputs.code === "wait" && !W.puts.length && W.tg.length === 0 && W.printed.some(l => l.includes("38 h to go at 20%")), "auto: waits " + W.printed.join(" | "));
    W = await run({ tracks: TR, state: at(80, 49) }, AUTO, ["auto"]);
    ok(W.outputs.code === "full" && W.puts[0].releases[0].status === "completed" && !("userFraction" in W.puts[0].releases[0]) && W.prod.some(r => r.versionCodes.join() === "115" && r.status === "completed"), "auto: 100% 48 h after published " + JSON.stringify(W.puts));
    ok(W.tg.length === 1 && W.tg[0].text.includes("100%"), "auto: told 100%");
    // a new issue found after the rollout was sent halts it (also one found while in review, once it is published)
    W = await run({ tracks: TR, state: at(80, 49, { issues: { "115:apps/x/i1": T0 - 2 * HOUR } }) }, AUTO, ["auto"]);
    ok(W.outputs.code === "halted" && W.puts[0].releases[0].status === "halted" && W.puts[0].releases[0].userFraction === 0.2 && W.tg[0]?.text.includes("עצרתי") && W.tg[0].text.includes("20%"), "auto: a new issue halts, even after 48 h " + W.tg.map(x => x.text));
    W = await run({ tracks: TR, state: at(30, null, { issues: { "115:apps/x/i1": T0 - 20 * HOUR } }) }, AUTO, ["auto"]);
    ok(W.outputs.code === "halted" && W.tg.length === 1 && W.state.live["production:115"] === T0, "auto: an issue found in review halts at the first look published");
    W = await run({ tracks: TR, state: at(5, 2, { issues: { "115:apps/x/i1": T0 - 30 * HOUR, "110:apps/x/i2": T0 - HOUR } }) }, AUTO, ["auto"]);
    ok(W.outputs.code === "wait" && !W.puts.length, "auto: an issue found before the rollout (the owner promoted knowingly) or of another build does not halt");
    W = await run({ tracks: TR, state: {} }, AUTO, ["auto"]);
    ok(W.outputs.code === "live" && W.state.live["production:115"] === T0, "auto: no watch state = the 48 h start now");
    W = await run({ tracks: NORMAL, state: {} }, AUTO, ["auto"]);
    ok(W.outputs.code === "idle" && W.tg.length === 0 && !W.calls.some(c => c.url.includes("/releases")), "auto: no rollout = idle, quiet");
    W = await run({ tracks: TR, state: at(30) }, { ...AUTO, MODE: "dry" }, ["auto"]);
    ok(W.outputs.code === "dry-live" && W.tg.length === 0 && W.files["watch.json"] === JSON.stringify(at(30)), "auto dry: published, state untouched");
    W = await run({ tracks: TR, state: at(80, 49) }, { ...AUTO, MODE: "dry" }, ["auto"]);
    ok(W.outputs.code === "dry-full" && !W.puts.length && W.tg.length === 0, "auto dry: prints only");
    W = await run({ tracks: TR, state: at(80, 49), fail: { put: [403] } }, AUTO, ["auto"]);
    ok(W.outputs.code === "error" && W.code === 0 && W.tg.length === 1, "auto error: told, stays green");
    W = await run({ tracks: TR, state: at(80, 49), life: { none: true } }, AUTO, ["auto"]);
    ok(W.outputs.code === "error" && !W.puts.length && W.tg[0]?.text.includes("מצב הסקירה"), "auto: no review state = error, nothing written " + W.tg.map(x => x.text));
    W = await run({ tracks: TR, state: at(80, 49), fail: { life: [403] } }, AUTO, ["auto"]);
    ok(W.outputs.code === "error" && !W.puts.length && W.tg.length === 1 && !W.tg[0].text.includes(PERM_PROD), "auto: review state 403 = error with the read permission " + W.tg.map(x => x.text));
  });

  await group("router and secrets", async () => {
    const seen = [], router = { alert: async (lv, key, text, link, o) => { seen.push({ lv, key, o }); return { delivered: true }; } };
    const { validKey } = await import("./alert.mjs");
    await run({ router });
    await run({ router, tracks: T([A("1.33", 110)], [A("1.33", 110)]) });
    await run({ router, fail: { put: [403] } });
    await run({ router, tracks: T([A("1.34", 115)], [A("1.34", 115, "inProgress", { userFraction: 0.2 }), A("1.33", 110)]), state: { seen: { "production:115": T0 - 49 * HOUR }, live: { "production:115": T0 - 49 * HOUR }, issues: { "115:a": T0 } } }, { EVENT: "schedule" }, ["auto"]);
    ok(seen.map(s => s.key.replace(/:[0-9a-f]{12}$/, ":H")).join() === "prod:sent:115,prod:stop:H,prod:fail:access,prod:halt:115" && seen.every(s => s.lv === "day" && validKey(s.key)), "router: keys " + seen.map(s => s.key));
    W = await run();
    const all = [...W.printed, ...W.sums, ...Object.values(W.outputs), ...W.tg.map(x => x.text)].join("\n");
    ok(![TOKEN, TG, "PRIVATE KEY", SA.client_email].some(x => all.includes(x)), "secrets stay out of the output");
  });

  Object.assign(IO, saved); globalThis.fetch = realFetch;
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("play-production.mjs")) process.exit(await cli(process.argv.slice(2)));
