// Ship tail, Data safety part (a step of store-listing.yml): sends .github/store-listing/data-safety.csv to Google Play as the app's Data
// safety declaration (applications.dataSafety; the file is Play Console's own "Export to CSV" of the form, edited only where an answer
// changes). Google has no call that reads the declaration back, so a push sends the file only when it changed since the last push run
// that finished green (the workflow compares the file there and here and passes CHANGED; anything but "false" counts as changed), and a
// manual run only with data_safety=send (SEND). A file that is not a Data safety CSV stops the run before Google is asked anything. One
// request, nothing else: no edit, no track, no listing.
// Node 20, node: builtins only. Commands:
//   node play-data-safety.mjs           SHIP_SA_JSON, MODE (on|dry), CHANGED, SEND, EVENT, RUN_URL -> code (sent|same|dry|none|nosecret|error);
//                                       one Telegram (alert.mjs) when it was sent or failed
//   node play-data-safety.mjs check     the file only, offline (the Alert router check runs it on next before a release)
//   node play-data-safety.mjs selftest  offline (mocked fetch, temporary files)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { jwt, Fail, playFail, PKG, SECRET } from "./play-alpha.mjs";

export const FILE = ".github/store-listing/data-safety.csv", MAX_BYTES = 512 * 1024, MIN_ROWS = 10;
export const PERM_SAFETY = "Manage store presence";   // the account's store permission; if Google asks for another, the 403 text says so
const AGAIN = "Actions ← Store listing ← Run workflow עם mode=on ו-data_safety=send";
const PLAY = "https://androidpublisher.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";

const IO = {
  env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), root: process.cwd(), router: null,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const note = s => IO.out("::notice::" + s);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");

// ---- the file: Play's export (a header with "Question ID", the same number of columns on every row) ----
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (q) return null;
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x !== ""));
}
export function readFile(root = IO.root) {
  const f = path.join(root, FILE);
  if (!fs.existsSync(f)) return { exists: false, problems: [] };
  const buf = fs.readFileSync(f), text = buf.toString("utf8"), problems = [];
  const rows = buf.length <= MAX_BYTES ? parseCsv(text.replace(/^﻿/, "")) : null;
  if (buf.length > MAX_BYTES) problems.push(`הקובץ גדול מ-${MAX_BYTES / 1024}KB`);
  else if (!rows) problems.push("הקובץ אינו CSV תקין (מירכאות לא סגורות)");
  else {
    const head = rows[0] || [];
    if (!head.some(h => /question id/i.test(h))) problems.push('השורה הראשונה אינה הכותרת של Data safety (חסר "Question ID"): צריך את הקובץ שיוצא מ-Play Console ב-Export to CSV');
    const bad = rows.findIndex(r => r.length !== head.length);
    if (bad > 0) problems.push(`בשורה ${bad + 1} יש ${rows[bad].length} עמודות, בכותרת ${head.length}`);
    if (rows.length - 1 < MIN_ROWS) problems.push(`רק ${Math.max(0, rows.length - 1)} שורות תשובה`);
  }
  return { exists: true, text, problems, rows: rows ? rows.length - 1 : 0, hash: sha(buf) };
}

// ---- HTTP ----
async function call(method, url, { headers = {}, body, timeout = 60000 } = {}) {
  for (let i = 0; ; i++) {
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), timeout);
    try {
      const r = await IO.fetch(url, { method, headers, body, signal: c.signal });
      res = { status: r.status, ok: r.ok, text: await r.text() };
    } catch (e) { res = { status: 0, ok: false, text: "network: " + String(e?.name === "AbortError" ? "timeout" : e?.message || e).slice(0, 80) }; }
    finally { clearTimeout(t); }
    // the write itself is sent once: a lost answer is not repeated (the same file again would be harmless, but the run says what it knows)
    if (res.ok || (res.status && res.status < 500 && res.status !== 429) || i === 2 || url.endsWith("/dataSafety")) return res;
    await new Promise(r => setTimeout(r, IO.env.SELFTEST ? 0 : 2000 * 2 ** i));
  }
}
export function allowed(method, url) {
  let u; try { u = new URL(url); } catch { return false; }
  return method === "POST" && u.origin === PLAY && !u.search && /^\/androidpublisher\/v3\/applications\/[\w.]+\/dataSafety$/.test(u.pathname) && url === PLAY + u.pathname;
}
async function accessToken(sa) {
  let assertion;
  try { assertion = jwt(sa, SCOPE, IO.now()); } catch { throw new Fail(`המפתח בסוד ${SECRET} לא תקין`, `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בשלמותו בסוד ${SECRET}`); }
  const r = await call("POST", TOKEN_URL, { headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const t = r.ok && J(r.text)?.access_token;
  if (t) return t;
  throw new Fail(r.status === 400 || r.status === 401 ? "Google לא קיבל את מפתח חשבון השירות" : `ההתחברות ל-Google לא הצליחה (${r.status || "אין חיבור"})`,
    r.status === 400 || r.status === 401 ? `ליצור מפתח JSON חדש לחשבון השירות ולהדביק אותו בסוד ${SECRET}` : "להריץ שוב בעוד כמה דקות", r.status);
}

// ---- the run ----
export async function run() {
  const env = IO.env, mode = env.MODE === "on" ? "on" : "dry";
  const R = { code: "", mode, rows: 0, hash: "", why: "", next: "", kind: "" };
  let F;
  try { F = readFile(); } catch (e) { return { ...R, code: "error", kind: "files", why: "הקובץ לא נקרא: " + String(e?.message || e).slice(0, 80) }; }
  if (!F.exists) { IO.out(`${FILE} is not in the repo: Data safety stays as it is on Play`); return { ...R, code: "none" }; }
  Object.assign(R, { rows: F.rows, hash: F.hash.slice(0, 12) });
  if (F.problems.length) return { ...R, code: "error", kind: "files", why: F.problems.slice(0, 3).join("; "), next: `לתקן את ${FILE} ב-main` };
  const manual = env.EVENT === "workflow_dispatch";
  if (manual ? env.SEND !== "send" : env.CHANGED === "false") {
    IO.out(`Data safety ${R.hash} (${F.rows} answers): ${manual ? "a manual run sends it only with data_safety=send" : "the same as at the last push run that finished, nothing to send"}`);
    return { ...R, code: "same" };
  }
  if (mode !== "on") { IO.out(`dry run: would send Data safety ${R.hash} (${F.rows} answers)`); return { ...R, code: "dry" }; }
  const raw = String(env[SECRET] || "").trim();
  if (!raw) { note(`${SECRET} is not set: Data safety is not sent`); return { ...R, code: "nosecret" }; }
  try {
    const sa = J(raw);
    if (!sa?.client_email || !sa?.private_key) throw new Fail(`הסוד ${SECRET} אינו מפתח JSON של חשבון שירות`, `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח`);
    const token = await accessToken(sa), url = `${PLAY}/androidpublisher/v3/applications/${env.PLAY_PACKAGE || PKG}/dataSafety`;
    if (!allowed("POST", url)) throw new Fail("refused: " + url.replace(PLAY, ""), "", -1);
    const r = await call("POST", url, { headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ safetyLabels: F.text }) });
    if (!r.ok) {
      const f = playFail(r), msg = String(J(r.text)?.error?.message || "").replace(/\s+/g, " ").slice(0, 200);
      if ((r.status === 401 || r.status === 403) && !/ה-API של Google Play כבוי/.test(f.why))
        throw Object.assign(new Fail("לחשבון השירות אין הרשאה לעדכן את Data safety", `Play Console ← Users and permissions ← ship-tail ← App permissions ← לוחית: לסמן את ההרשאה לדף החנות ולהצהרות (App content), ואז ${AGAIN}${msg ? `. Google: ${msg}` : ""}`, r.status), { access: true });
      if (r.status === 400 && msg) throw new Fail(`Google Play לא קיבל את הקובץ: ${msg}`, `לתקן את ${FILE} (או לייצא אותו מחדש מ-Play Console) ולדחוף ל-main`, 400);
      if (!r.status) throw new Fail("Google Play לא ענה על השליחה", `לבדוק ב-Play Console ← App content ← Data safety; אם לא התעדכן: ${AGAIN}`, 0);
      throw f;
    }
    IO.out(`sent: Data safety ${R.hash} (${F.rows} answers)`);
    return { ...R, code: "sent" };
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג של Store listing");
    return { ...R, code: "error", kind: f.access ? "access" : "play", why: f.why, next: f.next, status: f.status };
  }
}

// ---- the one Telegram ----
export function compose(R, env = {}) {
  const dev = env.PLAY_DEVELOPER_ID, app = env.PLAY_APP_ID, run = env.RUN_URL || "";
  const pc = dev && app ? `https://play.google.com/console/developers/${dev}/app/${app}/app-content/data-privacy-security` : "https://play.google.com/console";
  const tag = (R.hash || "x").replace(/^\d/, "a");
  if (R.code === "sent") return { key: `safety:done:${tag}`, link: pc, text: `ה-Data safety של לוחית ב-Google Play עודכן מהקובץ ב-GitHub (${R.rows} תשובות).\n${pc}` };
  return { key: `safety:fail:${R.kind || "play"}`, link: run, text: `עדכון ה-Data safety ב-Google Play נכשל: ${R.why}.${R.next ? `\nמה לעשות: ${R.next}.` : ""}${run ? `\n${run}` : ""}` };
}
async function telegram(text) {
  const r = await call("POST", `https://api.telegram.org/bot${IO.env.TELEGRAM_BOT_TOKEN}/sendMessage`, { headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: IO.env.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true }), timeout: 20000 });
  IO.out(`telegram ${r.status || "no answer"}`);
  return r.ok;
}
// who hears: sent and error (a manual dry run is the caller's to read); same, dry, none and nosecret only write a line
export async function tell(R) {
  if (!["sent", "error"].includes(R.code)) return true;
  const m = compose(R, IO.env);
  IO.summary(`### Data safety: message\n\n${m.text.replace(/https:\/\/play\.google\.com\/console\S*/g, "Play Console").replace(/\n/g, "  \n")}`);
  if (!IO.env.TELEGRAM_BOT_TOKEN || !IO.env.TELEGRAM_CHAT_ID) { note("TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID are not set: the message is only in the job summary"); return true; }
  let router = IO.router;
  if (!router) try { router = await import("./alert.mjs"); } catch { /* legacy below */ }
  const r = router ? await router.alert("day", m.key, m.text, m.link, { today: "loud", plain: true, fresh: IO.env.EVENT === "workflow_dispatch", legacy: () => telegram(m.text) })
    : { delivered: await telegram(m.text) };
  return !!r.delivered;
}

// ---- CLI ----
export async function cli(argv) {
  const cmd = argv[0] || "";
  if (cmd === "check") {
    const F = readFile();
    if (!F.exists) { IO.out(`${FILE}: not in the repo`); return 0; }
    for (const p of F.problems) IO.out(`::error::${FILE}: ${p}`);
    IO.out(`${FILE}: ${F.rows} answers, ${F.hash.slice(0, 12)}: ${F.problems.length ? "NOT OK" : "ok"}`);
    return F.problems.length ? 1 : 0;
  }
  if (cmd === "selftest") return selftest();
  if (cmd) { IO.out("usage: play-data-safety.mjs [check|selftest]"); return 2; }
  const R = await run();
  IO.output("code", R.code);
  IO.summary([`### Data safety (${R.mode})`, "", `- result: **${R.code}**${R.why ? `: ${R.why}` : ""}`, R.hash ? `- file: ${R.hash}, ${R.rows} answers` : ""].filter(Boolean).join("\n"));
  if (R.code === "error") IO.out(`::error::Data safety failed${R.status > 0 ? ` (${R.status})` : ""}: ${R.why}`);
  const told = await tell(R);
  // a push reports through the Telegram and stays green; a manual run that failed is red for its caller
  return (R.code === "error" && IO.env.EVENT === "workflow_dispatch") || !told ? 1 : 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const saved = { ...IO }, realFetch = globalThis.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const SA = { type: "service_account", client_email: "ship@luchit-test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const TOKEN = "ya29.SECRET-ACCESS-TOKEN-ds1", TG = "777:SECRET-BOT-TOKEN-ds2";
  const HEAD = "Question ID (machine readable),Response ID (machine readable),Response value,Answer requirement,Human-friendly question label";
  const ROWS = Array.from({ length: 30 }, (_, i) => `PSL_Q${i},PSL_R${i},${i % 2 ? "true" : ""},OPTIONAL,"Question ${i}, with a comma and ""quotes"""`);
  const GOOD = "﻿" + [HEAD, ...ROWS].join("\r\n") + "\r\n";
  const repo = text => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "ds-")); if (text != null) { fs.mkdirSync(path.join(root, path.dirname(FILE)), { recursive: true }); fs.writeFileSync(path.join(root, FILE), text); } return root; };
  const go = async (o = {}, env = {}, argv = []) => {
    const W = { calls: [], printed: [], outputs: {}, sums: [], tg: [], posted: null };
    W.fetch = async (url, opt = {}) => {
      W.calls.push({ url, method: opt.method });
      const u = new URL(url), res = (s, b) => new Response(JSON.stringify(b ?? {}), { status: s });
      if (url === TOKEN_URL) return res(200, { access_token: TOKEN });
      if (u.host === "api.telegram.org") { W.tg.push(J(opt.body)); return res(200, { ok: true }); }
      if (u.origin === PLAY && u.pathname.endsWith("/dataSafety") && opt.headers?.authorization === "Bearer " + TOKEN) {
        if (o.status) return res(o.status, { error: { message: o.msg || "scripted" } });
        if (o.drop) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        W.posted = J(opt.body); return res(200, {});
      }
      return res(404, {});
    };
    globalThis.fetch = W.fetch;
    Object.assign(IO, { env: { [SECRET]: JSON.stringify(SA), MODE: "on", EVENT: "push", CHANGED: "true", TELEGRAM_BOT_TOKEN: TG, TELEGRAM_CHAT_ID: "42", RUN_URL: "https://github.com/x/actions/runs/1", SELFTEST: "1", ...env },
      fetch: W.fetch, root: repo("text" in o ? o.text : GOOD), router: o.router || null,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s) });
    W.code = await cli(argv);
    return W;
  };
  let W;
  try {
    ok(parseCsv('a,"b,c",d\n1,"x ""y""",3\n')?.[1]?.[1] === 'x "y"' && parseCsv('a,"b\n') === null, "csv: quotes and an unclosed quote");
    W = await go();
    ok(W.outputs.code === "sent" && W.code === 0 && W.posted?.safetyLabels === GOOD && W.tg.length === 1 && W.tg[0].text.includes("30 תשובות"), "sent: the file as it is, one Telegram " + W.printed.join(" | "));
    W = await go({}, { CHANGED: "false" });
    ok(W.outputs.code === "same" && !W.calls.length && !W.tg.length, "a push that did not change it: nothing is called");
    W = await go({}, { CHANGED: "" });
    ok(W.outputs.code === "sent", "a push whose compare did not answer: sent");
    W = await go({}, { CHANGED: "true", EVENT: "workflow_dispatch" });
    ok(W.outputs.code === "same" && !W.calls.length && W.code === 0, "a manual run without data_safety=send: nothing is called");
    W = await go({}, { CHANGED: "false", EVENT: "workflow_dispatch", SEND: "send" });
    ok(W.outputs.code === "sent", "a manual run with data_safety=send sends it");
    W = await go({}, { EVENT: "workflow_dispatch", SEND: "send", MODE: "dry" });
    ok(W.outputs.code === "dry" && !W.calls.length, "a manual dry run with send: nothing is called");
    W = await go({}, { MODE: "dry" });
    ok(W.outputs.code === "dry" && !W.calls.length && !W.tg.length, "dry: nothing is called");
    W = await go({ text: null });
    ok(W.outputs.code === "none" && !W.calls.length && W.code === 0, "no file: nothing");
    for (const [name, text] of [["not the export", "a,b,c\n" + ROWS.join("\n")], ["ragged", HEAD + "\n" + ROWS.join("\n") + "\nx,y"], ["short", HEAD + "\n" + ROWS.slice(0, 3).join("\n")], ["open quote", HEAD + '\n"x,y']]) {
      W = await go({ text });
      ok(W.outputs.code === "error" && !W.calls.some(c => c.url.startsWith(PLAY)) && W.tg[0]?.text.includes("נכשל") && W.code === 0, `bad file (${name}): stopped before Play ` + W.tg.map(x => x.text));
    }
    W = await go({ text: "x,y" }, {}, ["check"]);
    ok(W.code === 1 && W.printed.some(l => l.startsWith("::error::")), "check: a bad file is red");
    W = await go({}, {}, ["check"]);
    ok(W.code === 0 && W.printed.some(l => l.includes("30 answers") && l.endsWith("ok")), "check: the good file");
    W = await go({ status: 403, msg: "The caller does not have permission" });
    ok(W.outputs.code === "error" && W.tg[0]?.text.includes("אין הרשאה") && W.tg[0].text.includes("The caller does not have permission") && W.tg[0].text.includes("data_safety=send"), "403: the permission, with Google's words " + W.tg.map(x => x.text));
    W = await go({ status: 400, msg: "Invalid value for PSL_Q3" });
    ok(W.outputs.code === "error" && W.tg[0]?.text.includes("Invalid value for PSL_Q3"), "400: Google's reason");
    W = await go({ drop: true });
    ok(W.outputs.code === "error" && W.calls.filter(c => c.url.endsWith("/dataSafety")).length === 1 && W.tg[0]?.text.includes("לא ענה"), "no answer: sent once, told to look");
    W = await go({ status: 403 }, { EVENT: "workflow_dispatch", SEND: "send" });
    ok(W.code === 1, "manual error: red");
    ok(allowed("POST", `${PLAY}/androidpublisher/v3/applications/${PKG}/dataSafety`) && !allowed("GET", `${PLAY}/androidpublisher/v3/applications/${PKG}/dataSafety`)
      && !allowed("POST", `${PLAY}/androidpublisher/v3/applications/${PKG}/edits`) && !allowed("POST", `https://evil.example/androidpublisher/v3/applications/${PKG}/dataSafety`)
      && !allowed("POST", `${PLAY}/androidpublisher/v3/applications/${PKG}/dataSafety?x=1`), "allowed: the one call");
    const keys = [], router = { alert: async (lv, key) => { keys.push(key); return { delivered: true }; } };
    const { validKey } = await import("./alert.mjs");
    await go({ router }); await go({ router, status: 403 }); await go({ router, text: "x" });
    ok(keys.length === 3 && keys[0].startsWith("safety:done:") && keys[1] === "safety:fail:access" && keys[2] === "safety:fail:files" && keys.every(validKey), "router keys " + keys);
    W = await go();
    const all = [...W.printed, ...W.sums, ...Object.values(W.outputs), ...W.tg.map(x => x.text)].join("\n");
    ok(![TOKEN, TG, "PRIVATE KEY", SA.client_email].some(x => all.includes(x)), "secrets stay out of the output");
  } catch (e) { fails.push("crashed: " + String(e?.stack || e).split("\n").slice(0, 3).join(" | ")); }
  Object.assign(IO, saved); globalThis.fetch = realFetch;
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("play-data-safety.mjs")) process.exit(await cli(process.argv.slice(2)));
