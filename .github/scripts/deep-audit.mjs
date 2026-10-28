// Monthly deep audit (use #7 of the monthly Claude API credit, Dudu "אין לי התנגדות" 28.10.2026): about 100 real cars, each read twice.
// site-data-audit.mjs opens every car in the checkout's index.html like a user and checks it with its fixed rules, as the daily audit does,
// and writes one plate-free file per car (DEEP_OUT): the page's text, the ministry's rows it was read against, and what the rules found.
// Claude (the large model, in a Message Batch) then reads each car as a senior auditor of Israeli vehicle data and as a buyer would: what
// the page states that the rows contradict, what the rows hold that the page leaves out, what contradicts itself between tabs, what could
// mislead a buyer. A finding is kept only when its quotes are real: every page excerpt it cites is on the page, and every field=value it
// cites is in the rows. What the rules did not catch is the point: each such finding is a candidate for a new rule in site-data-audit.mjs.
// Private by design: the cars are drawn with a random seed that is never printed or kept; no plate, VIN or engine number reaches a prompt
// (deepClean, used by the snapshot); the full results are encrypted with .github/seo-data.pub.pem (deep-audit.enc.json on the branch
// data-truth; the project's seo-key/decrypt.mjs reads it); in the clear only counts (deep-summary.json). The router hears one quiet line:
// truth:deep:<areas> (news, for the data thread to turn into rules; Dudu does nothing) when confirmed findings the rules missed exist,
// truth:deep-fail when too few cars could be read, ai:audit when the API failed (ai:key when the key or the credit is the cause); a good
// month closes what is its own. Nothing here logs a plate, a cost or a token count.
//   env   QUERIES="n=80 rare=20 minutes=140 wait=180 effort=medium max=120 dry=1"   OUT=<dir> (default out)
//   node deep-audit.mjs --selftest   offline: the scrub, the quote checks, the encryption, whole runs through a fake audit and a fake API
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { client, batch, answer, usage } from "./claude.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL = "claude-opus-5-5", PROMPT_V = 2, MIN_CARS = 10;
const PAGE_MAX = 36000, ROWS_MAX = 24000;   // characters of one car's page and rows in its prompt: a car's cost has a ceiling
// the page's areas, the ids of the daily audit's GROUPS (site-data-truth.mjs) and of the router's truth labels
export const AREAS = { identity: "פרטי הרכב", status: "סטטוס הרכב", test: "טסט", road: "עלייה לכביש", owners: "בעלויות", km: "ק״מ", recalls: "ריקולים",
  settlements: "הסדרי פשרה", tow: "גרירה", specs: "מפרט", mods: "שינויים ברכב", fee: "אגרת רישוי", price: "מחיר מחירון", value: "שווי", insight: "תובנות",
  message: "הודעות", other: "אחר" };
const KINDS = { wrong: "שגוי", missing: "חסר", contradiction: "סותר", misleading: "מטעה" }, SEV = ["high", "medium", "low"];

// the car's own plate, VIN and engine number in every form the page and the rows write them, then anything plate-, VIN- or number-like
export function deepClean(own) {
  const forms = new Set(own.map(v => String(v ?? "").trim()).filter(v => v.length >= 4).flatMap(v => /^\d+$/.test(v)
    ? [v, v.replace(/^0+/, ""), v.length === 7 ? `${v.slice(0, 2)}-${v.slice(2, 5)}-${v.slice(5)}` : v.length === 8 ? `${v.slice(0, 3)}-${v.slice(3, 5)}-${v.slice(5)}` : v] : [v]).filter(v => v.length >= 4));
  const list = [...forms].sort((a, b) => b.length - a.length);   // the longest form first, so a dashed plate goes whole
  return x => { let t = String(x ?? ""); for (const f of list) t = t.split(f).join("<id>");
    return t.replace(/\b\d{2}x{2,5}\d{2}\b/g, "<plate>").replace(/\b\d{2,3}-\d{2,3}-\d{2,3}\b/g, "<plate>").replace(/(?<![\d,.])\d{7,8}(?![\d,.])/g, "<n>").replace(/\b[A-HJ-NPR-Z0-9]{17}\b/g, "<vin>"); };
}
// a last look before anything leaves the runner: no plate-like or VIN-like run in a prompt
const PLATE_LIKE = /\b\d{2,3}-\d{2,3}-\d{2,3}\b|(?<![\d,.])\d{7,8}(?![\d,.])|\b[A-HJ-NPR-Z0-9]{17}\b|\b\d{2}x{2,5}\d{2}\b/;
export const plateFree = s => !PLATE_LIKE.test(s);
// where such a run sits, by the prompt's section and the row's field name only, never the text: "" when there is none
export function leakWhere(p) {
  let sec = "";
  for (const l of String(p).split("\n")) {
    const h = /^(\[header\]|\[tab [\w-]+\]|== [^=]+ ==|[a-z][\w ]*(?: \([^)]*\))?:)/.exec(l);
    if (h) sec = h[1].replace(/:$/, "").replace(/ \(\d+ rows\)$/, "");
    if (!PLATE_LIKE.test(l)) continue;
    const f = l.startsWith("- ") ? l.slice(2).split("; ").find(x => PLATE_LIKE.test(x)) : null;
    return [sec || "?", f ? f.split("=")[0] : ""].filter(Boolean).join(" ").slice(0, 80);
  }
  return "";
}

const SYSTEM = `You audit what לוחית shows for one car. לוחית is an Israeli app that checks a car by its licence plate in the Ministry of Transport's open data: a buyer types the plate and reads the car's page. For one car you get:
1. The page as the buyer saw it: the header and the text of every tab. An icon is written as a mark before its words: ✓ a check (present, passed), ✗ crossed out (absent), ⚠ a warning, ℹ a note.
2. The ministry's rows the page is built from: the registers' rows for this car, the model's data, the price list, the model's recall rows that name this model, and the car's own open recall rows. Plates, VINs and engine numbers are replaced by <id>, <plate>, <vin> or <n>.
   The model's recall rows are at most 30: those whose production years include this car first (years), then the newest. carList says whether the ministry's per-car list of open recalls covers the recall. For a covered recall the car's own open recall rows decide: one that is not among them is closed or not this car's, and the page rightly does not show it as open. For one it does not cover (too new, missing), the data cannot tell whether it is open on this car.
3. What the app's fixed checks already found wrong on this page (may be none).

Read it as a senior auditor of Israeli vehicle data and as a buyer about to pay for this car, and find what is wrong or could mislead:
- wrong: the page states something the rows contradict (a date, a count, a type, a status, a value, a recall).
- missing: the rows hold something a buyer needs that the page does not show (an ownership change, a test date, an open recall, a registered change to the car, an off-road status).
- contradiction: two places on the page disagree with each other.
- misleading: true, but worded so a buyer could conclude something wrong (a pill, a summary line or an insight that overstates or understates).

How to report:
- Only what the material shows. page: the exact words of the page, one excerpt copied character for character (at most 120 characters), or two excerpts separated by " | " for a contradiction; "" only for missing. rows: field=value pairs copied exactly as they appear in the rows below, separated by "; "; "" only for a contradiction or misleading wording. A finding without such quotes is not a finding.
- The app's own rules are not given. Judge by what a careful reader of the rows would expect, and say in why what you expected.
- A part cut for length ("[… cut here for length]") or a list that stops at its limit proves nothing: never report something as missing or wrong because it is not there.
- The registers are rebuilt nightly and lend each other dates; a difference of a few days, or a value the rows themselves disagree on, is not a finding unless the page states it as certain.
- Do not repeat what the fixed checks already found, and do not report design, layout or wording preferences that do not change what a buyer understands.
- severity: high when a buyer could decide wrongly (pay more, miss a safety recall, buy a car with a hidden status); medium when a fact is wrong but unlikely to change a decision; low for a minor slip.
- why: one short Hebrew sentence: what the page says, what the rows say, and why it matters to a buyer.
- checked: the areas you could compare with the rows. findings is [] when nothing is wrong.`;

const SCHEMA = { type: "object", additionalProperties: false, required: ["checked", "findings"], properties: {
  checked: { type: "array", items: { type: "string", enum: Object.keys(AREAS) } },
  findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["area", "kind", "severity", "page", "rows", "why"], properties: {
    area: { type: "string", enum: Object.keys(AREAS) }, kind: { type: "string", enum: Object.keys(KINDS) }, severity: { type: "string", enum: SEV },
    page: { type: "string" }, rows: { type: "string" }, why: { type: "string" } } } } } };

const norm = s => String(s ?? "").replace(/[‎‏‪-‮]/g, "").replace(/[״”“]/g, '"').replace(/[׳’‘]/g, "'").replace(/\s+/g, " ").trim();
const pairs = o => Object.entries(o || {}).map(([k, v]) => `${k}=${String(v)}`);
// the page and the rows as the prompt shows them; the same text is what the quotes are checked against
export function pageText(s) {
  const h = s.page.head || {}, line = h.line ? `${h.line.title} · ${h.line.text}` : "";
  return [`[header] ${[h.title, h.sub, ...(h.pills || []), ...(h.banners || []), ...(h.msgs || []), line].filter(Boolean).join(" · ")}`,
    ...Object.entries(s.page.tabs || {}).map(([k, t]) => `[tab ${k}] ${t}`)].join("\n");
}
export function rowsText(s) {
  const r = s.rows || {}, out = [];
  for (const [k, a] of Object.entries(r.sets || {})) out.push(`${k} (${a.length} rows):`, ...a.map(o => "- " + pairs(o).join("; ")));
  if (r.merged && Object.keys(r.merged).length) out.push("merged (what the page reads, the main register first):", "- " + pairs(r.merged).join("; "));
  if ((r.wltp || []).length) out.push("model data:", ...r.wltp.map(o => "- " + pairs(o).join("; ")));
  if ((r.price || []).length) out.push("price list rows:", ...r.price.map(o => "- " + pairs(o).join("; ")));
  if (r.activeOfModelYear != null) out.push(`active cars of this model name and year: activeOfModelYear=${r.activeOfModelYear}`);
  if ((r.modelRecalls || []).length) out.push("model recall rows that name this model:", ...r.modelRecalls.map(o => "- " + pairs(o).join("; ")));
  if ((r.unanswered || []).length) out.push(`registers that did not answer the audit's own reads: ${r.unanswered.join(", ")}`);
  return out.join("\n");
}
const cut = (t, n) => (t.length > n ? t.slice(0, n) + "\n[… cut here for length]" : t);
export function prompt(s) {
  return [`Car: ${s.car.maker} ${s.car.model} ${s.car.year} (register: ${s.primary || "?"}${(s.mains || []).length > 1 ? `; also in: ${s.mains.slice(1).join(", ")}` : ""}${s.cancelled ? "; off the road" : ""})`,
    "", "== The page ==", cut(pageText(s), PAGE_MAX), "", "== The ministry's rows ==", cut(rowsText(s), ROWS_MAX), "", "== What the fixed checks found ==", ...((s.rules || []).length ? s.rules.map(l => "- " + l) : ["(none)"])].join("\n");
}
export const params = (s, effort = "medium") => ({ model: MODEL, max_tokens: 16000, output_config: { effort, format: { type: "json_schema", schema: SCHEMA } },
  system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: prompt(s) }] });

// a finding holds only when its quotes are real: "" when it holds, else why not
export function quoteCheck(f, s) {
  const page = norm(pageText(s)), rows = new Set(rowsText(s).split("\n").flatMap(l => l.replace(/^- /, "").split("; ").map(norm)));
  const parts = norm(f.page).split(" | ").map(x => x.replace(/…$/, "").trim()).filter(Boolean), cites = norm(f.rows).split(/;\s*/).map(norm).filter(Boolean);
  if (!["missing"].includes(f.kind) && !parts.length) return "no page excerpt";
  if (f.kind === "contradiction" && parts.length < 2) return "a contradiction needs two excerpts";
  if (["wrong", "missing"].includes(f.kind) && !cites.length) return "no field=value from the rows";
  const off = parts.find(p => p.length < 3 || !page.includes(p));
  if (off !== undefined) return `the page does not say "${off.slice(0, 60)}"`;
  const bad = cites.find(c => !/^[^=\s]+=/.test(c) || !rows.has(c));
  if (bad !== undefined) return `the rows do not hold "${bad.slice(0, 60)}"`;
  return "";
}

export function queries(s) {
  const q = { n: 80, rare: 20, minutes: 140, wait: 180, effort: "medium", max: 120, dry: false }, n = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(+v) || 0));
  for (const [, k, v] of String(s || "").matchAll(/(\w+)=([\w.-]+)/g)) {
    if (k === "n") q.n = n(v, 0, 150); else if (k === "rare") q.rare = n(v, 0, 50); else if (k === "minutes") q.minutes = n(v, 5, 170);
    else if (k === "wait") q.wait = n(v, 0, 180); else if (k === "max") q.max = n(v, 1, 200);
    else if (k === "effort" && ["low", "medium", "high"].includes(v)) q.effort = v; else if (k === "dry") q.dry = v === "1" || v === "true";
  }
  return q;
}

// the cars, read like a user by site-data-audit.mjs with a seed nobody sees; its own output stays in the runner's temp folder
function audit(q, dir) {
  const file = path.join(dir, "audit.txt"), deep = path.join(dir, "cars"), seed = String(crypto.randomInt(1e9));
  fs.mkdirSync(deep, { recursive: true });
  return new Promise(res => {
    const fd = fs.openSync(file, "w");
    const p = spawn(process.execPath, [path.join(HERE, "site-data-audit.mjs")], { env: { ...process.env, QUERIES: `seed=${seed};n=${q.n};rare=${q.rare};minutes=${q.minutes};makers=0`, DEEP_OUT: deep }, stdio: ["ignore", fd, fd] });
    const done = code => { fs.closeSync(fd); res({ code, dir: deep, summary: (fs.readFileSync(file, "utf8").match(/^===== SUMMARY: (\d+) cars audited/m) || [])[1] }); };
    p.on("close", done); p.on("error", () => done(-1));
  });
}

export function encrypt(obj, pem) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return { v: 1, ek: crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key).toString("base64"),
    iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function parse(msg) {
  const a = answer(msg);
  if (!a.text) return { why: a.why };
  let o; try { o = JSON.parse(a.text); } catch { return { why: "not json" }; }
  if (!o || !Array.isArray(o.findings) || !Array.isArray(o.checked)) return { why: "bad fields" };
  const good = f => f && AREAS[f.area] && KINDS[f.kind] && SEV.includes(f.severity) && ["page", "rows", "why"].every(k => typeof f[k] === "string");
  return { o: { checked: o.checked.filter(a => AREAS[a]), findings: o.findings.filter(good).map(f => ({ ...f, page: f.page.slice(0, 300), rows: f.rows.slice(0, 400), why: f.why.slice(0, 300) })) } };
}

function review(res) {
  const line = f => `- ${f.id} ${f.car} · ${AREAS[f.area]} · ${KINDS[f.kind]} · ${f.severity}${f.byRules ? " · גם הכללים" : ""}\n  > ${f.why}\n  > בדף: "${f.page}"${f.rows ? `\n  > בנתונים: ${f.rows}` : ""}`;
  const miss = res.findings.filter(f => !f.byRules), seen = res.findings.filter(f => f.byRules);
  return [`# הביקורת החודשית העמוקה ${res.d}`, "", `${res.answered} רכבים נקראו פעמיים (הכללים ו-Claude) מתוך ${res.cars}. ${res.findings.length} ממצאים אומתו מול הדף והנתונים, ${miss.length} מהם הכללים לא תפסו. ${res.unfounded.length} נפסלו כי הציטוט לא נמצא.`, "",
    ...(miss.length ? ["## מה שהכללים לא תפסו (מועמדים לכלל חדש ב-site-data-audit.mjs)", "", ...miss.map(line), ""] : []),
    ...(seen.length ? ["## מה שגם הכללים תפסו", "", ...seen.map(line), ""] : []),
    ...(res.unfounded.length ? ["## נפסלו (הציטוט לא נמצא)", "", ...res.unfounded.map(f => `- ${f.id} · ${AREAS[f.area] || f.area} · ${f.reason} · ${f.why}`), ""] : []),
    ...(res.failed.length ? ["## לא נענו", "", ...res.failed.map(f => `- ${f.id} · ${f.why}`), ""] : [])].join("\n");
}

// the router (alert.mjs): ai:audit / ai:key for the API, truth:deep-fail for too few cars, truth:deep:<areas> for findings the rules missed.
// Each key is written out at its call site, where alert.mjs's selftest finds it ({ level, key } and router.resolve(["..."]))
async function tell(router, env, { level, key, text }) {
  if (!router) return;
  try { await router.alert(level, key, text, [env.RUN_URL].filter(Boolean), { today: level === "day" ? "loud" : "silent", legacy: () => false }); } catch { /* the log line says it */ }
}
const settle = async (router, close) => { if (router) try { await close(); } catch { /* the morning ledger still shows it */ } };
// a scheduled run on the 1st or the 2nd that could not finish is tried again the next day (data-truth.yml skips once the month is done)
const again = now => (now.getUTCDate() < 3 ? "הביקורת תנסה שוב מחר" : "הביקורת תרוץ שוב בחודש הבא");

export async function run({ env = process.env, api, router, readCars, log = console.log, now = new Date(), pem } = {}) {
  const q = queries(env.QUERIES), out = env.OUT || "out", d = now.toISOString().slice(0, 7);
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  const { tag, todo, folded } = await import("./tg-text.mjs");
  const rep = { cars: 0, dropped: 0, sent: 0, answered: 0, kept: 0, missed: 0, why: "" };
  const done = () => { log(`deep audit ${d}: ${rep.cars} cars read${rep.dropped ? `, ${rep.dropped} dropped` : ""}, ${rep.sent} sent, ${rep.answered} answered, ${rep.kept} findings kept, ${rep.missed} the rules missed${rep.why ? " · " + rep.why : ""}`); return rep; };
  const c = api ? { api } : q.dry ? { api: null, why: "dry run" } : await client(env);
  if (!c.api && !q.dry) {   // no key: switched off on purpose, quietly; no SDK: the router hears it
    rep.why = c.why;
    if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, env, { level: "summary", key: "ai:audit", text: [tag("info", "data"), `הביקורת החודשית העמוקה לא רצה הפעם: ${c.why}. הבדיקה היומית ממשיכה כרגיל, ו${again(now)}.`, todo()].join("\n") });
    return done();
  }
  // the cars: site-data-audit.mjs with DEEP_OUT (readCars replaces it in the self-test)
  const tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), "deep-"));
  const got = readCars ? await readCars(q, tmp) : await audit(q, tmp);
  const cars = fs.existsSync(got.dir) ? fs.readdirSync(got.dir).filter(f => /^c\d+\.json$/.test(f)).sort().slice(0, q.max).map(f => JSON.parse(fs.readFileSync(path.join(got.dir, f), "utf8"))) : [];
  rep.cars = cars.length;
  // a prompt that still holds a plate-like run is never sent: that car is dropped, and the log says where (section and field name only)
  const reqs = [], dropped = [];
  for (const s of cars) { const p = params(s, q.effort), w = leakWhere(p.messages[0].content); if (w) dropped.push({ id: s.id, where: w }); else reqs.push({ custom_id: s.id, params: p }); }
  rep.dropped = dropped.length;
  if (dropped.length) log(`plate-like text left in ${dropped.length} car(s), not sent: ${dropped.map(x => `${x.id} (${x.where})`).join(", ")}`);
  if (reqs.length < MIN_CARS) {
    const scrub = cars.length >= MIN_CARS;   // enough cars were read, too many were dropped
    rep.why = scrub ? `${dropped.length} of ${cars.length} cars held plate-like text` : `only ${cars.length} cars read (audit exit ${got.code})`;
    await tell(router, env, { level: "summary", key: "truth:deep-fail", text: [tag("info", "data"), scrub
      ? `הביקורת החודשית העמוקה לא נשלחה ל-Claude: ב-${dropped.length} מתוך ${cars.length} הרכבים נשאר טקסט שנראה כמו מספר רישוי, ולכן הם לא נשלחו, ומה שנשאר מעט מדי. הניקוי מתוקן בשרשור "נתונים ואמינות". הבדיקה היומית ממשיכה כרגיל, ו${again(now)}.`
      : `הביקורת החודשית העמוקה קראה רק ${cars.length} רכבים, מעט מכדי לשלוח ל-Claude. בדרך כלל זה אומר שמאגרי משרד התחבורה לא ענו. הבדיקה היומית ממשיכה כרגיל, ו${again(now)}.`, todo()].join("\n") });
    fs.rmSync(tmp, { recursive: true, force: true }); return done();
  }
  await settle(router, () => router.resolve(["truth:deep-fail"]));
  if (q.dry) { log(`dry run: ${reqs.length} cars, nothing sent`); fs.rmSync(tmp, { recursive: true, force: true }); return done(); }
  const r = await batch(c.api, reqs, { minutes: q.wait, every: 60, cancel: true });   // a batch still running at the deadline is cancelled: what finished is kept
  fs.rmSync(tmp, { recursive: true, force: true });
  if (r.error && !r.id) {
    rep.why = r.error.why;
    if (r.error.key) await tell(router, env, { level: "day", key: "ai:key", text: [tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן הביקורת החודשית העמוקה לא רצה. הבדיקה היומית ממשיכה כרגיל.",
      todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + folded(r.error.why) });
    else await tell(router, env, { level: "summary", key: "ai:audit", text: [tag("info", "data"), `הביקורת החודשית העמוקה לא נשלחה ל-Claude: הפנייה נכשלה. הבדיקה היומית ממשיכה כרגיל, ו${again(now)}.`, todo()].join("\n") + folded(r.error.why) });
    return done();
  }
  rep.sent = reqs.length;
  const res = { v: 1, d, prompt: PROMPT_V, cars: cars.length, dropped, answered: 0, findings: [], unfounded: [], failed: [], tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };   // tokens: in the encrypted file only
  const results = r.results || new Map();
  for (const s of cars) {
    const x = results.get(s.id), car = `${s.car.maker} ${s.car.model} ${s.car.year}`.trim();
    if (!x || !x.ok) { res.failed.push({ id: s.id, why: (x && x.why) || (r.ended ? "no result" : "the batch had not ended") }); continue; }
    for (const [k, v] of Object.entries(usage(x.msg))) res.tokens[k] += v;
    const p = parse(x.msg);
    if (p.why) { res.failed.push({ id: s.id, why: p.why }); continue; }
    res.answered++;
    const ruleAreas = new Set((s.rules || []).map(l => (l.match(/^([a-z]+)\./) || [])[1]).filter(Boolean)), seen = new Set();
    for (const f of p.o.findings) {
      const k = [f.area, norm(f.page), norm(f.rows)].join("|");
      if (seen.has(k)) continue;
      seen.add(k);
      const why = quoteCheck(f, s);
      if (why) res.unfounded.push({ id: s.id, area: f.area, kind: f.kind, reason: why, why: f.why });
      else res.findings.push({ id: s.id, from: s.from, car, ...f, byRules: ruleAreas.has(f.area) });
    }
  }
  rep.answered = res.answered; rep.kept = res.findings.length;
  const miss = res.findings.filter(f => !f.byRules && f.severity !== "low"), areas = [...new Set(miss.map(f => f.area))].sort();
  rep.missed = miss.length;
  const count = a => Object.fromEntries(Object.keys(AREAS).map(k => [k, a.filter(f => f.area === k).length]).filter(([, n]) => n));
  const summary = { v: 1, d, prompt: PROMPT_V, cars: res.cars, dropped: dropped.length, answered: res.answered, kept: res.findings.length, high: res.findings.filter(f => f.severity === "high").length,
    medium: res.findings.filter(f => f.severity === "medium").length, low: res.findings.filter(f => f.severity === "low").length, missedByRules: miss.length, unfounded: res.unfounded.length,
    failed: res.failed.length, byArea: count(res.findings), missedByArea: count(miss) };
  res.review = review(res);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "deep-audit.enc.json"), JSON.stringify(encrypt(res, pem || fs.readFileSync(path.join(HERE, "..", "seo-data.pub.pem"), "utf8"))));
  fs.writeFileSync(path.join(out, "deep-summary.json"), JSON.stringify(summary, null, 1) + "\n");
  if (!res.answered) {   // the batch ran and nothing came back usable: the API's side
    rep.why = res.failed[0] ? res.failed[0].why : "no answer";
    await tell(router, env, { level: "summary", key: "ai:audit", text: [tag("info", "data"), `הביקורת החודשית העמוקה נשלחה ל-Claude, אבל לא חזרה ממנה אף תשובה שאפשר לקרוא. הבדיקה היומית ממשיכה כרגיל, ו${again(now)}.`, todo()].join("\n") + folded(rep.why) });
    return done();
  }
  await settle(router, async () => { await router.resolve(["ai:audit"]); await router.resolve(["ai:key"]); });
  if (miss.length) await tell(router, env, { level: "summary", key: `truth:deep:${areas.join("+")}`, text: [tag("info", "data"),
    `הביקורת החודשית העמוקה קראה ${res.answered} רכבים פעמיים, בכללים וב-Claude, ומצאה ${miss.length === 1 ? "ממצא אחד" : `${miss.length} ממצאים`} שהבדיקה היומית לא תפסה: ${areas.map(a => AREAS[a]).join(", ")}. כל ממצא אומת מול הדף ומול נתוני משרד התחבורה.`,
    "הפירוט, מוצפן ובלי מספרי רכב, בענף data-truth, ועובר לשרשור \"נתונים ואמינות\" כדי להפוך כל ממצא אמיתי לבדיקה יומית.", todo()].join("\n") });
  else await settle(router, () => router.resolve(["truth:deep:"]));   // a month with nothing the rules missed closes the earlier months' lines (told: "טופל")
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("deep-audit.mjs") && !process.argv.includes("--selftest")) {
  try { await run(); } catch (e) { console.log("deep audit skipped: crash: " + String((e && e.message) || e).slice(0, 160)); }   // never red over this bot
}

if (process.argv[1] && process.argv[1].endsWith("deep-audit.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  // the scrub: the car's own numbers in every form, then anything plate-like
  const clean = deepClean(["1234567", "ABCDEFGH123456789", "", null, "XYZ98765"]);
  const dirty = "רכב 12-345-67 · 1234567 · שלדה ABCDEFGH123456789 · מנוע XYZ98765 · אחר 76-543-21 · 7654321 · 12xxx67 · ק״מ 1,234,567 · 2024-05-01 · 123456";
  const c1 = clean(dirty);
  ok(!/1234567|12-345-67|ABCDEFGH123456789|XYZ98765|76-543-21|7654321|12xxx67/.test(c1) && c1.includes("1,234,567") && c1.includes("2024-05-01") && c1.includes("123456"),
    "the scrub: own plate (both forms), VIN and engine number, other plates and masked plates go; grouped numbers, dates and short numbers stay");
  ok(deepClean(["12345678"])("123-45-678 ו-12345678") === "<id> ו-<id>" && plateFree(c1) && !plateFree("x 1234567 y") && !plateFree("ABCDEFGH123456789"), "an 8-digit plate in its dashed form; the last look catches a plate or a VIN");
  // a made-up car, as site-data-audit.mjs writes it
  const car = (id, over = {}) => ({ id, from: "active", primary: "active", mains: ["active", "owners"], cancelled: false, car: { maker: "טויוטה יפן", model: "COROLLA", year: "2019" },
    page: { head: { title: "טויוטה COROLLA 2019", sub: "<id>", pills: ["טסט בתוקף", "יד 2"], banners: [], msgs: [], line: null, tabs: ["overview", "owners"] },
      tabs: { overview: "רישוי וטסט טסט אחרון 05/03/2025 תוקף רישיון 04/03/2026 בעלות נוכחית פרטי", owners: "בעלות ראשונה ליסינג 03/2019 בעלות שנייה פרטי 07/2022 יד 2 (שתי בעלויות)" } },
    rows: { sets: { active: [{ tozeret_nm: "טויוטה יפן", mivchan_acharon_dt: "2025-03-05", tokef_dt: "2026-03-04", baalut: "פרטי" }], owners: [{ baalut: "ליסינג", baalut_dt: "201903" }, { baalut: "פרטי", baalut_dt: "202207" }, { baalut: "פרטי", baalut_dt: "202401" }] },
      merged: { tozeret_nm: "טויוטה יפן", tokef_dt: "2026-03-04" }, wltp: [], price: [], activeOfModelYear: 812, modelRecalls: [], unanswered: [] }, rules: [], ...over });
  const s = car("c001");
  const F = (o) => ({ area: "owners", kind: "wrong", severity: "high", page: "יד 2 (שתי בעלויות)", rows: "baalut=פרטי; baalut_dt=202401", why: "x", ...o });
  ok(quoteCheck(F(), s) === "", "a finding whose page excerpt and field=value pairs are real holds");
  ok(/does not say/.test(quoteCheck(F({ page: "יד 3 (שלוש בעלויות)" }), s)) && /do not hold/.test(quoteCheck(F({ rows: "baalut=חברה" }), s)) && /do not hold/.test(quoteCheck(F({ rows: "the third owner" }), s)),
    "an excerpt the page does not have, a pair the rows do not hold, or prose instead of pairs: unfounded");
  ok(quoteCheck(F({ kind: "missing", page: "", rows: "baalut_dt=202401" }), s) === "" && /no field/.test(quoteCheck(F({ kind: "missing", page: "", rows: "" }), s))
    && quoteCheck(F({ kind: "contradiction", page: "יד 2 | בעלות נוכחית פרטי", rows: "" }), s) === "" && /two excerpts/.test(quoteCheck(F({ kind: "contradiction", page: "יד 2", rows: "" }), s)),
    "missing needs pairs and no excerpt; a contradiction needs two excerpts and no pairs");
  ok(quoteCheck(F({ page: "יד  2‏ (שתי בעלויות)…" }), s) === "", "spacing, direction marks and a trailing ellipsis do not matter");
  const p0 = prompt(s);
  ok(p0.includes("== The page ==") && p0.includes("[tab owners]") && p0.includes("- baalut=פרטי; baalut_dt=202401") && p0.includes("activeOfModelYear=812") && plateFree(p0), "the prompt: the page, the rows as field=value pairs, plate-free");
  ok(params(s).model === MODEL && params(s).output_config.effort === "medium" && params(s).system[0].cache_control && !("thinking" in params(s)) && !("temperature" in params(s)), "the request: structured output, a cached system prompt, no thinking or sampling field");
  // the encryption: only the private key reads it
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
  const e = encrypt({ a: "טויוטה" }, publicKey), k = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
  const dc = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64")); dc.setAuthTag(Buffer.from(e.tag, "base64"));
  ok(JSON.parse(Buffer.concat([dc.update(Buffer.from(e.data, "base64")), dc.final()]).toString("utf8")).a === "טויוטה" && !e.data.includes("טויוטה"), "encrypted with the public key (the shape seo-key/decrypt.mjs reads)");
  ok(JSON.stringify(queries("n=500 minutes=3 effort=max dry=1 bogus=2")) === JSON.stringify({ n: 150, rare: 20, minutes: 5, wait: 180, effort: "medium", max: 120, dry: true }), "queries: clamped, unknown dropped");
  // whole runs: a fake audit writes the cars, a fake API answers by car
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "da-")), cars = n => async (q, dir) => { const d = path.join(dir, "cars"); fs.mkdirSync(d, { recursive: true });
    for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(d, `c${String(i).padStart(3, "0")}.json`), JSON.stringify(car(`c${String(i).padStart(3, "0")}`, i === 2 ? { rules: ["owners.count | shown=\"יד 2\" | expected=\"יד 3\""] } : {})));
    return { code: 0, dir: d }; };
  const sent = [];
  const reply = (id, u) => {
    sent.push(u);
    const msg = o => ({ ok: true, msg: { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(o) }], usage: { input_tokens: 9000, output_tokens: 700 } } });
    if (id === "c001" || id === "c002") return msg({ checked: ["owners", "test"], findings: [F({}), F({ area: "test", page: "טסט אחרון 06/03/2025", rows: "mivchan_acharon_dt=2025-03-05" })] });
    if (id === "c003") return { ok: false, why: "errored invalid_request_error" };
    if (id === "c004") return msg({ checked: ["owners"], findings: [F({ severity: "low", kind: "misleading", rows: "" })] });
    return msg({ checked: ["owners", "test"], findings: [] });
  };
  const fake = ({ fail = 0 } = {}) => ({ messages: { batches: {
    create: async ({ requests }) => { if (fail) { const er = new Error("boom"); er.status = fail; throw er; } fake.reqs = requests; return { id: "msgbatch_1" }; },
    retrieve: async id => ({ id, processing_status: "ended" }),
    results: async () => (async function* () { for (const r of fake.reqs) { const x = reply(r.custom_id, r.params.messages[0].content); yield { custom_id: r.custom_id, result: x.ok ? { type: "succeeded", message: x.msg } : { type: "errored", error: { type: "error", error: { type: "invalid_request_error" } } } }; } })(),
    cancel: async () => {} } } });
  const calls = [], router = { alert: async (lv, key, text) => { calls.push(["alert", lv, key, text]); return { delivered: true }; }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
  const quiet = () => {}, dec = f => { const x = JSON.parse(fs.readFileSync(f, "utf8")), kk = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(x.ek, "base64"));
    const dd = crypto.createDecipheriv("aes-256-gcm", kk, Buffer.from(x.iv, "base64")); dd.setAuthTag(Buffer.from(x.tag, "base64")); return JSON.parse(Buffer.concat([dd.update(Buffer.from(x.data, "base64")), dd.final()]).toString("utf8")); };
  let r = await run({ env: { OUT: path.join(tmp, "o1"), QUERIES: "wait=0" }, api: fake(), router, readCars: cars(12), log: quiet, pem: publicKey, now: new Date("2026-11-01T05:00:00Z") });
  const res = dec(path.join(tmp, "o1", "deep-audit.enc.json")), sum = JSON.parse(fs.readFileSync(path.join(tmp, "o1", "deep-summary.json"), "utf8"));
  ok(r.sent === 12 && r.answered === 11 && res.failed.length === 1 && res.failed[0].id === "c003", "12 cars sent, 11 answered, the errored one listed");
  ok(res.findings.filter(f => f.id === "c001").length === 1 && res.unfounded.some(f => f.id === "c001" && f.area === "test"), "a finding with a real quote is kept; one whose page excerpt is wrong is unfounded");
  ok(res.findings.find(f => f.id === "c002").byRules && !res.findings.find(f => f.id === "c001").byRules, "a finding in an area the rules flagged on that car is marked as theirs");
  ok(sum.kept === 3 && sum.missedByRules === 1 && sum.low === 1 && sum.missedByArea.owners === 1 && !JSON.stringify(sum).includes("COROLLA") && !JSON.stringify(sum).includes("יד 2"), "the clear summary: counts only, no car and no quote");
  ok(calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "truth:deep:owners") && calls.some(c => c[0] === "resolve" && c[1] === "ai:audit") && calls.some(c => c[0] === "resolve" && c[1] === "ai:key")
    && !calls.some(c => c[0] === "resolve" && c[1] === "truth:deep:"), "a finding the rules missed: one quiet truth:deep line by area; the API's keys close");
  ok(res.tokens.input > 0 && res.tokens.output > 0 && !JSON.stringify(sum).includes("tokens") && !fs.readFileSync(path.join(tmp, "o1", "deep-summary.json"), "utf8").includes("input"), "the tokens are counted, in the encrypted file only");
  ok(res.review.includes("מה שהכללים לא תפסו") && res.review.includes("נפסלו") && sent.every(u => plateFree(u)), "the review lists what the rules missed and what was dropped; every prompt plate-free");
  calls.length = 0;
  r = await run({ env: { OUT: path.join(tmp, "o2"), QUERIES: "wait=0" }, api: fake(), router, readCars: cars(4), log: quiet, pem: publicKey, now: new Date("2026-12-01T05:20:00Z") });
  ok(r.sent === 0 && calls.some(c => c[2] === "truth:deep-fail" && c[3].includes("תנסה שוב מחר")) && !fs.existsSync(path.join(tmp, "o2", "deep-summary.json")), "too few cars on the 1st: nothing sent, truth:deep-fail, tried again tomorrow");
  calls.length = 0;
  r = await run({ env: { OUT: path.join(tmp, "o3"), QUERIES: "wait=0" }, api: fake({ fail: 529 }), router, readCars: cars(12), log: quiet, pem: publicKey, now: new Date("2026-12-03T05:20:00Z") });
  ok(r.why === "529 server" && calls.some(c => c[1] === "summary" && c[2] === "ai:audit" && c[3].includes("בחודש הבא")) && !calls.some(c => c[0] === "resolve" && c[1] === "ai:audit"), "an API error: ai:audit (summary), nothing closed");
  calls.length = 0;
  r = await run({ env: { OUT: path.join(tmp, "o4"), QUERIES: "wait=0" }, api: fake({ fail: 401 }), router, readCars: cars(12), log: quiet, pem: publicKey });
  ok(r.why === "401 key" && calls.some(c => c[1] === "day" && c[2] === "ai:key"), "a refused key: ai:key (day), for Dudu");
  calls.length = 0;
  r = await run({ env: { OUT: path.join(tmp, "o5") }, router, readCars: cars(12), log: quiet, pem: publicKey });
  ok(r.why === "no ANTHROPIC_API_KEY" && !calls.length && r.cars === 0, "no key: the cars are not even read, quietly");
  const leaky = async (q, dir) => { const g = await cars(12)(q, dir); const f = path.join(g.dir, "c005.json"), x = JSON.parse(fs.readFileSync(f, "utf8")); x.page.tabs.overview += " 7654321"; fs.writeFileSync(f, JSON.stringify(x)); return g; };
  const logs = [];
  r = await run({ env: { OUT: path.join(tmp, "o6"), QUERIES: "wait=0" }, api: fake(), router, readCars: leaky, log: m => logs.push(m), pem: publicKey });
  ok(r.sent === 11 && r.dropped === 1 && !fake.reqs.some(x => x.custom_id === "c005") && logs.some(m => m.includes("c005 ([tab overview])")) && !logs.join(" ").includes("7654321"),
    "a plate that got past the scrub: that car is not sent, the log says where and not what, the others go");
  calls.length = 0; fake.reqs = null;
  const leakier = async (q, dir) => { const g = await cars(12)(q, dir); for (const n of ["c003", "c005", "c007"]) { const f = path.join(g.dir, n + ".json"), x = JSON.parse(fs.readFileSync(f, "utf8")); x.rows.modelRecalls = [{ TEUR_TAKALA: "ABCDEFGH123456789" }]; fs.writeFileSync(f, JSON.stringify(x)); } return g; };
  r = await run({ env: { OUT: path.join(tmp, "o9"), QUERIES: "wait=0" }, api: fake(), router, readCars: leakier, log: quiet, pem: publicKey });
  ok(r.sent === 0 && fake.reqs === null && calls.some(c => c[2] === "truth:deep-fail" && c[3].includes("נראה כמו מספר רישוי")) && /3 of 12/.test(r.why), "too many cars dropped: nothing is sent, truth:deep-fail says why");
  ok(leakWhere("== The ministry's rows ==\nmodel recall rows that name this model:\n- RECALL_ID=15777; TEUR_TAKALA=x 12345678 y") === "model recall rows that name this model TEUR_TAKALA"
    && leakWhere("[tab specs] a\nb 1234567") === "[tab specs]" && leakWhere(p0) === "", "where a plate-like run sits: the section and the field, never the text");
  r = await run({ env: { OUT: path.join(tmp, "o7"), QUERIES: "dry=1" }, router, readCars: cars(12), log: quiet, pem: publicKey });
  ok(r.cars === 12 && r.sent === 0, "dry: the cars are read, nothing sent");
  // a month where Claude found nothing the rules missed closes the earlier months' lines
  calls.length = 0;
  const cleanCars = async (q, dir) => { const g = await cars(12)(q, dir); for (const f of ["c001.json", "c004.json"]) fs.rmSync(path.join(g.dir, f)); return g; };
  r = await run({ env: { OUT: path.join(tmp, "o8"), QUERIES: "wait=0" }, api: fake(), router, readCars: cleanCars, log: quiet, pem: publicKey });
  ok(r.missed === 0 && calls.some(c => c[0] === "resolve" && c[1] === "truth:deep:") && !calls.some(c => c[0] === "alert"), "a clean month: the open truth:deep lines close, nothing is sent");
  // a car's prompt has a ceiling; the router has Hebrew for every area
  const big = car("c099", { page: { ...car("c099").page, tabs: { overview: "א ".repeat(60000), owners: "ב" } } });
  ok(prompt(big).length < PAGE_MAX + ROWS_MAX + 3000 && prompt(big).includes("[… cut here for length]"), "one car's prompt is cut at its ceiling");
  try { const { label } = await import("./alert.mjs"); ok(Object.keys(AREAS).every(a => label("truth:deep:" + a).he.endsWith(": " + AREAS[a])) && label("ai:audit").he.endsWith("הביקורת החודשית העמוקה"), "the router names every area as this file does"); }
  catch (e) { ok(false, "alert.mjs import: " + e.message); }
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
