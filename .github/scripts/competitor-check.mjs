// Monthly competitor check (strategy thread; Dudu 24.10.2026 "5. מצויין"; moved to the monthly API credit on 1.11.2026, "תשחרר את כל ה5").
// On the 1st, one Claude conversation (Sonnet 5.5 with the server web_search tool, searches capped) looks for what changed since the last run
// in the alternatives Israeli drivers weigh against לוחית, and writes competitors.json for the branch competitor-check. The strategy thread's
// scheduled task reads that file and is woken only when something changed.
// Machine check: a change is kept only when its source is a page the search returned in this same call (a source the model did not find
// is dropped and counted), with an area from a fixed list and short plain text. Competitors are alternatives people choose between, described
// neutrally, never as villains.
// Fallback (claude.mjs): no key, no SDK, an API error or no valid answer leaves ok:false and why; the scheduled task then checks by hand as
// before, and the run stays green. A failed call raises ai:comp (summary), the key or the credit ai:key (day, Dudu acts); a good call closes both.
// A change found is told by the bot itself (Dudu 1.11.2026 14:36, "אם אין בהם צורך אז כן": no thread is woken for it): key comp:<YYYY-MM>,
// level day when it touches our differentiation (alerts after purchase, free full check, recall/ownership alerts, price), else summary.
// The log is public: no cost, no token count, no business number.
//   node competitor-check.mjs              env: OUT (dir, default "out"), PREV (last competitors.json, optional), DRY=1 (no call)
//   node competitor-check.mjs --selftest   offline, through a fake API
import fs from "node:fs";
import path from "node:path";
import { client, ask, answer, reason, keyTrouble } from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5";
export const MAX_SEARCHES = 24;   // runs of 1.11.2026 used up 12, then 16, before Ototo and the ministry were done
export const AREAS = ["price", "alerts", "recalls", "ownership", "free_check", "platform", "new_app", "gov", "other"];
// what was known on the last change of this list (24.10.2026 review, strategy.md); the model reports only what differs from it
export const KNOWN = [
  "Ototo (iOS only, from June 2026): renewal reminders for test, insurance and licence fee, auto-fills the test date, free for one car with ads",
  "Autoboom: paid plate report (about 55 ₪), ownership history from 2017, buying help",
  "Carzone (קארזון): plate report before buying, car news",
  "Infocar / the clearing-house price (מחירון): paid price report (about 12 ₪)",
  "Autoil (iOS): vehicle details by plate, subscription about $39.99 a year",
  "PicACar (iOS): free plate lookup incl. open recalls",
  "Plate App (iOS): plate lookup, about 49 ₪",
  "Balcar (99-149 ₪) and Find-Car (140-280 ₪): paid history reports",
  "Ministry of Transport: open data on data.gov.il; no official app or push for recalls",
];
const OURS = "לוחית (luchit.app, Android + web): free full check by plate, alerts after purchase for recalls, ownership change and the yearly test, no ads.";

export function prompt(since) {
  return [
    `You check, once a month, what changed since ${since} in the Israeli apps and services that drivers use to check a car by its licence plate or to get reminders about their car.`,
    `For context, the app this report is for: ${OURS}`,
    "What was known last time:", ...KNOWN.map(k => "- " + k),
    "Search in this order and finish each before the next: Ototo (two searches at most), the Ministry of Transport (two at most), a NEW Israeli plate-check or car-reminder app (three at most), then the rest. Search the web (Hebrew and English queries; Google Play and the App Store count) for: a new Android or iOS version of any of them, new or removed alerts or reminders, recall or ownership-change alerts, a free tier or a price change, a NEW Israeli plate-check or car-reminder app, and anything the Ministry of Transport launched (an app, recall notifications).",
    "Report only real changes after " + since + " that you found on a page you searched. Nothing found means no change: never guess, never repeat what is already known above.",
    "Describe each competitor neutrally, as an alternative people choose between.",
    "Answer with JSON only, no other text:",
    '{"changes":[{"who":"name","what":"one Hebrew sentence on what changed","url":"https://the page that shows it","area":"' + AREAS.join("|") + '","material":true}],"checked":["names you searched"],"note":"one Hebrew sentence"}',
    "material = it touches our differentiation: alerts after purchase, a free full check, recall or ownership alerts, or price.",
  ].join("\n");
}

const clean = (s, n) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);
const norm = u => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + x.pathname.replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } };
// every page the server search returned in this conversation, and every citation of the text
export function seenUrls(contents) {
  const seen = new Set();
  const add = u => { const n = norm(u); if (n) seen.add(n); };
  for (const content of contents) for (const b of content || []) {
    if (b.type === "web_search_tool_result" && Array.isArray(b.content)) b.content.forEach(r => add(r.url));
    if (b.type === "text") (b.citations || []).forEach(c => add(c.url));
  }
  return seen;
}
// searches used in this conversation: at the cap, the note says what was left unchecked
export const searches = contents => contents.flat().filter(b => b && b.type === "server_tool_use" && b.name === "web_search").length;
export function parse(text, any) {
  const t = String(text || ""), i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { const o = JSON.parse(t.slice(i, j + 1)); return o && (any || Array.isArray(o.changes)) ? o : null; } catch { return null; }
}
export function check(o, seen) {
  const keep = [], dropped = [];
  for (const c of o.changes.slice(0, 20)) {
    const ch = { who: clean(c.who, 60), what: clean(c.what, 300), url: String(c.url || ""), area: AREAS.includes(c.area) ? c.area : "other", material: c.material === true };
    if (!ch.who || !ch.what || !/^https:\/\//.test(ch.url) || !seen.has(norm(ch.url))) dropped.push(ch.who || "?"); else keep.push(ch);
  }
  return { changes: keep, dropped, checked: (Array.isArray(o.checked) ? o.checked : []).map(x => clean(x, 40)).filter(Boolean).slice(0, 20), note: clean(o.note, 300) };
}

// the router (alert.mjs): a failed call is ai:comp (summary), the key or the credit is ai:key (day, Dudu acts); a good call closes both
async function tell(router, err, env) {
  if (!router) return;
  let t = { tag: () => "", todo: () => "", folded: () => "" };
  try { t = await import("./tg-text.mjs"); } catch {}
  const text = err.key
    ? [t.tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן בדיקת המתחרים החודשית לא רצה. שרשור האסטרטגיה יבדוק בעצמו.",
        t.todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + t.folded(err.why)
    : [t.tag("info", "bots"), "בדיקת המתחרים החודשית לא הצליחה הפעם לקבל תשובה מ-Claude. שרשור האסטרטגיה יבדוק בעצמו.", t.todo()].join("\n") + t.folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:comp", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch { /* the log line says it */ }
}
async function settle(router) {
  if (!router) return;
  try { await router.resolve(["ai:comp"]); await router.resolve(["ai:key"]); } catch { /* the morning ledger still shows it */ }
}

const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// one router message for the month's changes (each with its source); no change = no message
export function changeText(rep) {
  const lines = rep.changes.map(c => `• <b>${esc(c.who)}</b>: ${esc(c.what)}${c.material ? " (נוגע במה שמייחד את לוחית)" : ""}\n${esc(c.url)}`);
  return [rep.material ? "<b>🔎 היום · שיווק</b>" : "<b>🔎 לידיעה · שיווק</b>", `בדיקת המתחרים החודשית מצאה ${rep.changes.length === 1 ? "שינוי אחד" : rep.changes.length + " שינויים"} מאז ${rep.since}:`, ...lines,
    rep.material ? "👉 מה לעשות: להחליט אם זה משנה משהו אצלנו. שרשור האסטרטגיה יעדכן את טבלאות המתחרים כשיתבקש." : "👌 לא צריך לעשות כלום."].join("\n");
}
async function announce(router, rep, env) {
  if (!router || !rep.changed) return;
  try { await router.alert(rep.material ? "day" : "summary", "comp:" + rep.when.slice(0, 7), changeText(rep), rep.changes.map(c => c.url).slice(0, 3), { today: rep.material ? "loud" : "silent", legacy: () => false }); } catch { /* the branch file still has it */ }
}

// one conversation with the server web search: a paused turn goes back as it is (no extra user message), up to 4 turns
async function converse(api, content, maxUses = MAX_SEARCHES) {
  const params = { model: MODEL, max_tokens: 6000, tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxUses }], messages: [{ role: "user", content }] };
  const contents = []; let msg = null;
  for (let turn = 0; turn < 4; turn++) {
    const r = await ask(api, params);
    if (r.error) return { error: r.error };
    msg = r.msg; contents.push(msg.content);
    if (msg.stop_reason !== "pause_turn") break;
    params.messages = [...params.messages, { role: "assistant", content: msg.content }];
  }
  if (msg.stop_reason === "pause_turn") return { contents, json: null, why: "still searching after 4 turns" };
  const a = answer(msg);
  return { contents, json: parse(a.text, "any"), why: a.why };
}

export const NEEDS_SEARCHES = 12;
export function needsPrompt(since) {
  return [
    "You collect, once a month, what Israeli drivers say they miss or like in the apps and services they use to check a car by its licence plate or to get reminders about their car: " + KNOWN.map(k => k.split(":")[0].split(" (")[0]).join(", ") + ", and similar.",
    `Look for user reviews (Google Play, the App Store), forum threads and comments (in Hebrew or English), preferably from after ${since}, older if there is nothing newer.`,
    `For context, the app this is for: ${OURS}`,
    "Report up to 8 NEEDS, each one a thing users want that is missing, broken or hard (or a thing they clearly value), written as the need, not as a complaint about a company. Describe every app neutrally: they are alternatives people choose between. No names of reviewers, no quotes longer than a few words.",
    "Each need must come from a page you searched; give that page. Nothing found means an empty list: never guess.",
    'Answer with JSON only, no other text: {"needs":[{"need":"one Hebrew sentence","about":"the app or service","url":"https://the page","how_many":"one|few|many","we_have":true}],"note":"one Hebrew sentence"}',
    "we_have = לוחית already covers this need.",
  ].join("\n");
}
export function checkNeeds(o, seen) {
  const needs = [], dropped = [];
  for (const n of o.needs.slice(0, 12)) {
    const x = { need: clean(n.need, 240), about: clean(n.about, 60), url: String(n.url || ""), how_many: ["one", "few", "many"].includes(n.how_many) ? n.how_many : "one", we_have: n.we_have === true };
    if (!x.need || !/^https:\/\//.test(x.url) || !seen.has(norm(x.url))) dropped.push(x.about || "?"); else needs.push(x);
  }
  return { needs: needs.slice(0, 8), dropped: dropped.length };
}
export function needsText(rep) {
  const lines = rep.needs.map(n => `• ${esc(n.need)} (${esc(n.about)}${n.how_many === "many" ? ", הרבה משתמשים" : n.how_many === "few" ? ", כמה משתמשים" : ""}${n.we_have ? ", כבר קיים בלוחית" : ""})\n${esc(n.url)}`);
  return ["<b>🔎 לידיעה · שיווק</b>", "מה משתמשים מבקשים מאפליקציות דומות החודש (מתוך ביקורות ופורומים):", ...lines, "👌 לא צריך לעשות כלום. זה חומר לבחירת מה בונים אחרי ההקפאה."].join("\n");
}
async function announceNeeds(router, rep) {
  if (!router || !rep.needs_ok || !rep.needs.length) return;
  try { await router.alert("summary", "comp:needs:" + rep.when.slice(0, 7), needsText(rep), rep.needs.map(n => n.url).slice(0, 3), { today: "silent", legacy: () => false }); } catch { /* the branch file still has it */ }
}

export async function run({ env = process.env, api, router, log = console.log, now = new Date() } = {}) {
  const out = env.OUT || "out";
  let prev = null; try { prev = JSON.parse(fs.readFileSync(env.PREV || "", "utf8")); } catch {}
  const since = (prev && prev.ok && prev.when ? new Date(prev.when) : new Date(now - 31 * 864e5)).toISOString().slice(0, 10);
  const rep = { v: 1, when: now.toISOString(), since, model: MODEL, ok: false, why: "", changed: false, material: false, changes: [], dropped: 0, capped: false, checked: [], note: "", needs_ok: false, needs_why: "", needs: [], needs_dropped: 0 };
  const done = () => { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, "competitors.json"), JSON.stringify(rep, null, 1) + "\n");
    log(rep.ok ? `competitor check ok: ${rep.changes.length} change(s), ${rep.dropped} without a found source dropped; needs ${rep.needs_ok ? rep.needs.length + " kept, " + rep.needs_dropped + " dropped" : "skipped: " + rep.needs_why}` : `competitor check skipped: ${rep.why}`); return rep; };
  if (env.DRY === "1") { rep.why = "dry run"; return done(); }
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  if (api === undefined) { const c = await client(env, { timeout: 8 * 60000 }); api = c.api; if (!api) { rep.why = c.why; if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); } }
  const first = await converse(api, prompt(since));
  if (first.error) { rep.why = first.error.why; await tell(router, first.error, env); return done(); }
  const o = first.json;
  if (!o || !Array.isArray(o.changes)) { rep.why = first.why || "no valid JSON"; await tell(router, { why: rep.why, key: false }, env); return done(); }
  const c = check(o, seenUrls(first.contents));
  Object.assign(rep, { ok: true, changes: c.changes, dropped: c.dropped.length, checked: c.checked, note: c.note, capped: searches(first.contents) >= MAX_SEARCHES, changed: c.changes.length > 0, material: c.changes.some(x => x.material) });
  // package B (Dudu 1.11 21:16): what people say they miss in the alternatives, from reviews and forums, each need with its source
  const second = await converse(api, needsPrompt(since), NEEDS_SEARCHES);
  if (second.error) { rep.needs_why = second.error.why; if (second.error.key) await tell(router, second.error, env); }
  else if (!second.json || !Array.isArray(second.json.needs)) rep.needs_why = second.why || "no valid JSON";
  else { const n = checkNeeds(second.json, seenUrls(second.contents)); Object.assign(rep, { needs_ok: true, needs: n.needs, needs_dropped: n.dropped }); }
  await settle(router);
  await announce(router, rep, env);
  await announceNeeds(router, rep);
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("competitor-check.mjs")) {
  if (!process.argv.includes("--selftest")) await run();
  else {
    const os = await import("node:os");
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "comp-"));
    const quiet = () => {}, now = new Date("2026-12-01T04:23:00Z");
    const found = { type: "web_search_tool_result", tool_use_id: "s1", content: [{ type: "web_search_result", url: "https://play.google.com/store/apps/details?id=x.ototo", title: "Ototo" }] };
    const json = o => ({ type: "text", text: JSON.stringify(o) });
    const two = { changes: [
      { who: "Ototo", what: "יצאה גרסה לאנדרואיד עם תזכורות טסט", url: "https://play.google.com/store/apps/details?id=x.ototo", area: "platform", material: true },
      { who: "Other", what: "something not on a searched page", url: "https://example.com/made-up", area: "price", material: true }], checked: ["Ototo", "Autoboom"], note: "בדיקה" };
    const NONE = { stop_reason: "end_turn", content: [{ type: "text", text: '{"needs":[]}' }] };   // the needs call, when a test gives no reply for it
    const fake = (replies, sent = []) => ({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); const r = replies.length ? replies.shift() : NONE; if (r instanceof Error) throw r; return r; } } });
    const calls = [], router = { alert: async (lv, key) => { calls.push(["alert", lv, key]); return { delivered: true }; }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
    const env = n => ({ OUT: path.join(tmp, String(n)) });

    let sent = [];
    let r = await run({ env: env(1), api: fake([{ stop_reason: "end_turn", content: [found, json(two)] }], sent), router, log: quiet, now });
    ok(r.ok && r.changes.length === 1 && r.changes[0].who === "Ototo" && r.dropped === 1 && r.changed && r.material, "a change is kept only with a source the search returned; the other is dropped and counted");
    ok(sent[0].model === MODEL && sent[0].tools[0].type === "web_search_20260209" && sent[0].tools[0].max_uses === MAX_SEARCHES, "Sonnet 5.5, the server web search, searches capped");
    ok(/since 2026-10-31|after 2026-10-31/.test(sent[0].messages[0].content), "no earlier run: the last 31 days");
    ok(calls.some(c => c[1] === "ai:comp") && calls.some(c => c[1] === "ai:key") && !calls.some(c => c[0] === "alert" && /^ai/.test(c[2])), "a good run closes ai:comp and ai:key and raises no ai item");
    ok(calls.some(c => c[0] === "alert" && c[1] === "day" && c[2] === "comp:2026-12"), "a material change is told by the bot itself: comp:<month>, level day");
    { const t = changeText(r); ok(/Ototo/.test(t) && /play\.google\.com/.test(t) && !/example\.com/.test(t) && !/<script/.test(changeText({ ...r, changes: [{ who: "<script>", what: "x", url: "https://a.b", material: false }] })), "the message lists each kept change with its source, escaped"); }
    ok(JSON.parse(fs.readFileSync(path.join(tmp, "1", "competitors.json"), "utf8")).changes.length === 1, "competitors.json written");

    fs.writeFileSync(path.join(tmp, "prev.json"), JSON.stringify({ ok: true, when: "2026-11-01T04:23:00Z" }));
    sent = []; calls.length = 0;
    r = await run({ env: { ...env(2), PREV: path.join(tmp, "prev.json") }, api: fake([{ stop_reason: "pause_turn", content: [found] }, { stop_reason: "end_turn", content: [json({ changes: [], checked: ["Ototo"], note: "אין שינוי" })] }], sent), router, log: quiet, now });
    ok(!calls.some(c => c[0] === "alert"), "no change: no message");
    ok(r.ok && !r.changed && !r.material && sent.length === 3 && sent[1].messages.at(-1).role === "assistant" && sent[1].messages.length === 2, "pause_turn: the paused turn goes back as it is, no extra user message; no change = changed false");
    ok(/2026-11-01/.test(sent[0].messages[0].content), "since the last good run");

    const citeOnly = { stop_reason: "end_turn", content: [{ type: "text", text: "", citations: [{ url: "https://www.gov.il/he/departments/news/recalls-app/" }] }, json({ changes: [{ who: "משרד התחבורה", what: "<b>אפליקציה</b> חדשה להתראות ריקול", url: "https://gov.il/he/departments/news/recalls-app", area: "nope", material: true }] })] };
    r = await run({ env: env(3), api: fake([citeOnly]), router, log: quiet, now });
    ok(calls.some(c => c[0] === "alert" && c[1] === "day"), "a material change from a cited page is told too");
    calls.length = 0;
    await run({ env: env(31), api: fake([{ stop_reason: "end_turn", content: [found, json({ changes: [{ ...two.changes[0], material: false }] })] }]), router, log: quiet, now });
    ok(calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "comp:2026-12"), "a change that does not touch our differentiation: summary level, quiet");
    ok(r.ok && r.changes.length === 1 && r.changes[0].area === "other" && r.changes[0].what === "אפליקציה חדשה להתראות ריקול", "a cited page counts as found (www and a trailing slash ignored); an unknown area is other; no HTML");

    calls.length = 0;
    r = await run({ env: env(4), api: fake([{ stop_reason: "end_turn", content: [found, { type: "text", text: "Sorry, here is a summary" }] }]), router, log: quiet, now });
    ok(!r.ok && r.why === "no valid JSON" && calls.some(c => c[0] === "alert" && c[2] === "ai:comp" && c[1] === "summary"), "no valid answer: ok false, ai:comp quietly");

    const e529 = Object.assign(new Error("x"), { status: 529 });
    calls.length = 0;
    r = await run({ env: env(5), api: fake([e529]), router, log: quiet, now });
    ok(!r.ok && r.why === "529 server" && calls.some(c => c[2] === "ai:comp"), "an API error: ok false, ai:comp");
    const e400 = Object.assign(new Error("x"), { status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low" } } });
    calls.length = 0;
    r = await run({ env: env(6), api: fake([e400]), router, log: quiet, now });
    ok(!r.ok && calls.some(c => c[2] === "ai:key" && c[1] === "day") && keyTrouble(e400) && reason(e529) === "529 server", "the credit ran out: ai:key, Dudu acts");

    calls.length = 0;
    r = await run({ env: { ...env(7), ANTHROPIC_API_KEY: "" }, router, log: quiet, now });
    ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why) && calls.length === 0, "no key: switched off on purpose, nothing raised");
    r = await run({ env: { ...env(8), DRY: "1" }, router, log: quiet, now });
    ok(!r.ok && r.why === "dry run", "dry run: no call");

    // package B: needs from reviews, each with a page the search returned
    { const page = { type: "web_search_tool_result", tool_use_id: "s9", content: [{ type: "web_search_result", url: "https://apps.apple.com/il/app/x/id1", title: "x" }] };
      const needs = { needs: [{ need: "תזכורת לטסט גם לרכב שני", about: "Ototo", url: "https://apps.apple.com/il/app/x/id1", how_many: "few", we_have: true },
        { need: "something without a page", about: "Y", url: "https://example.com/z", how_many: "many" }], note: "" };
      const sent2 = []; calls.length = 0;
      r = await run({ env: env(20), api: fake([{ stop_reason: "end_turn", content: [found, json({ changes: [] })] }, { stop_reason: "end_turn", content: [page, json(needs)] }], sent2), router, log: quiet, now });
      ok(r.ok && r.needs_ok && r.needs.length === 1 && r.needs_dropped === 1 && r.needs[0].we_have, "needs: kept only with a page the search returned");
      ok(sent2.length === 2 && sent2[1].tools[0].max_uses === NEEDS_SEARCHES && /neutrally/.test(sent2[1].messages[0].content) && /No names of reviewers/.test(sent2[1].messages[0].content), "a second call for the needs: its own search cap, neutral, no reviewer names");
      ok(calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "comp:needs:2026-12") && !calls.some(c => c[0] === "alert" && c[2] === "comp:2026-12"), "needs found: one quiet summary message; no change: no change message");
      ok(/תזכורת לטסט/.test(needsText(r)) && /כבר קיים בלוחית/.test(needsText(r)) && !/example\.com/.test(needsText(r)), "the needs message lists each kept need with its page");
      calls.length = 0;
      r = await run({ env: env(21), api: fake([{ stop_reason: "end_turn", content: [found, json({ changes: [] })] }, Object.assign(new Error("x"), { status: 529 })]), router, log: quiet, now });
      ok(r.ok && !r.needs_ok && r.needs_why === "529 server" && !calls.some(c => c[0] === "alert"), "a failed needs call leaves the competitor result as it is, and raises nothing (ai:key only for the key)");
      calls.length = 0;
      r = await run({ env: env(22), api: fake([{ stop_reason: "end_turn", content: [found, json({ changes: [] })] }]), router, log: quiet, now });
      ok(r.needs_ok && r.needs.length === 0 && !calls.some(c => c[0] === "alert"), "no needs found: no message"); }
    const lines = []; await run({ env: env(9), api: fake([{ stop_reason: "end_turn", content: [found, json(two)] }]), router, log: l => lines.push(l), now });
    const many = Array.from({ length: MAX_SEARCHES }, (_, i) => ({ type: "server_tool_use", id: "s" + i, name: "web_search", input: { query: "q" } }));
    r = await run({ env: env(10), api: fake([{ stop_reason: "end_turn", content: [...many, found, json(two)] }]), router, log: quiet, now });
    ok(r.ok && r.capped && !(await run({ env: env(11), api: fake([{ stop_reason: "end_turn", content: [found, json(two)] }]), router, log: quiet, now })).capped, "capped: true only when every search was used");
    ok(/Ototo \(two searches at most\), the Ministry of Transport/.test(prompt("x")), "the most important names are searched first, each with a budget");
    ok(lines.length === 1 && !/\$|token|usd/i.test(lines[0]), "one log line, no cost or token count");
    ok(prompt("2026-11-01").includes("never guess") && /neutrally/.test(prompt("x")), "the prompt asks for found changes only, described neutrally");
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  }
}
