// Weekly settlements news read by Claude (data thread; Dudu 1.11.2026 "תשחרר את כל ה5", monthly API credit, workspace luchit-bots).
// After the weekly watch (settlements.mjs watch) has put the new stories into the inbox, one Claude conversation (Sonnet 5.5 with the server
// web_search and web_fetch tools, capped, on a fixed list of Israeli court, press and importer sites) reads each open story and says what it
// is: a new settlement, a change to one already listed (approved by the court, a new deadline), one that ended, or nothing for the list
// (a filing, a certified class action, not about car owners, not in Israel, already listed, the same story twice). It writes ai.json next
// to the inbox on the branch settlements-watch and adds its reading to inbox.md. It never edits settlements.json: the weekly review (the
// data thread's scheduled task) still verifies every candidate at the source and edits the list; with review "light" (nothing for the list
// and nothing in the coverage that needs judgement) the review only moves `checked` and removes ended entries.
// Machine check: every verdict but a few that follow from the title alone (not_car, not_owners, duplicate) needs a source page the search
// or the fetch returned in this same call; without one, or with an unknown kind or id, the story becomes "unclear" and goes to the full review.
// A proposed new entry is also run through settlements.mjs validate (the app's own stlCompile); a failing one is kept but marked.
// When Sonnet's answer is not valid JSON, the same request goes once to Opus 5.5 (model policy section 6) before the fallback.
// Fallback (claude.mjs): no key, no SDK, an API error or no valid answer leaves ok:false and review "full", so the review works as before
// and the run stays green. A failed call raises ai:stl (summary), the key or the credit ai:key (day, Dudu acts); a good call closes both.
// The log is public: no cost, no token count, no business number. The stories are public news; nothing here is personal.
//   node settlements-ai.mjs              env: OUT (dir with state.json and inbox.md, default "out"), PREV_AI (last ai.json, optional), DRY=1
//   node settlements-ai.mjs --selftest   offline, through a fake API
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, ask, answer, reason, keyTrouble } from "./claude.mjs";

export const MODELS = ["claude-sonnet-5-5", "claude-opus-5-5"];   // the second only when the first gives no valid answer
export const SEARCH_PER_STORY = 3, SEARCH_CAP = 18, FETCH_CAP = 12, STORY_CAP = 12;
export const KINDS = ["new", "change", "ended", "skip", "unclear"];
export const SKIPS = ["filing", "certified", "not_car", "not_owners", "not_israel", "listed", "duplicate", "other"];
// Google News brings back old stories; everything published before the October 2026 research of importer pages and court notices was covered
// by it (the watch's first run took only the last 30 days for the same reason), so such a story is a skip "old" by its feed date, never sent
export const RESEARCHED = "2026-10-01";
const TITLE_ONLY = new Set(["not_car", "not_owners", "duplicate"]);   // a skip that the story's own title can show, so no source page is needed
// Israeli courts and notices, press and importers (subdomains included); the review itself may read any site
export const DOMAINS = [
  "yitzugit.co.il", "gov.il", "court.gov.il", "psakdin.co.il", "nevo.co.il",
  "globes.co.il", "calcalist.co.il", "themarker.com", "ynet.co.il", "maariv.co.il", "walla.co.il", "mako.co.il", "ice.co.il", "bizportal.co.il",
  "haaretz.co.il", "israelhayom.co.il", "c14.co.il", "passportnews.co.il", "kikar.co.il", "thecar.co.il", "icar.co.il", "carzone.co.il",
  "colmobil.co.il", "delek-motors.co.il", "kia-israel.co.il", "toyota.co.il", "lexus.co.il", "subaru.co.il", "suzuki.co.il", "honda.co.il",
  "mazda.co.il", "hyundai.co.il", "championmotors.co.il", "samelet.com", "lubinski.co.il", "carasso.co.il", "unionmotors.co.il",
  "volvocars.com", "landrover.co.il", "chevrolet.co.il", "ford.co.il", "mitsubishi.co.il", "nissan.co.il", "renault.co.il", "geely.co.il", "tesla.com",
];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const clean = (s, n) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = u => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + decodeURI(x.pathname).replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } };

// the list as the model needs it to match a story to an entry: no conditions or benefits, only who, what and the status
export const brief = items => items.map(e => `${e.id} | ${e.mk} | ${e.md || (e.m || []).map(a => a.md).filter(Boolean).join("|")} | ${(e.y || []).join("-")} | ${e.t} | ${e.st}${e.until ? " until " + e.until : ""}`).join("\n");
export function prompt(stories, items, today) {
  return [
    `Today is ${today}. You help keep a list of Israeli class-action settlements that give car owners something (a free repair, a refund, a longer warranty).`,
    "For each news story below, find out at the source what it is: open the court notice (yitzugit.co.il posts the published notices), the importer's settlement page, or two independent press reports. Search in Hebrew.",
    "Kinds:",
    "- new: a court-approved settlement, a settlement filed and waiting for the court (status wait), a withdrawal settlement (הסדר הסתלקות) or a judgment that gives car owners a benefit, and it is not in the list. Give the entry.",
    "- change: it is about an entry in the list and something changed: the court approved it (wait -> ok), a new deadline, different models or years, a different benefit. Give the id and the changed fields only.",
    "- ended: an entry in the list ended (its last claim date passed or it was cancelled). Give the id.",
    "- skip: nothing for the list. Give why, one of: " + SKIPS.join(", ") + " (filing = a request filed, no settlement yet; certified = the court certified a class action, no settlement yet; listed = in the list and nothing changed, give its id).",
    "- unclear: you could not tell at a source. Say what is missing.",
    "Never guess. A fact you did not see on a page you searched or fetched in this conversation is not known. Importers and dealers are never at fault in your words: describe neutrally.",
    "Entry fields for new (Hebrew where text): mk = maker pattern as the Israeli register writes it, Hebrew (e.g. \"פיאט|FIAT\"); md = model pattern in capital Latin letters and digits only, no spaces or dashes (e.g. \"CX5(?!0)\"); y = [from, to] model years; t = short title; b = the benefit; cond = conditions and the last date to claim; st = ok or wait; until = YYYY-MM-DD the last date to claim (or about two years after approval if none is stated); url = https link to the importer's page or the court notice.",
    "The list now (id | maker | models | years | title | status):", brief(items),
    "The stories (n | first seen | published | source | title | link):",
    ...stories.map((s, i) => `${i + 1} | ${s.d} | ${s.p || "?"} | ${s.s} | ${s.t} | ${s.u}`),
    "Answer with JSON only, no other text:",
    '{"stories":[{"n":1,"kind":"' + KINDS.join("|") + '","why":"' + SKIPS.join("|") + ' (skip only)","id":"entry id (change, ended, skip listed)","case":"court case number if known","what":"one Hebrew sentence on what it is","fields":{"st":"ok"},"entry":{"mk":"","md":"","y":[2020,2022],"t":"","b":"","cond":"","st":"ok","until":"YYYY-MM-DD","url":"https://"},"sources":["https://pages you saw that show it"]}]}',
  ].join("\n");
}

// every page the server search or fetch returned in this conversation, and every citation of the text
export function seenUrls(contents) {
  const seen = new Set(), add = u => { const n = norm(u); if (n) seen.add(n); };
  for (const content of contents) for (const b of content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(r => add(r.url));
    if (b.type === "web_fetch_tool_result" && b.content && b.content.type === "web_fetch_result") add(b.content.url);
    if (b.type === "text") (b.citations || []).forEach(c => add(c.url));
  }
  return seen;
}
const used = (contents, name) => contents.flat().filter(b => b && b.type === "server_tool_use" && b.name === name).length;
export function parse(text) {
  const t = String(text || ""), i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { const o = JSON.parse(t.slice(i, j + 1)); return o && Array.isArray(o.stories) ? o : null; } catch { return null; }
}

// the machine check of one answer: a verdict stands only on a found source, a known kind and a known id
export function check(o, stories, items, seen, validate) {
  const ids = new Set(items.map(e => e.id)), byN = new Map();
  for (const a of o.stories) if (Number.isInteger(a && a.n) && a.n >= 1 && a.n <= stories.length && !byN.has(a.n)) byN.set(a.n, a);
  return stories.map((s, i) => {
    const a = byN.get(i + 1) || {}, v = { k: s.k, d: s.d, t: s.t, u: s.u, read: true, kind: KINDS.includes(a.kind) ? a.kind : "unclear", why: "", id: "", case: clean(a.case, 40), what: clean(a.what, 300), sources: [], dropped: 0, note: "" };
    const src = (Array.isArray(a.sources) ? a.sources : []).map(String).filter(u => /^https:\/\//.test(u)).slice(0, 6);
    v.sources = src.filter(u => seen.has(norm(u))); v.dropped = src.length - v.sources.length;
    const unclear = note => { v.kind = "unclear"; v.why = ""; v.note = note; };
    if (!byN.has(i + 1)) unclear("no answer for this story");
    else if (v.kind === "skip") {
      v.why = SKIPS.includes(a.why) ? a.why : "other";
      if (v.why === "listed") { v.id = ids.has(a.id) ? a.id : ""; if (!v.id) unclear("listed without a known id"); }
      if (v.kind === "skip" && !TITLE_ONLY.has(v.why) && !v.sources.length) unclear("no source page found");
    } else if (v.kind === "change" || v.kind === "ended") {
      v.id = ids.has(a.id) ? a.id : "";
      if (!v.id) unclear(`${a.kind} without a known id`);
      else if (!v.sources.length) unclear("no source page found");
      else if (v.kind === "change") v.fields = Object.fromEntries(Object.entries(a.fields && typeof a.fields === "object" ? a.fields : {}).filter(([f]) => ["st", "until", "y", "md", "b", "cond", "url", "t"].includes(f)).slice(0, 8).map(([f, x]) => [f, typeof x === "string" ? clean(x, 400) : x]));
    } else if (v.kind === "new") {
      if (!v.sources.length) unclear("no source page found");
      else {
        const e = a.entry && typeof a.entry === "object" ? a.entry : {};
        v.entry = { id: "x-new", ...Object.fromEntries(["mk", "md", "y", "t", "b", "cond", "st", "until", "url"].filter(f => e[f] !== undefined).map(f => [f, typeof e[f] === "string" ? clean(e[f], 400) : e[f]])) };
        const bad = validate ? validate(v.entry) : [];
        if (bad.length) v.note = "entry needs work: " + bad.join("; ").slice(0, 300);
      }
    } else if (v.kind === "unclear") v.note = v.what ? "" : "could not tell at a source";
    return v;
  });
}

// the router (alert.mjs): a failed call is ai:stl (summary), the key or the credit is ai:key (day, Dudu acts); a good call closes both
async function tell(router, err, env) {
  if (!router) return;
  let t = { tag: () => "", todo: () => "", folded: () => "" };
  try { t = await import("./tg-text.mjs"); } catch {}
  const text = err.key
    ? [t.tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן Claude לא קרא השבוע את חדשות הסדרי הפשרה. הבדיקה השבועית בשרשור הנתונים תקרא אותן בעצמה.",
        t.todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + t.folded(err.why)
    : [t.tag("info", "bots"), "Claude לא הצליח הפעם לקרוא את חדשות הסדרי הפשרה. הבדיקה השבועית בשרשור הנתונים תקרא אותן בעצמה.", t.todo()].join("\n") + t.folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:stl", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch { /* the log line says it */ }
}
async function settle(router) {
  if (!router) return;
  try { await router.resolve(["ai:stl"]); await router.resolve(["ai:key"]); } catch { /* the morning ledger still shows it */ }
}

// the coverage issues that need judgement (a rule to tighten, a model to name); an ended entry is removed by rule, a source down needs nothing
export const judged = issues => Object.keys(issues || {}).filter(i => !/^(retire |source down:)/.test(i));
const KIND_HE = { new: "הסדר חדש לרשימה", change: "שינוי בהסדר שברשימה", ended: "הסדר שהסתיים", skip: "לא לרשימה", unclear: "לא ברור, לבדיקה" };
const WHY_HE = { filing: "בקשה שהוגשה, עוד אין הסדר", certified: "אושרה ניהול כייצוגית, עוד אין הסדר", not_car: "לא על רכב", not_owners: "לא הטבה לבעלי רכב",
  not_israel: "לא בישראל", listed: "כבר ברשימה, בלי שינוי", duplicate: "אותה ידיעה פעמיים", other: "אחר", old: "ידיעה ישנה, לפני המחקר של 10.2026" };
export function inboxLines(rep) {
  const head = ["## קריאת Claude (" + (rep.ok ? `${rep.model}, ${rep.verdicts.length} ידיעות` : "לא רץ: " + rep.why) + ")", `בדיקה: ${rep.review === "light" ? "קלה (אין מה לאמת: רק checked והסרת הסדרים שהסתיימו)" : "מלאה"}`];
  return [...head, ...rep.verdicts.map(v => `- ${v.d} · ${v.t} → ${KIND_HE[v.kind]}${v.why ? ": " + WHY_HE[v.why] : ""}${v.id ? " · " + v.id : ""}${v.case ? " · ת\"צ " + v.case : ""}${v.what ? " · " + v.what : ""}${v.fields ? " · " + JSON.stringify(v.fields) : ""}${v.entry ? " · " + JSON.stringify(v.entry) : ""}${v.note ? " · " + v.note : ""}${v.sources.length ? " · " + v.sources.join(" ") : ""}`), ""];
}

export async function run({ env = process.env, api, router, log = console.log, today = new Date().toISOString().slice(0, 10), validate } = {}) {
  const out = env.OUT || "out";
  const state = JSON.parse(fs.readFileSync(path.join(out, "state.json"), "utf8"));
  const list = JSON.parse(fs.readFileSync(env.LIST || path.join(ROOT, "settlements.json"), "utf8"));
  let prev = null; try { prev = JSON.parse(fs.readFileSync(env.PREV_AI || "", "utf8")); } catch {}
  const open = (state.inbox || []).filter(it => it.d > (state.checked || ""));
  // a story read last week that is still open keeps its reading (no second paid call); only stories new to the inbox are sent
  // (a story that was not read, because of an error, the cap or a dry run, is sent again)
  const before = new Map(((prev && prev.verdicts) || []).filter(v => v.read).map(v => [v.k, v]));
  const old = s => s.p && s.p < RESEARCHED, aged = open.filter(s => !before.has(s.k) && old(s)).map(s => ({ k: s.k, d: s.d, t: s.t, u: s.u, read: true, kind: "skip", why: "old", id: "", case: "", what: "", sources: [], dropped: 0, note: "published " + s.p }));
  const keep = [...open.filter(s => before.has(s.k)).map(s => before.get(s.k)), ...aged], todo = open.filter(s => !before.has(s.k) && !old(s));
  const send = todo.slice(0, STORY_CAP), over = todo.slice(STORY_CAP).map(s => ({ k: s.k, d: s.d, t: s.t, u: s.u, kind: "unclear", why: "", id: "", case: "", what: "", sources: [], dropped: 0, note: "not sent: over the story cap" }));
  const rep = { v: 1, ran: today, checked: state.checked || "", model: "", ok: false, why: "", review: "full", verdicts: [...keep, ...over], issues: judged(state.issues), searches: 0, fetches: 0 };
  const done = () => {
    const quiet = rep.verdicts.every(v => v.kind === "skip");
    rep.review = (rep.ok || !send.length) && quiet && !rep.issues.length ? "light" : "full";
    fs.writeFileSync(path.join(out, "ai.json"), JSON.stringify(rep, null, 1) + "\n");
    try { fs.appendFileSync(path.join(out, "inbox.md"), "\n" + inboxLines(rep).join("\n")); } catch {}
    log(rep.ok || !send.length ? `settlements news read: ${send.length} sent, ${aged.length} old by date, ${keep.length - aged.length} kept from last week, ${rep.verdicts.filter(v => v.kind !== "skip").length} for the review; review ${rep.review}` : `settlements news not read: ${rep.why}; review full`);
    return rep;
  };
  if (!send.length) { rep.ok = true; rep.why = "nothing new to read"; return done(); }
  if (env.DRY === "1") { rep.why = "dry run"; rep.verdicts.push(...send.map(s => ({ k: s.k, d: s.d, t: s.t, u: s.u, kind: "unclear", why: "", id: "", case: "", what: "", sources: [], dropped: 0, note: "dry run" }))); return done(); }
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  if (validate === undefined) {
    try { const s = await import("./settlements.mjs"), c = s.appCompile(); validate = e => s.validate({ updated: today, items: [e] }, c); } catch { validate = null; }
  }
  const unsent = note => send.map(s => ({ k: s.k, d: s.d, t: s.t, u: s.u, kind: "unclear", why: "", id: "", case: "", what: "", sources: [], dropped: 0, note }));
  if (api === undefined) { const c = await client(env, { timeout: 8 * 60000 }); api = c.api; if (!api) { rep.why = c.why; rep.verdicts.push(...unsent("not read: " + c.why)); if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); } }
  const tools = [{ type: "web_search_20260209", name: "web_search", max_uses: Math.min(SEARCH_CAP, SEARCH_PER_STORY * send.length + 2), allowed_domains: DOMAINS },
    { type: "web_fetch_20260209", name: "web_fetch", max_uses: FETCH_CAP, allowed_domains: DOMAINS }];
  let why = "";
  for (const model of MODELS) {
    const params = { model, max_tokens: 8000, tools, messages: [{ role: "user", content: prompt(send, list.items, today) }] }, contents = [];
    let msg = null, err = null;
    for (let turn = 0; turn < 5; turn++) {   // a long server-tool turn stops at pause_turn: send it back as it is and the server goes on
      const r = await ask(api, params);
      if (r.error) { err = r.error; break; }
      msg = r.msg; contents.push(msg.content);
      if (msg.stop_reason !== "pause_turn") break;
      params.messages = [...params.messages, { role: "assistant", content: msg.content }];
    }
    if (err) { rep.why = err.why; rep.verdicts.push(...unsent("not read: " + err.why)); await tell(router, err, env); return done(); }
    const a = answer(msg), o = msg && msg.stop_reason !== "pause_turn" ? parse(a.text) : null;
    if (!o) { why = a.why || (msg && msg.stop_reason === "pause_turn" ? "still searching after 5 turns" : "no valid JSON"); log(`${model}: ${why}${model !== MODELS.at(-1) ? ", once more on the next model" : ""}`); continue; }
    rep.model = model; rep.ok = true; rep.searches = used(contents, "web_search"); rep.fetches = used(contents, "web_fetch");
    rep.verdicts.push(...check(o, send, list.items, seenUrls(contents), validate));
    await settle(router);
    return done();
  }
  rep.why = why; rep.verdicts.push(...unsent("not read: " + why)); await tell(router, { why, key: false }, env);
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("settlements-ai.mjs")) {
  if (!process.argv.includes("--selftest")) await run();
  else {
    const os = await import("node:os");
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stlai-")), quiet = () => {}, today = "2026-11-08";
    const items = [{ id: "fiat-500e", mk: "פיאט|FIAT", md: "500", y: [2021, 2023], t: "טווח נסיעה", st: "wait", until: "2027-12-31" }, { id: "kia-ceed", mk: "קיה", md: "CEED", y: [2013, 2018], t: "לוח מחוונים", st: "ok" }];
    fs.writeFileSync(path.join(tmp, "list.json"), JSON.stringify({ updated: "2026-11-01", checked: "2026-11-01", items }));
    const story = (n, t) => ({ s: "ייצוגית", t, u: `https://yitzugit.co.il/2026/11/0${n}/x${n}/`, p: "2026-11-0" + n, k: "k" + n, d: "2026-11-08" });
    const dir = (n, inbox, issues = {}) => { const d = path.join(tmp, String(n)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ checked: "2026-11-01", inbox, issues })); fs.writeFileSync(path.join(d, "inbox.md"), "# inbox\n"); return { OUT: d, LIST: path.join(tmp, "list.json") }; };
    const found = urls => ({ type: "web_search_tool_result", tool_use_id: "s1", content: urls.map(url => ({ type: "web_search_result", url, title: "x" })) });
    const fetched = url => ({ type: "web_fetch_tool_result", tool_use_id: "f1", content: { type: "web_fetch_result", url, content: {} } });
    const json = o => ({ type: "text", text: JSON.stringify(o) });
    const fake = (replies, sent = []) => ({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } });
    const calls = [], router = { alert: async (lv, key) => { calls.push(["alert", lv, key]); return { delivered: true }; }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
    const val = e => (/^[A-Z0-9|()?!]+$/.test(e.md || "") ? [] : ["md is not a capital pattern"]);
    const S = [story(1, "הסכם פשרה |38503-08-23| זהר כהן נ׳ סמלת מוטורס"), story(2, "בקשה לייצוגית נגד יבואן"), story(3, "הסכם פשרה | 1| יבואן"), story(4, "אושרה ייצוגית נגד חברת השכרה"), story(5, "הסדר חדש"), story(6, "עוד ידיעה")];
    const answer6 = { stories: [
      { n: 1, kind: "change", id: "fiat-500e", case: "38503-08-23", what: "בית המשפט אישר את ההסדר", fields: { st: "ok", evil: 1 }, sources: ["https://www.yitzugit.co.il/2026/10/28/notice/"] },
      { n: 2, kind: "skip", why: "filing", sources: ["https://www.ynet.co.il/a"] },
      { n: 3, kind: "skip", why: "listed", id: "made-up", sources: ["https://www.ynet.co.il/a"] },
      { n: 4, kind: "skip", why: "not_owners", sources: [] },
      { n: 5, kind: "new", what: "הסדר", entry: { mk: "קיה", md: "sportage", y: [2020, 2022], t: "x", b: "y", cond: "z", st: "ok", until: "2028-01-01", url: "https://kia-israel.co.il/x" }, sources: ["https://kia-israel.co.il/x", "https://example.com/not-found"] },
      { n: 6, kind: "ended", id: "kia-ceed", sources: ["https://example.com/never-seen"] }] };
    let sent = [];
    let r = await run({ env: dir(1, S), api: fake([{ stop_reason: "end_turn", content: [found(["https://yitzugit.co.il/2026/10/28/notice", "https://ynet.co.il/a"]), fetched("https://kia-israel.co.il/x"), json(answer6)] }], sent), router, log: quiet, today, validate: val });
    const by = n => r.verdicts.find(v => v.k === "k" + n);
    ok(r.ok && r.model === MODELS[0] && sent.length === 1 && sent[0].model === "claude-sonnet-5-5", "Sonnet 5.5 first, one call for the week's stories");
    ok(sent[0].tools[0].type === "web_search_20260209" && sent[0].tools[0].max_uses === SEARCH_CAP && sent[0].tools[1].type === "web_fetch_20260209" && sent[0].tools[0].allowed_domains.includes("yitzugit.co.il") && sent[0].tools[1].max_uses === FETCH_CAP, "search and fetch capped, on the fixed sites");
    ok(by(1).kind === "change" && by(1).id === "fiat-500e" && by(1).fields.st === "ok" && !("evil" in by(1).fields), "a court approval of a listed entry is a change with its id; unknown fields dropped");
    ok(by(2).kind === "skip" && by(2).why === "filing", "a filing with a found source is a skip");
    ok(by(3).kind === "unclear" && /known id/.test(by(3).note), "listed with an id not in the list goes to the review");
    ok(by(4).kind === "skip" && by(4).why === "not_owners", "a skip the title shows needs no source");
    ok(by(5).kind === "new" && by(5).dropped === 1 && /entry needs work/.test(by(5).note), "a new entry: the source not found is dropped and counted; a pattern the app cannot use is marked");
    ok(by(6).kind === "unclear" && /no source/.test(by(6).note), "ended without a found source goes to the review");
    ok(r.review === "full" && calls.filter(c => c[0] === "resolve").length === 2 && !calls.some(c => c[0] === "alert"), "candidates mean a full review; a good call closes ai:stl and ai:key");
    const md = fs.readFileSync(path.join(tmp, "1", "inbox.md"), "utf8");
    ok(/## קריאת Claude/.test(md) && /שינוי בהסדר שברשימה · fiat-500e · ת"צ 38503-08-23/.test(md) && /בדיקה: מלאה/.test(md), "the reading is added to inbox.md");
    const prev = path.join(tmp, "prev.json"); fs.copyFileSync(path.join(tmp, "1", "ai.json"), prev);

    sent = [];
    r = await run({ env: { ...dir(2, [S[1], S[3], story(7, "ידיעה חדשה")]), PREV_AI: prev }, api: fake([{ stop_reason: "end_turn", content: [found(["https://ynet.co.il/b"]), json({ stories: [{ n: 1, kind: "skip", why: "certified", sources: ["https://ynet.co.il/b"] }] })] }], sent), router, log: quiet, today, validate: val });
    ok(sent.length === 1 && /\n1 \| 2026-11-08 \| 2026-11-07 \| ייצוגית \| ידיעה חדשה/.test(sent[0].messages[0].content) && !/בקשה לייצוגית/.test(sent[0].messages[0].content), "a story read last week is not sent again; only the new one");
    ok(r.verdicts.length === 3 && r.review === "light", "every open story is nothing for the list and no coverage issue: a light review");
    r = await run({ env: { ...dir(3, [S[1]], { "retire chev-malibu": "2026-11-08", "source down: TheCar (1)": "2026-11-08" }), PREV_AI: prev }, api: fake([]), router, log: quiet, today });
    ok(r.ok && r.review === "light" && r.issues.length === 0, "an ended entry and a source down need no judgement: still light, no call");
    r = await run({ env: { ...dir(4, []), PREV_AI: prev }, api: fake([]), router, log: quiet, today });
    ok(r.ok && r.review === "light" && r.verdicts.length === 0, "nothing open: light");
    r = await run({ env: { ...dir(5, [], { "longer mazda-x: CX50": "2026-11-08" }) }, api: fake([]), router, log: quiet, today });
    ok(r.review === "full" && r.issues[0] === "longer mazda-x: CX50", "a coverage issue to judge: full");

    sent = [];
    r = await run({ env: dir(6, [S[0]]), api: fake([{ stop_reason: "pause_turn", content: [found(["https://yitzugit.co.il/n"])] }, { stop_reason: "end_turn", content: [{ type: "text", text: "Sorry, a summary" }] },
      { stop_reason: "end_turn", content: [found(["https://yitzugit.co.il/n"]), json({ stories: [{ n: 1, kind: "skip", why: "listed", id: "fiat-500e", sources: ["https://yitzugit.co.il/n/"] }] })] }], sent), router, log: quiet, today, validate: val });
    ok(sent.length === 3 && sent[1].messages.at(-1).role === "assistant" && sent[2].model === "claude-opus-5-5" && sent[2].messages.length === 1, "pause_turn goes back as it is; no valid JSON: once more on Opus 5.5, from the start");
    ok(r.ok && r.model === "claude-opus-5-5" && r.verdicts[0].kind === "skip" && r.verdicts[0].id === "fiat-500e", "the second model's answer is checked the same way");

    calls.length = 0;
    r = await run({ env: dir(7, [S[0]]), api: fake([{ stop_reason: "end_turn", content: [json({ nope: 1 })] }, { stop_reason: "end_turn", content: [{ type: "text", text: "no" }] }]), router, log: quiet, today });
    ok(!r.ok && r.why === "no valid JSON" && r.review === "full" && r.verdicts[0].kind === "unclear" && calls.some(c => c[0] === "alert" && c[2] === "ai:stl" && c[1] === "summary"), "no valid answer from either model: full review, ai:stl quietly");
    const e529 = Object.assign(new Error("x"), { status: 529 }), e400 = Object.assign(new Error("x"), { status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low" } } });
    calls.length = 0;
    r = await run({ env: dir(8, [S[0]]), api: fake([e529]), router, log: quiet, today });
    ok(!r.ok && r.why === "529 server" && r.review === "full" && calls.some(c => c[2] === "ai:stl") && reason(e529) === "529 server", "an API error: no second model, full review, ai:stl");
    fs.copyFileSync(path.join(tmp, "8", "ai.json"), path.join(tmp, "prev8.json")); sent = [];
    r = await run({ env: { ...dir(14, [S[0]]), PREV_AI: path.join(tmp, "prev8.json") }, api: fake([{ stop_reason: "end_turn", content: [found(["https://yitzugit.co.il/n"]), json({ stories: [{ n: 1, kind: "skip", why: "listed", id: "fiat-500e", sources: ["https://yitzugit.co.il/n"] }] })] }], sent), router, log: quiet, today, validate: val });
    ok(sent.length === 1 && r.verdicts.length === 1 && r.verdicts[0].read, "a story the last run could not read is sent again the next week");
    calls.length = 0;
    r = await run({ env: dir(9, [S[0]]), api: fake([e400]), router, log: quiet, today });
    ok(!r.ok && calls.some(c => c[2] === "ai:key" && c[1] === "day") && keyTrouble(e400), "the credit ran out: ai:key, Dudu acts");
    calls.length = 0;
    r = await run({ env: { ...dir(10, [S[0]]), ANTHROPIC_API_KEY: "" }, router, log: quiet, today });
    ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why) && r.review === "full" && calls.length === 0, "no key: switched off on purpose, nothing raised, full review");
    r = await run({ env: { ...dir(11, [S[0]]), DRY: "1" }, router, log: quiet, today });
    ok(!r.ok && r.why === "dry run" && r.review === "full", "dry run: no call, full review");
    sent = [];
    r = await run({ env: dir(15, [{ ...S[0], p: "2022-09-29", k: "o1" }, { ...S[1], p: "", k: "o2" }]), api: fake([{ stop_reason: "end_turn", content: [found(["https://ynet.co.il/a"]), json({ stories: [{ n: 1, kind: "skip", why: "filing", sources: ["https://ynet.co.il/a"] }] })] }], sent), router, log: quiet, today, validate: val });
    ok(sent.length === 1 && !/38503/.test(sent[0].messages[0].content) && r.verdicts.find(v => v.k === "o1").why === "old" && r.verdicts.find(v => v.k === "o2").why === "filing" && r.review === "light", "a story published before the October 2026 research is a skip by its date and never sent; one without a date is sent");
    r = await run({ env: dir(16, [{ ...S[0], p: "2021-05-04" }]), api: fake([]), router, log: quiet, today });
    ok(r.ok && r.review === "light" && r.verdicts[0].why === "old", "only old stories: no call, light");
    const many = Array.from({ length: 14 }, (_, i) => story(1, "ידיעה " + i)).map((s, i) => ({ ...s, k: "m" + i }));
    sent = [];
    r = await run({ env: dir(12, many), api: fake([{ stop_reason: "end_turn", content: [json({ stories: [] })] }], sent), router, log: quiet, today, validate: val });
    ok(sent[0].messages[0].content.split("\n").filter(l => /^\d+ \| 2026/.test(l)).length === STORY_CAP && r.verdicts.filter(v => /story cap/.test(v.note)).length === 2 && r.verdicts.every(v => v.kind === "unclear"), "at most 12 stories a call; the rest and the unanswered go to the review");
    const lines = []; await run({ env: dir(13, [S[1]]), api: fake([{ stop_reason: "end_turn", content: [found(["https://ynet.co.il/a"]), json({ stories: [{ n: 1, kind: "skip", why: "filing", sources: ["https://ynet.co.il/a"] }] })] }]), router, log: l => lines.push(l), today, validate: val });
    ok(lines.length === 1 && !/\$|token|usd|cost/i.test(lines[0]), "one log line, no cost or token count");
    const p = prompt([S[0]], items, today);
    ok(/Never guess/.test(p) && /never at fault/.test(p) && /fiat-500e \| פיאט\|FIAT \| 500 \| 2021-2023 \| טווח נסיעה \| wait until 2027-12-31/.test(p), "the prompt: found facts only, neutral words, the list in brief");
    ok(judged({ "retire a": 1, "source down: x": 1, "none b": 1 }).join() === "none b", "only issues that need judgement count");
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  }
}
