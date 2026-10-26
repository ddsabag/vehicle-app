// Ship tail, store listing part (store-listing.yml): keeps the Hebrew (iw-IL) main store listing on Google Play equal to the files in
// .github/store-listing/: title.txt, short-description.txt, full-description.txt and phone-screenshots/ (PNG or JPEG, in file-name order).
// A file or folder that is not there leaves that part of the listing as it is on Play. Only what differs is sent, in one edit that is read
// back, validated and committed; the commit sends it for review, as the console's "Send changes for review" (a change already in review,
// such as a new Alpha build, is withdrawn and sent again together with this one: Play's default for edits.commit). Nothing else can be
// written: other languages, the icon, the feature graphic, tablet screenshots, tracks, prices and production are refused below before a
// request leaves the machine. A file that breaks Play's limits stops the run before Play is asked anything; when Play does not answer
// clearly, nothing is committed (fail closed).
// Node 20, node: builtins only. Commands:
//   node play-listing.mjs gate       SHIP_TAIL, EVENT, REF, INPUT_MODE -> output mode (on|dry|off)
//   node play-listing.mjs            SHIP_SA_JSON, MODE (on|dry), EVENT, RUN_URL -> output code; one Telegram (alert.mjs) for a change sent,
//                                    a dry push or an error. A manual dry run only writes the job summary.
//   node play-listing.mjs check      the files only (Play's limits), offline: the Alert router check runs it on next before a release
//   node play-listing.mjs selftest   offline (mocked fetch, temporary files)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { jwt, Fail, playFail, gate, chars, PKG, SECRET, escH, whyHe } from "./play-alpha.mjs";
import { msg } from "./tg-text.mjs";

export const DIR = ".github/store-listing", SHOTS = "phone-screenshots";
export const LANG = "iw-IL", KIND = "phoneScreenshots";   // the only listing and the only image type this script may write; hard-coded on purpose
export const FIELDS = { title: ["title.txt", 30, "הכותרת"], shortDescription: ["short-description.txt", 80, "התיאור הקצר"], fullDescription: ["full-description.txt", 4000, "התיאור המלא"] };
export const PERM_LISTING = "Manage store presence";   // newer consoles: "Edit store listing, pricing & distribution"
export const BUDGET_MS = 10 * 60000;
const PLAY = "https://androidpublisher.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
// Play's phone screenshot rules: 2-8, JPEG or 24-bit PNG without alpha, each side 320-3840 px, the long side at most twice the short, 8 MB
export const IMG = { min: 2, max: 8, side: [320, 3840], ratio: 2, bytes: 8 * 1024 * 1024 };

const IO = {
  env: process.env, root: process.cwd(), fetch: (u, o) => fetch(u, o), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), deadline: 0, router: null,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const hash = (b, a = "sha256") => crypto.createHash(a).update(b).digest("hex");
const note = s => IO.out("::notice::" + s);
// the text Play keeps: no BOM, \n line ends, no spaces at line ends, no blank lines around it. Both sides are compared this way.
export const norm = s => String(s ?? "").replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

// ---- gate: the same SHIP_TAIL switch and manual mode as Ship tail ----
// main: a push acts (or stays dry under SHIP_TAIL=dry), a manual run is dry unless mode=on. Another branch: a manual run is dry, which only
// reads Play (so a branch can be checked before it reaches main); a push there does nothing.
export function listingGate(env) {
  const g = gate({ ...env, REF: "refs/heads/main", INPUT_STEP: "play" }), notes = [...g.notes];
  if (g.mode === "off") return { mode: "off", notes };
  if (env.EVENT !== "push" && env.EVENT !== "workflow_dispatch") return { mode: "off", notes: [...notes, `event ${String(env.EVENT || "?").slice(0, 20)}: nothing runs`] };
  if (env.REF === "refs/heads/main") return { mode: g.mode, notes };
  const br = String(env.REF || "?").replace(/^refs\/heads\//, "").replace(/[^\w./-]/g, "").slice(0, 40);
  if (env.EVENT !== "workflow_dispatch") return { mode: "off", notes: [...notes, `the store listing is sent from main only, this push is on ${br}: nothing runs`] };
  if (g.mode === "on") notes.push(`this run is on ${br}, not main: dry only`);
  return { mode: "dry", notes };
}

// ---- the files ----
// width x height of a PNG or JPEG, and whether a PNG has an alpha channel; null when the file is neither
export function imageInfo(b) {
  if (b.length > 26 && b.readUInt32BE(0) === 0x89504e47 && b.toString("latin1", 12, 16) === "IHDR")
    return { type: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: b[25] === 4 || b[25] === 6 };
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) return null;
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: "image/jpeg", w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), alpha: false };
      if (m === 0xd9 || m === 0xda) return null;
      i += 2 + len;
    }
  }
  return null;
}
// what the repo says the listing should be. Every problem is collected, then one Fail lists them (Hebrew, for the Telegram).
export function readLocal(root = IO.root) {
  const dir = path.join(root, DIR), L = { text: {}, shots: null, problems: [] };
  for (const [k, [file, max, he]] of Object.entries(FIELDS)) {
    const f = path.join(dir, file);
    if (!fs.existsSync(f)) continue;
    const t = norm(fs.readFileSync(f, "utf8")), n = chars(t);
    if (!t) L.problems.push(`${file} ריק`);
    else if (n > max) L.problems.push(`${he} ארוך מדי: ${n} תווים, המקסימום ${max}`);
    L.text[k] = t;
  }
  const sd = path.join(dir, SHOTS);
  if (fs.existsSync(sd)) {
    const names = fs.readdirSync(sd).filter(n => !n.startsWith(".")).sort();
    const other = names.filter(n => !/\.(png|jpe?g)$/i.test(n));
    if (other.length) L.problems.push(`בתיקיית ${SHOTS} יש קבצים שאינם PNG או JPEG: ${other.slice(0, 3).join(", ")}`);
    L.shots = names.filter(n => /\.(png|jpe?g)$/i.test(n)).map(name => {
      const buf = fs.readFileSync(path.join(sd, name)), i = imageInfo(buf);
      const bad = !i ? "אינו תמונת PNG או JPEG תקינה" : i.alpha ? "PNG עם שקיפות (Play מקבל PNG בלי ערוץ שקיפות)" : buf.length > IMG.bytes ? "גדול מ-8MB"
        : Math.min(i.w, i.h) < IMG.side[0] || Math.max(i.w, i.h) > IMG.side[1] ? `${i.w}x${i.h}, כל צלע צריכה להיות בין ${IMG.side[0]} ל-${IMG.side[1]}`
        : Math.max(i.w, i.h) > IMG.ratio * Math.min(i.w, i.h) ? `${i.w}x${i.h}, הצלע הארוכה יותר מפי 2 מהקצרה` : "";
      if (bad) L.problems.push(`${name}: ${bad}`);
      return { name, buf, type: i?.type || "", w: i?.w || 0, h: i?.h || 0, sha256: hash(buf), sha1: hash(buf, "sha1") };
    });
    if (L.shots.length < IMG.min || L.shots.length > IMG.max) L.problems.push(`${L.shots.length} צילומי מסך, Play מקבל ${IMG.min} עד ${IMG.max}`);
  }
  L.managed = Object.keys(L.text).length > 0 || L.shots !== null;
  return L;
}

// ---- what to change ----
// the same image: sha256 when Play gives one, else sha1
const same = (img, shot) => img.sha256 ? img.sha256 === shot.sha256 : !!img.sha1 && img.sha1 === shot.sha1;
// text: the fields whose file differs from Play. Images: Play's longest run of equal images from the first one stays; the rest of Play's
// images are deleted and the rest of ours uploaded, in order (Play has no reorder, and a new image always goes last). So a changed last
// screenshot replaces that one only, as the owner used to do in the console.
export function plan(L, live, imgs) {
  const text = Object.keys(L.text).filter(k => L.text[k] !== norm(live[k]));
  let shots = null;
  if (L.shots) {
    let k = 0;
    while (k < imgs.length && k < L.shots.length && same(imgs[k], L.shots[k])) k++;
    if (k < imgs.length || k < L.shots.length) shots = { keep: k, drop: imgs.slice(k), add: L.shots.slice(k), total: L.shots.length };
  }
  return { text, shots, same: !text.length && !shots };
}
// the Hebrew list of what changed, for the Telegram and the job summary
export function describe(P) {
  const parts = P.text.map(k => FIELDS[k][2]);
  if (P.shots) {
    const { keep, add, drop, total } = P.shots;
    parts.push(add.length ? `צילומי המסך (${total} בסך הכול, ${add.length === total ? "כולם חדשים" : add.length === 1 ? `מספר ${keep + 1} חדש` : `מספר ${keep + 1} עד ${total} חדשים`})`
      : `צילומי המסך (${drop.length} הוסרו, נשארו ${total})`);
  }
  return parts.join(", ");
}

// ---- HTTP (Google's retry rule, as in play-alpha.mjs: 5xx, 429 and network errors up to 4 times, 2/4/8 s apart) ----
async function call(method, url, { headers = {}, body, timeout = 120000, cleanup = false, once = false } = {}) {
  for (let i = 0; ; i++) {
    const left = cleanup || !IO.deadline ? Infinity : IO.deadline - IO.now();
    if (left < 1000) return { status: 0, ok: false, text: "network: out of time" };
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), Math.min(cleanup ? 30000 : timeout, left));
    try {
      const r = await IO.fetch(url, { method, headers, body, signal: c.signal });
      res = { status: r.status, ok: r.ok, text: await r.text(), retryAfter: +(r.headers?.get?.("retry-after") || 0) };
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

// ---- Play: the only calls this script can make ----
// A dry run may write the Hebrew texts back as they are, inside an edit it then deletes (that checks the permission and changes nothing);
// it can never upload, delete an image or commit.
const APP = "/androidpublisher/v3/applications/[\\w.]+/edits", LST = `/listings/${LANG}`, SHOT = `${LST}/${KIND}`;
const ALLOWED = [
  ["POST", new RegExp(`^${APP}$`)],                                 // edits.insert
  ["GET", new RegExp(`^${APP}/[\\w-]+${LST}$`)],                    // edits.listings.get, iw-IL only
  ["PATCH", new RegExp(`^${APP}/[\\w-]+${LST}$`)],                  // edits.listings.patch, iw-IL only
  ["GET", new RegExp(`^${APP}/[\\w-]+${SHOT}$`)],                   // edits.images.list, phone screenshots only
  ["DELETE", new RegExp(`^${APP}/[\\w-]+${SHOT}/[\\w-]+$`)],        // edits.images.delete, one phone screenshot
  ["POST", new RegExp(`^/upload${APP}/[\\w-]+${SHOT}$`)],           // edits.images.upload, a phone screenshot
  ["POST", new RegExp(`^${APP}/[\\w-]+:(validate|commit)$`)],       // edits.validate, edits.commit
  ["DELETE", new RegExp(`^${APP}/[\\w-]+$`)],                       // edits.delete (throwaway and failed edits)
];
export function allowed(method, url, dry) {
  let u; try { u = new URL(url); } catch { return false; }
  const raw = url.startsWith(PLAY + "/") ? url.slice(PLAY.length).split("?")[0] : "";
  if (u.origin !== PLAY || raw !== u.pathname) return false;
  if (dry && (/:commit$/.test(raw) || raw.startsWith("/upload/") || (method === "DELETE" && raw.includes(SHOT)))) return false;
  return ALLOWED.some(([m, re]) => m === method && re.test(raw));
}
// Play's 401/403 here is the store listing permission (Ship tail's own permissions are not enough); the rest as in play-alpha.mjs
function listingFail(r) {
  if (r.status === 401 || r.status === 403) {
    const f = playFail(r);
    if (/ה-API של Google Play כבוי/.test(f.why)) return f;
    return Object.assign(new Fail("לחשבון השירות אין הרשאה לערוך את דף החנות", `Play Console ← Users and permissions ← ship-tail ← App permissions ← לוחית: לסמן "${PERM_LISTING}"`, r.status), { access: true });
  }
  return playFail(r);
}
async function play(ctx, method, p, { json, buf, type, cleanup = false } = {}) {
  const url = PLAY + p;
  if (!allowed(method, url, ctx.dry)) throw new Fail(`refused: ${method} ${p.replace(/edits\/[\w-]+/, "edits/<id>")}`, "", -1);
  const headers = { authorization: "Bearer " + ctx.token, ...(json ? { "content-type": "application/json" } : buf ? { "content-type": type } : {}) };
  const r = await call(method, url, { headers, body: json ? JSON.stringify(json) : buf, cleanup });
  if (!r.ok) throw listingFail(r);
  return J(r.text) || {};
}
const EDITS = ctx => `/androidpublisher/v3/applications/${ctx.pkg}/edits`;
const insertEdit = async (ctx, cleanup = false) => (await play(ctx, "POST", EDITS(ctx), { json: {}, cleanup })).id;
const dropEdit = (ctx, id) => play(ctx, "DELETE", `${EDITS(ctx)}/${id}`, { cleanup: true }).catch(() => null);   // best effort: an edit expires on its own
async function readLive(ctx, id, cleanup = false) {
  let live;
  try { live = await play(ctx, "GET", `${EDITS(ctx)}/${id}${LST}`, { cleanup }); }
  catch (e) { if (e.status === 404) throw new Fail("ב-Google Play אין דף חנות בעברית (iw-IL)", "לבדוק ב-Play Console ← Main store listing שהשפה הראשית היא עברית"); throw e; }
  const imgs = (await play(ctx, "GET", `${EDITS(ctx)}/${id}${SHOT}`, { cleanup })).images || [];
  if (!Array.isArray(imgs)) throw new Fail("Google Play החזיר רשימת צילומים לא צפויה", "להריץ שוב בעוד כמה דקות");
  return { live, imgs };
}

// ---- the sync ----
const short = h => String(h || "").slice(0, 12) || "-";
export async function sync() {
  IO.deadline = IO.now() + BUDGET_MS;
  const env = IO.env, mode = env.MODE === "on" ? "on" : "dry";
  const R = { code: "", mode, what: "", why: "", next: "", stage: "", lines: [] };
  let L;
  try { L = readLocal(); } catch (e) { return failed(R, e, "files"); }
  if (!L.managed) { note(`${DIR} has no listing files: nothing to do`); return { ...R, code: "nothing" }; }
  if (L.problems.length) return failed(R, new Fail(L.problems.slice(0, 4).join("; "), `לתקן את הקבצים ב-${DIR} ב-main`), "files");
  const raw = String(env[SECRET] || "").trim();
  if (!raw) { note(`${SECRET} is not set: the store listing is not checked`); return { ...R, code: "nosecret" }; }
  const sa = J(raw);
  if (!sa?.client_email || !sa?.private_key) return failed(R, new Fail(`הסוד ${SECRET} מוגדר אבל אינו מפתח JSON של חשבון שירות`, `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח, כמו שהורד`), "secret");
  const ctx = { pkg: env.PLAY_PACKAGE || PKG, dry: mode !== "on" };
  let id = "", committed = false;
  try {
    R.stage = "read";
    ctx.token = await accessToken(sa);
    id = await insertEdit(ctx);
    const { live, imgs } = await readLive(ctx, id);
    const P = plan(L, live, imgs);
    R.what = describe(P);
    // the public job log: lengths and image hashes only (the texts are on the public store page anyway, but stay out of the log)
    for (const k of Object.keys(FIELDS)) if (k in L.text) R.lines.push(`${k}: Play ${chars(norm(live[k]))} characters, repo ${chars(L.text[k])}${P.text.includes(k) ? `, differs from character ${firstDiff(L.text[k], norm(live[k]))}` : ", same"}`);
    if (L.shots) R.lines.push(`${KIND}: Play ${imgs.length} [${imgs.map(i => short(i.sha256 || i.sha1)).join(" ")}], repo ${L.shots.length} [${L.shots.map(s => short(s.sha256)).join(" ")}]` +
      (P.shots ? `, keep ${P.shots.keep}, delete ${P.shots.drop.length}, upload ${P.shots.add.length}` : ", same"));
    for (const l of R.lines) IO.out(l);
    if (P.same) { IO.out("the listing on Play already matches the repo: nothing to send"); return { ...R, code: "same" }; }

    // dry: the texts are written back exactly as Play has them (needs the store listing permission, changes nothing), then validate
    if (ctx.dry) {
      R.stage = "check";
      await play(ctx, "PATCH", `${EDITS(ctx)}/${id}${LST}`, { json: { language: LANG, ...pick(live) } });
      await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
      IO.out(`dry run: would send ${R.what}; the store listing permission was checked`);
      return { ...R, code: "dry" };
    }

    // on: texts, then images (delete the rest of Play's, upload the rest of ours), read everything back, validate, commit
    R.stage = "send";
    const want = { ...pick(live), ...Object.fromEntries(P.text.map(k => [k, L.text[k]])) };
    if (P.text.length) await play(ctx, "PATCH", `${EDITS(ctx)}/${id}${LST}`, { json: { language: LANG, ...want } });
    const ids = imgs.map(i => i.id).slice(0, P.shots ? P.shots.keep : imgs.length);
    if (P.shots) {
      for (const img of P.shots.drop) await play(ctx, "DELETE", `${EDITS(ctx)}/${id}${SHOT}/${img.id}`);
      for (const s of P.shots.add) {
        const up = (await play(ctx, "POST", `/upload${EDITS(ctx)}/${id}${SHOT}?uploadType=media`, { buf: s.buf, type: s.type })).image;
        if (!up?.id) throw new Fail(`Google Play לא החזיר מזהה לצילום ${s.name}`, "להריץ שוב בעוד כמה דקות");
        ids.push(up.id);
      }
    }
    const back = await readLive(ctx, id);
    const textOk = Object.keys(want).every(k => norm(back.live[k]) === norm(want[k]));
    const imgsOk = !L.shots || (back.imgs.map(i => i.id).join() === ids.join() && back.imgs.every((img, i) => i < P.shots?.keep || !img.sha256 || img.sha256 === L.shots[i].sha256));
    if (!textOk || !imgsOk) throw new Fail(`מה ש-Google Play שמר שונה ממה שנשלח (${!textOk ? "טקסט" : "צילומי מסך"})`, "להריץ שוב; אם זה חוזר, לבדוק את הלוג");
    await play(ctx, "POST", `${EDITS(ctx)}/${id}:validate`);
    R.stage = "commit";
    try { await play(ctx, "POST", `${EDITS(ctx)}/${id}:commit`); committed = true; }
    catch (e) {
      // a commit that got no answer may still have landed (its retry then finds no edit): look at the listing before reporting
      if (await landed(ctx, L)) committed = true; else throw e;
    }
    IO.out(`sent for review: ${R.what}`);
    return { ...R, code: "done", stage: "" };
  } catch (e) {
    return failed(R, e, R.stage);
  } finally { if (id && !committed) await dropEdit(ctx, id); }
}
const pick = live => Object.fromEntries(Object.keys(FIELDS).filter(k => typeof live[k] === "string").map(k => [k, live[k]]));
const firstDiff = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
async function landed(ctx, L) {
  try {
    const id = await insertEdit(ctx, true);
    try { const { live, imgs } = await readLive(ctx, id, true); return plan(L, live, imgs).same; }
    finally { await dropEdit(ctx, id); }
  } catch { return false; }
}
function failed(R, e, stage) {
  const f = e instanceof Fail ? e : new Fail("תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג של Store listing");
  return { ...R, code: "error", stage, why: f.why, next: f.next, status: f.status, access: !!f.access };
}

// ---- the one Telegram ----
export function compose(R, env = {}) {
  const dev = env.PLAY_DEVELOPER_ID, app = env.PLAY_APP_ID, run = env.RUN_URL || "";
  const pc = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/main-store-listing` : "https://play.google.com/console";
  const tag = hash(R.what || R.why || "-", "sha1").slice(0, 12).replace(/^\d/, "a");   // a key segment: hex with a letter, never a number
  const A = (u, t) => u ? ` <a href="${escH(u)}">${t}</a>` : "";
  if (R.code === "done") return { key: `listing:done:${tag}`, link: pc, today: "silent",
    text: msg({ kind: "done", area: "store", title: "דף החנות של לוחית ב-Google Play עודכן ונשלח לסקירה",
      text: `מה השתנה: ${escH(R.what)}. אם גרסה חדשה כבר חיכתה בסקירה, היא נשלחה שוב יחד איתו.`, what: `אין צורך לעשות כלום.${A(pc, "Play Console")}` }) };
  if (R.code === "dry") return { key: `listing:dry:${tag}`, link: run, today: "silent",
    text: msg({ kind: "info", area: "store", title: "בדיקה יבשה: דף החנות ב-Google Play היה מתעדכן",
      text: `מה היה משתנה: ${escH(R.what)}. לא נשלח כלום, כי השליחה האוטומטית במצב בדיקה.`,
      what: `כדי לשלוח: להפעיל את השליחה האוטומטית (המשתנה בפרטים הטכניים: on, או למחוק אותו), ואז Actions ← Store listing ← Run workflow עם mode=on.${A(run, "הלוג")}`,
      raw: "SHIP_TAIL=dry" }) };
  const kind = R.access ? "access" : R.stage === "files" ? "files" : "play", w = whyHe(R.why);
  return { key: `listing:fail:${kind}`, link: run, today: "loud",
    text: msg({ kind: "today", area: "store", title: "עדכון דף החנות ב-Google Play נכשל", text: `${w.he}. שום דבר בחנות לא השתנה.`,
      what: `${R.next ? escH(R.next) + "." : 'לכתוב בשרשור "מוצר ושחרורים".'}${A(run, "הלוג")}`, raw: w.raw }) };
}
async function telegram(text) {
  const r = await call("POST", `https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true }), timeout: 20000, once: true });
  IO.out(`telegram ${r.status || "no answer"}`);
  return r.ok;
}
// who hears about it: a change sent and an error, always; a dry run only when a push is held back by SHIP_TAIL=dry (a manual dry run is the
// caller's to read in the job summary); "same", "nothing" and "nosecret" only write a line
export async function tell(R) {
  const env = IO.env, manual = env.EVENT === "workflow_dispatch";
  if (!(R.code === "done" || R.code === "error" || (R.code === "dry" && !manual)) || (manual && R.mode === "dry")) return true;
  const m = compose(R, env);
  IO.summary(`### Store listing: message\n\n${m.text.replace(/https:\/\/play\.google\.com\/console\S*/g, "Play Console").replace(/\n/g, "  \n")}`);
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { note("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: the message is only in the job summary"); return true; }
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const r = router ? await router.alert("day", m.key, m.text, m.link, { today: m.today, fresh: manual, legacy: () => telegram(m.text) })
    : { delivered: await telegram(m.text) };
  // a change Play took ends every listing failure before it (access, files, Play): the router tells each one "חזר לתקין"
  if (router?.resolve && R.code === "done") try { await router.resolve(["listing:fail:"]); } catch { /* the morning ledger still shows it */ }
  return !!r.delivered;
}
function report(R) {
  const lines = [`### Store listing (${R.mode})`, "", `- result: **${R.code}**${R.stage && R.code === "error" ? ` (${R.stage})` : ""}${R.why ? `: ${R.why}` : ""}`];
  if (R.what) lines.push(`- ${R.code === "same" ? "no change" : "changes"}: ${R.what || "-"}`);
  for (const l of R.lines) lines.push(`- ${l}`);
  IO.summary(lines.join("\n"));
}

// ---- CLI ----
export async function cli(argv) {
  const cmd = argv[0] || "";
  if (cmd === "gate") {
    const g = listingGate(IO.env);
    for (const n of g.notes) note(n);
    IO.output("mode", g.mode);
    IO.out(`gate: mode=${g.mode}`);
    return 0;
  }
  if (cmd === "check") {
    const L = readLocal();
    if (!L.managed) { IO.out(`${DIR}: no listing files`); return 0; }
    for (const p of L.problems) IO.out(`::error::${DIR}: ${p}`);
    IO.out(`${DIR}: ${Object.keys(L.text).map(k => `${k} ${chars(L.text[k])}/${FIELDS[k][1]}`).join(", ")}${L.shots ? `, ${L.shots.length} screenshots` : ""}: ${L.problems.length ? "NOT OK" : "ok"}`);
    return L.problems.length ? 1 : 0;
  }
  if (cmd === "selftest") return selftest();
  if (cmd) { IO.out("usage: play-listing.mjs [gate|check|selftest]"); return 2; }
  const R = await sync();
  IO.output("code", R.code);
  report(R);
  if (R.code === "error") IO.out(`::error::Store listing ${R.stage} failed${R.status > 0 ? ` (${R.status})` : ""}: ${R.why}`);
  const told = await tell(R);
  // a push reports through the Telegram and stays green (Failure alert would repeat it); a manual run that failed is red for its caller
  return (R.code === "error" && IO.env.EVENT === "workflow_dispatch") || !told ? 1 : 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const group = async (name, fn) => { try { await fn(); } catch (e) { fails.push(`${name} crashed: ${String(e?.stack || e).split("\n").slice(0, 3).join(" | ")}`); } };
  const saved = { ...IO }, realFetch = globalThis.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
  const SA = { type: "service_account", client_email: "ship@luchit-test.iam.gserviceaccount.com", private_key: PEM };
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN-a1b2c3", TG = "777:SECRET-BOT-TOKEN-x9y8";
  const PKGP = `/androidpublisher/v3/applications/${PKG}/edits`;
  // a PNG header (signature + IHDR) and some bytes: enough for imageInfo and for the mock to tell files apart
  const png = (w, h, seed, ct = 2) => { const b = Buffer.alloc(33 + 64); b.writeUInt32BE(0x89504e47, 0); b.writeUInt32BE(0x0d0a1a0a, 4); b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); b[24] = 8; b[25] = ct; b.fill(seed, 33); return b; };
  const jpg = (w, h) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xd9]);
  const TITLE = "לוחית: בדיקת רכב ומספר רישוי", SHORT = "בדיקת רכב יד שנייה לפי מספר רישוי: בעלויות, ריקולים, טסט, ק״מ ושווי", FULL = "בדיקת רכב לפי מספר רישוי, בחינם.\nשורה שנייה.";
  const SHOTS8 = Array.from({ length: 8 }, (_, i) => png(1080, 1920, i + 1));
  const imgOf = (b, i) => ({ id: "img" + i + "x" + b[40], url: "https://play-lh.example/" + i, sha1: hash(b, "sha1"), sha256: hash(b) });
  // the repo: files under a temporary root; o.text = { field: text or null (no file) }, o.shots = buffers or null (no folder)
  const repoAt = (o = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "listing-")), d = path.join(root, DIR);
    fs.mkdirSync(d, { recursive: true });
    const text = { title: TITLE, shortDescription: SHORT, fullDescription: FULL, ...(o.text || {}) };
    for (const [k, [file]] of Object.entries(FIELDS)) if (text[k] != null) fs.writeFileSync(path.join(d, file), text[k]);
    const shots = "shots" in o ? o.shots : SHOTS8;
    if (shots) { fs.mkdirSync(path.join(d, SHOTS)); shots.forEach((b, i) => fs.writeFileSync(path.join(d, SHOTS, `${String(i + 1).padStart(2, "0")}-shot.${b[0] === 0xff ? "jpg" : "png"}`), b)); }
    for (const [n, b] of Object.entries(o.extra || {})) fs.writeFileSync(path.join(d, SHOTS, n), b);
    return root;
  };
  // a fake Play + Telegram: the listing and the images live per edit until a commit; fail[op] = statuses served before the real answer
  function world(o = {}) {
    const W = { calls: [], printed: [], outputs: {}, sums: [], tg: [], seq: 0, clock: Date.UTC(2026, 9, 18, 19), fail: structuredClone(o.fail || {}), edits: new Map(),
      listing: { language: LANG, title: TITLE, shortDescription: SHORT, fullDescription: FULL + "\n", video: "https://youtu.be/x", ...(o.live || {}) },
      imgs: (o.liveShots ?? SHOTS8).map(imgOf), other: { "en-US": { title: "Luchit" } } };
    const res = (status, body) => new Response(status === 204 ? null : JSON.stringify(body ?? {}), { status });
    const take = op => { const q = W.fail[op]; if (q && q.length) { const s = q.shift(); return typeof s === "object" ? res(s.status, { error: { message: s.msg || "x" } }) : s === 0 ? "drop" : res(s, { error: { message: "scripted " + s } }); } return null; };
    W.fetch = async (url, opt = {}) => {
      const method = opt.method || "GET", u = new URL(url), p = u.pathname;
      W.calls.push({ method, url, body: opt.body, headers: opt.headers || {} });
      if (url === TOKEN_URL) return res(200, { access_token: TOKEN, expires_in: 3599 });
      if (u.host === "api.telegram.org") { W.tg.push(J(opt.body)); return res(200, { ok: true }); }
      if (u.origin !== PLAY) return res(599, {});
      if (opt.headers?.authorization !== "Bearer " + TOKEN) return res(401, { error: { message: "no auth" } });
      const id = p.match(/edits\/([\w-]+)/)?.[1];
      if (method === "POST" && p === PKGP) { const nid = "e" + ++W.seq; W.edits.set(nid, { listing: structuredClone(W.listing), imgs: structuredClone(W.imgs) }); return res(200, { id: nid }); }
      const ed = W.edits.get(id);
      if (!ed) return res(404, { error: { message: "edit not found" } });
      const lp = `${PKGP}/${id}/listings/${LANG}`;
      if (method === "GET" && p === lp) return take("get") || (o.noListing ? res(404, { error: { message: "not found" } }) : res(200, ed.listing));
      if (method === "PATCH" && p === lp) { const e = take("patch"); if (e) return e; Object.assign(ed.listing, J(opt.body)); return res(200, ed.listing); }
      if (method === "GET" && p === lp + "/" + KIND) return take("list") || res(200, { images: o.reorder ? [...ed.imgs].reverse() : ed.imgs });
      if (method === "DELETE" && p.startsWith(lp + "/" + KIND + "/")) { ed.imgs = ed.imgs.filter(i => i.id !== p.split("/").pop()); return res(204); }
      if (method === "POST" && p === "/upload" + lp + "/" + KIND) {
        const e = take("upload"); if (e) return e;
        const b = Buffer.from(opt.body), img = imgOf(b, "u" + W.seq++);
        if (o.reencode) img.sha256 = hash(Buffer.concat([b, Buffer.from("x")]));
        ed.imgs.push(img); return res(200, { image: img });
      }
      if (method === "DELETE" && p === `${PKGP}/${id}`) { W.edits.delete(id); return res(204); }
      if (p.endsWith(":validate")) return take("validate") || res(200, {});
      if (p.endsWith(":commit")) {
        const e = take("commit");
        if (e && e !== "drop") return e;
        W.listing = ed.listing; W.imgs = ed.imgs; W.edits.delete(id);
        if (e === "drop") throw Object.assign(new Error("aborted"), { name: "AbortError" });
        return res(200, { id });
      }
      return res(400, { error: { message: "unexpected" } });
    };
    return W;
  }
  const ENV = { [SECRET]: JSON.stringify(SA, null, 2), MODE: "on", EVENT: "push", TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42", RUN_URL: "https://github.com/ddsabag/vehicle-app/actions/runs/1" };
  const run = async (o = {}, env = {}, argv = []) => {
    const W = world(o);
    globalThis.fetch = W.fetch;   // alert.mjs uses the global fetch: nothing leaves the machine
    Object.assign(IO, { env: { ...ENV, ...env }, root: repoAt(o.repo), fetch: W.fetch, now: () => W.clock, sleep: async ms => { W.clock += ms; }, deadline: 0, router: o.router || null,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s) });
    W.code = await cli(argv);
    fs.rmSync(IO.root, { recursive: true, force: true });
    W.writes = W.calls.filter(c => c.method !== "GET" && new URL(c.url).origin === PLAY).map(c => `${c.method} ${new URL(c.url).pathname.replace(/edits\/[\w-]+/, "edits/E").replace(PKGP.replace(/edits$/, ""), "")}`);
    return W;
  };
  const committed = W => W.calls.some(c => c.url.endsWith(":commit"));
  let W;

  await group("allowed", async () => {
    const E = `${PLAY}${PKGP}/e1`;
    ok(allowed("GET", `${E}/listings/iw-IL`, true) && allowed("PATCH", `${E}/listings/iw-IL`, true) && allowed("GET", `${E}/listings/iw-IL/phoneScreenshots`, true), "allowed: reads and the dry write-back");
    ok(allowed("POST", `${PLAY}/upload${PKGP}/e1/listings/iw-IL/phoneScreenshots?uploadType=media`, false) && !allowed("POST", `${PLAY}/upload${PKGP}/e1/listings/iw-IL/phoneScreenshots?uploadType=media`, true), "allowed: upload on, never dry");
    ok(allowed("POST", `${E}:commit`, false) && !allowed("POST", `${E}:commit`, true) && allowed("POST", `${E}:validate`, true), "allowed: commit on only");
    ok(allowed("DELETE", `${E}/listings/iw-IL/phoneScreenshots/abc`, false) && !allowed("DELETE", `${E}/listings/iw-IL/phoneScreenshots/abc`, true) && allowed("DELETE", E, true), "allowed: image delete on only, edit delete always");
    for (const [m, u] of [["PATCH", `${E}/listings/en-US`], ["DELETE", `${E}/listings/iw-IL`], ["DELETE", `${E}/listings/iw-IL/phoneScreenshots`], ["POST", `${PLAY}/upload${PKGP}/e1/listings/iw-IL/featureGraphic`],
      ["POST", `${PLAY}/upload${PKGP}/e1/listings/iw-IL/icon`], ["PUT", `${E}/tracks/production`], ["PUT", `${E}/listings/iw-IL`], ["PATCH", `${E}/details`], ["PATCH", `${E}/listings/iw-IL/../en-US`],
      ["PATCH", `${E}/listings/iw-IL%2F..%2Fen-US`], ["GET", `https://evil.example${PKGP}/e1/listings/iw-IL`], ["DELETE", `${E}/listings/iw-IL/tenInchScreenshots/abc`]])
      ok(!allowed(m, u, false), `allowed: refuses ${m} ${u.replace(PLAY, "")}`);
  });

  await group("gate", async () => {
    const g = (v, e) => listingGate({ SHIP_TAIL: v, REF: "refs/heads/main", ...e }).mode;
    ok(g("", { EVENT: "push" }) === "on" && g("on", { EVENT: "push" }) === "on" && g("dry", { EVENT: "push" }) === "dry" && g("off", { EVENT: "push" }) === "off", "gate: push follows SHIP_TAIL");
    ok(g("", { EVENT: "workflow_dispatch" }) === "dry" && g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "on" && g("dry", { EVENT: "workflow_dispatch", INPUT_MODE: "on" }) === "dry", "gate: manual, default dry, never above the switch");
    ok(g("", { EVENT: "workflow_dispatch", INPUT_MODE: "on", REF: "refs/heads/st-listing" }) === "dry" && g("", { EVENT: "push", REF: "refs/heads/next" }) === "off", "gate: another branch is manual dry only");
    ok(g("off", { EVENT: "workflow_dispatch", REF: "refs/heads/x" }) === "off" && g("", { EVENT: "schedule" }) === "off", "gate: off and other events run nothing");
  });

  await group("files", async () => {
    const root = repoAt({ text: { title: "﻿" + TITLE + "  \r\n" } }), L = readLocal(root);
    ok(L.managed && !L.problems.length && L.text.title === TITLE && L.shots.length === 8 && L.shots[0].type === "image/png" && L.shots[0].w === 1080, "files: read, BOM/CRLF/spaces trimmed " + L.problems);
    const bad = readLocal(repoAt({ text: { title: "א".repeat(31), shortDescription: "" }, shots: [png(1080, 1920, 1), png(1080, 2400, 2), png(200, 400, 3), png(1080, 1920, 4, 6), jpg(1080, 1920)], extra: { "notes.txt": Buffer.from("x") } }));
    const has = s => bad.problems.some(p => p.includes(s));
    ok(has("ארוך מדי: 31") && has("short-description.txt ריק") && has("הצלע הארוכה") && has("בין 320") && has("שקיפות") && has("notes.txt"), "files: every problem is listed " + JSON.stringify(bad.problems));
    ok(!has("05-shot.jpg"), "files: a valid JPEG is fine");
    ok(readLocal(repoAt({ shots: [png(1080, 1920, 1)] })).problems.some(p => p.includes("1 צילומי מסך")) && readLocal(repoAt({ shots: Array.from({ length: 9 }, (_, i) => png(1080, 1920, i + 1)) })).problems.some(p => p.includes("9 צילומי")), "files: 2 to 8 screenshots");
    const none = readLocal(repoAt({ text: { title: null, shortDescription: null, fullDescription: null }, shots: null }));
    ok(!none.managed, "files: no files = not managed");
    // check: the offline command the Alert router check runs
    W = await run({ repo: { text: { title: "א".repeat(31) } } }, {}, ["check"]);
    ok(W.code === 1 && W.printed.some(l => l.startsWith("::error::") && l.includes("31")) && W.calls.length === 0, "check: a too-long title is red, offline");
    W = await run({}, {}, ["check"]);
    ok(W.code === 0 && W.printed.some(l => l.endsWith(": ok")), "check: ok");
  });

  await group("same", async () => {
    // Play already matches (its trailing newline included): nothing written, no Telegram, the edit deleted
    W = await run();
    ok(W.code === 0 && W.outputs.code === "same" && !committed(W) && W.tg.length === 0 && W.edits.size === 0, "same: " + W.writes);
    ok(W.writes.filter(w => !w.startsWith("DELETE")).length === 1, "same: only the edit insert " + W.writes);
  });

  await group("text", async () => {
    // one field changed: one PATCH with that field new and the others as Play has them (video untouched), read back, validate, commit
    W = await run({ repo: { text: { shortDescription: "בדיקת רכב לפי מספר רישוי" } } });
    const patch = J(W.calls.find(c => c.method === "PATCH").body);
    ok(W.outputs.code === "done" && committed(W) && W.listing.shortDescription === "בדיקת רכב לפי מספר רישוי" && W.listing.title === TITLE && W.listing.video === "https://youtu.be/x", "text: sent " + W.outputs.code + W.printed.slice(-3));
    ok(patch.language === LANG && patch.fullDescription === FULL + "\n" && !("video" in patch), "text: unchanged fields as Play has them " + JSON.stringify(patch).slice(0, 80));
    ok(!W.calls.some(c => c.url.includes("/upload/") || (c.method === "DELETE" && c.url.includes(KIND))), "text: no image touched");
    ok(W.tg.length === 1 && W.tg[0].text.includes("התיאור הקצר") && W.tg[0].text.includes("נשלח לסקירה"), "text: one Telegram " + W.tg.map(x => x.text));
    // a field without a file stays as on Play
    W = await run({ repo: { text: { fullDescription: null, title: "לוחית: בדיקת רכב" } } });
    ok(W.outputs.code === "done" && W.listing.fullDescription === FULL + "\n" && W.listing.title === "לוחית: בדיקת רכב", "text: a missing file leaves the field");
  });

  await group("images", async () => {
    // the last screenshot changed: one image deleted, one uploaded, the first seven untouched
    const shots = [...SHOTS8.slice(0, 7), png(1080, 1920, 99)];
    W = await run({ repo: { shots } });
    const del = W.calls.filter(c => c.method === "DELETE" && c.url.includes(KIND + "/")), up = W.calls.filter(c => c.url.includes("/upload/"));
    ok(W.outputs.code === "done" && del.length === 1 && del[0].url.endsWith(imgOf(SHOTS8[7], 7).id) && up.length === 1 && Buffer.compare(Buffer.from(up[0].body), shots[7]) === 0, "images: replace the last only");
    ok(W.imgs.map(i => i.sha256).join() === shots.map(b => hash(b)).join() && up[0].headers["content-type"] === "image/png", "images: order on Play = repo");
    ok(W.tg[0]?.text.includes("מספר 8 חדש"), "images: told which " + W.tg.map(x => x.text));
    // the second one changed: 2-8 replaced, in order
    const s2 = [SHOTS8[0], png(1080, 1920, 50), ...SHOTS8.slice(2)];
    W = await run({ repo: { shots: s2 } });
    ok(W.outputs.code === "done" && W.calls.filter(c => c.url.includes("/upload/")).length === 7 && W.imgs.map(i => i.sha256).join() === s2.map(b => hash(b)).join(), "images: a middle change re-sends the rest in order");
    // fewer screenshots: only deletes
    W = await run({ repo: { shots: SHOTS8.slice(0, 6) } });
    ok(W.outputs.code === "done" && !W.calls.some(c => c.url.includes("/upload/")) && W.imgs.length === 6 && W.tg[0]?.text.includes("2 הוסרו"), "images: fewer = deletes only");
    // no folder: images untouched even when Play differs
    W = await run({ repo: { shots: null }, liveShots: SHOTS8.slice(0, 3) });
    ok(W.outputs.code === "same", "images: no folder = not managed");
    // Play keeps something else than sent (order or bytes): nothing committed
    W = await run({ repo: { shots }, reorder: true });
    ok(W.outputs.code === "error" && !committed(W) && W.edits.size === 0 && W.tg.length === 1, "images: wrong order read back -> not committed");
    W = await run({ repo: { shots }, reencode: true });
    ok(W.outputs.code === "error" && !committed(W), "images: other bytes read back -> not committed");
  });

  await group("dry", async () => {
    // dry: reads, writes the texts back as they are inside a throwaway edit, validates, deletes it; never uploads, deletes an image or commits
    const shots = [...SHOTS8.slice(0, 7), png(1080, 1920, 99)];
    W = await run({ repo: { shots, text: { title: "חדש" } } }, { MODE: "dry", EVENT: "workflow_dispatch" });
    const patch = J(W.calls.find(c => c.method === "PATCH")?.body || "{}");
    ok(W.outputs.code === "dry" && !committed(W) && !W.calls.some(c => c.url.includes("/upload/") || (c.method === "DELETE" && c.url.includes(KIND))) && W.edits.size === 0, "dry: nothing sent " + W.writes);
    ok(patch.title === TITLE && W.listing.title === TITLE, "dry: the write-back is Play's own text");
    ok(W.tg.length === 0 && W.code === 0 && W.sums.some(s => s.includes("הכותרת")), "dry manual: job summary only");
    W = await run({ repo: { shots } }, { MODE: "dry", EVENT: "push" });
    ok(W.outputs.code === "dry" && W.tg.length === 1 && W.tg[0].text.includes("SHIP_TAIL") && W.tg[0].parse_mode === "HTML", "dry push (SHIP_TAIL=dry): one Telegram");
    W = await run({ fail: { patch: [403] } }, { MODE: "dry", EVENT: "workflow_dispatch" });
    ok(W.outputs.code === "same" && !W.calls.some(c => c.method === "PATCH"), "dry with nothing to change: no permission probe needed");
    W = await run({ repo: { text: { title: "חדש" } }, fail: { patch: [403] } }, { MODE: "dry", EVENT: "workflow_dispatch" });
    ok(W.outputs.code === "error" && W.code === 1 && W.printed.some(l => l.includes("::error::")) && W.sums.some(s => s.includes("אין הרשאה")), "dry: a missing permission is red for the caller");
  });

  await group("errors", async () => {
    W = await run({ repo: { text: { title: "חדש" } }, fail: { patch: [403] } });
    ok(W.outputs.code === "error" && !committed(W) && W.edits.size === 0 && W.code === 0, "403: nothing committed, edit deleted, push stays green");
    ok(W.tg.length === 1 && W.tg[0].text.includes(PERM_LISTING) && W.tg[0].text.includes("שום דבר בחנות לא השתנה"), "403: the permission to add " + W.tg.map(x => x.text));
    W = await run({ repo: { text: { title: "א".repeat(31) } } });
    ok(W.outputs.code === "error" && W.calls.every(c => new URL(c.url).origin !== PLAY) && W.tg.length === 1 && W.tg[0].text.includes("ארוך מדי"), "bad files: Play never asked, told");
    W = await run({ repo: { text: { title: "חדש" } }, fail: { commit: [0] } });
    ok(W.outputs.code === "done" && W.listing.title === "חדש", "commit without an answer that landed = done");
    W = await run({ repo: { text: { title: "חדש" } }, fail: { commit: [500, 500, 500, 500] } });
    ok(W.outputs.code === "error" && W.listing.title === TITLE && W.edits.size === 0, "commit 5xx x4: error, nothing changed");
    W = await run({ repo: { text: { title: "חדש" } }, fail: { upload: [] }, noListing: true });
    ok(W.outputs.code === "error" && W.tg[0]?.text.includes("iw-IL"), "no Hebrew listing: error, nothing created");
    W = await run({}, { [SECRET]: "" });
    ok(W.outputs.code === "nosecret" && W.code === 0 && W.calls.length === 0 && W.tg.length === 0, "no secret: one notice, green");
    W = await run({ repo: { text: { title: null, shortDescription: null, fullDescription: null }, shots: null } });
    ok(W.outputs.code === "nothing" && W.calls.length === 0, "no files: nothing");
    W = await run({}, { [SECRET]: "{not json" });
    ok(W.outputs.code === "error" && W.tg.length === 1, "broken secret: error, told");
  });

  await group("router", async () => {
    // through the router: level day, a valid key per kind, fresh on a manual run
    const seen = [], router = { alert: async (lv, key, text, link, o) => { seen.push({ lv, key, link, o }); return { delivered: true }; } };
    const { validKey } = await import("./alert.mjs");
    W = await run({ router, repo: { text: { title: "חדש" } } });
    W = await run({ router, repo: { text: { title: "חדש" } }, fail: { patch: [403] } }, { EVENT: "workflow_dispatch" });
    W = await run({ router, repo: { text: { title: "א".repeat(31) } } });
    W = await run({ router, repo: { text: { title: "חדש" } } }, { MODE: "dry" });
    ok(seen.map(s => s.key.split(":").slice(0, 3).join(":").replace(/:[0-9a-f]{12}$/, "")).join() === "listing:done,listing:fail:access,listing:fail:files,listing:dry", "router: keys " + seen.map(s => s.key));
    ok(seen.every(s => s.lv === "day" && validKey(s.key) && !s.o.plain) && seen[1].o.fresh && !seen[0].o.fresh, "router: day, valid keys, fresh when manual");
    // a change Play took closes the listing failures; a failure, a dry run or nothing to change leaves them open
    const settled = [], r2 = { alert: async () => ({ delivered: true }), resolve: async p => { settled.push(p.join("|")); return 1; } };
    W = await run({ router: r2, repo: { text: { title: "חדש" } } });
    W = await run({ router: r2, repo: { text: { title: "חדש" } }, fail: { patch: [403] } });
    W = await run({ router: r2, repo: { text: { title: "חדש" } } }, { MODE: "dry" });
    W = await run({ router: r2 });
    ok(settled.join() === "listing:fail:", "router: only a change Play took closes the listing failures " + settled);
  });

  await group("secrets", async () => {
    const pemBody = PEM.split("\n").slice(2, 4).join("");
    for (const [o, env] of [[{}, {}], [{ repo: { text: { title: "חדש" } } }, {}], [{ repo: { text: { title: "חדש" } }, fail: { patch: [403] } }, {}], [{}, { MODE: "dry", EVENT: "workflow_dispatch" }]]) {
      W = await run(o, env);
      const all = [...W.printed, ...Object.values(W.outputs), ...W.sums, ...W.tg.map(x => x.text)].join("\n");
      ok(![pemBody, TOKEN, TG, "PRIVATE KEY", SA.client_email, FULL.slice(0, 20)].some(x => all.includes(x)), "secrets and texts stay out of the output " + JSON.stringify(o).slice(0, 60));
    }
  });

  Object.assign(IO, saved); globalThis.fetch = realFetch;
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("play-listing.mjs")) process.exit(await cli(process.argv.slice(2)));
