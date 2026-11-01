// Weekly SEO analysis draft (Mondays, from seo-data.yml). Reads the plain Search Console snapshot that seo-data.mjs leaves on the runner
// (SEO_WEEKLY_PLAIN, never committed), computes the week's facts (last 7 days against the 7 before, movers by query and page, index coverage
// by section, the A3 pilot against its control group, the change ledger), and has Claude write a Hebrew draft analysis from those facts only.
// Every number in the draft must appear in the facts; a draft that fails twice is kept but marked, since a person reads it before anything
// is done. The output holds business numbers, so it leaves the run sealed with .github/seo-data.pub.pem (out-weekly/seo-weekly.enc.json).
// The log prints no business numbers and no token counts.
//   node seo-weekly.mjs <plain.json>          node seo-weekly.mjs --selftest
import fs from "node:fs";
import crypto from "node:crypto";
import { client, ask, answer } from "./claude.mjs";

export const MODEL = "claude-sonnet-5-5";
export const EFFORT = "high";   // once a week, read by a person: care over cents
const r1 = x => Math.round(x * 10) / 10, pct = (a, b) => b ? Math.round((a - b) / b * 100) : null;
const path = u => { try { return new URL(u).pathname; } catch { return u; } };
const section = p => p === "/" ? "home" : (p.split("/")[1] || "home");

function totals(rows) {
  const t = { clicks: 0, impressions: 0, pw: 0 };
  for (const r of rows) { t.clicks += r.clicks || 0; t.impressions += r.impressions || 0; t.pw += (r.position || 0) * (r.impressions || 0); }
  return { clicks: t.clicks, impressions: t.impressions, ctr_percent: t.impressions ? r1(t.clicks / t.impressions * 100) : 0, position: t.impressions ? r1(t.pw / t.impressions) : null };
}
function movers(cur, prev, key, n = 8) {
  const m = new Map();
  for (const r of prev) m.set(key(r), { prev_clicks: r.clicks || 0, prev_impressions: r.impressions || 0, prev_position: r1(r.position || 0) });
  for (const r of cur) m.set(key(r), { ...(m.get(key(r)) || { prev_clicks: 0, prev_impressions: 0, prev_position: null }), clicks: r.clicks || 0, impressions: r.impressions || 0, position: r1(r.position || 0) });
  const all = [...m].map(([k, v]) => ({ key: k, clicks: v.clicks || 0, impressions: v.impressions || 0, position: v.position ?? null, ...v, d: (v.clicks || 0) - v.prev_clicks, di: (v.impressions || 0) - v.prev_impressions }));
  const strip = ({ d, di, ...x }) => x;
  return {
    up: all.filter(x => x.d > 0 || (x.d === 0 && x.di > 0)).sort((a, b) => b.d - a.d || b.di - a.di).slice(0, n).map(strip),
    down: all.filter(x => x.d < 0 || (x.d === 0 && x.di < 0)).sort((a, b) => a.d - b.d || a.di - b.di).slice(0, n).map(strip),
    new_queries_or_pages: all.filter(x => !x.prev_impressions && x.impressions).length,
  };
}
const status = c => !c ? "error" : /נוסף לאינדקס|^Submitted and indexed|^Indexed/.test(c) ? "indexed" : /^נסרק|^Crawled/.test(c) ? "crawled_not_indexed"
  : /^התגלה|^Discovered/.test(c) ? "discovered_not_indexed" : /לא ידועה|unknown/i.test(c) ? "unknown_to_google" : "other";

export function facts(d, { ledger = {}, answers = {}, today = new Date().toISOString().slice(0, 10) } = {}) {
  const w = d.week || {};
  const f = { generated: today, windows: { week_days: 7, rule_days: 21 }, week: w.cur || null, previous_week: w.prev || null };
  if (w.byDate) {
    const days = [...w.byDate].sort((a, b) => a.keys[0] < b.keys[0] ? -1 : 1);
    const cur = days.filter(r => r.keys[0] >= w.cur[0] && r.keys[0] <= w.cur[1]), prev = days.filter(r => r.keys[0] >= w.prev[0] && r.keys[0] <= w.prev[1]);
    const a = totals(cur), b = totals(prev);
    f.totals = { this_week: a, previous_week: b, change_percent: { clicks: pct(a.clicks, b.clicks), impressions: pct(a.impressions, b.impressions) } };
  }
  if (w.byQuery) f.queries = movers(w.byQuery, w.byQueryPrev || [], r => r.keys[0]);
  if (w.byPage) f.pages = movers(w.byPage, w.byPagePrev || [], r => path(r.keys[0]));
  const cov = {};
  for (const i of d.inspection || []) { const s = section(path(i.url)), k = i.error ? "error" : status(i.coverage); (cov[s] ||= {})[k] = (cov[s][k] || 0) + 1; }
  f.index_by_section = cov;
  if (answers.pilot) {
    const st = new Map((d.inspection || []).map(i => [path(i.url), i.error ? "error" : status(i.coverage)]));
    const count = list => { const c = {}; for (const s of list) { const k = st.get(`/model/${s}/`) || "not_inspected"; c[k] = (c[k] || 0) + 1; } return c; };
    f.summary_test = { since: answers.since, pilot_pages: answers.pilot.length, pilot: count(answers.pilot), control: count(answers.control || []),
      pilot_with_summary_live: Object.keys(answers).filter(k => answers.pilot.includes(k)).length };
  }
  const recent = Object.entries(ledger).filter(([k, v]) => k !== "_about" && v && v.date && (Date.parse(today) - Date.parse(v.date)) / 864e5 < 28)
    .map(([k, v]) => ({ url: path(k.replace(/\*$/, "")) + (k.endsWith("*") ? "*" : ""), date: v.date, what: v.what, locked_until: new Date(Date.parse(v.date) + 21 * 864e5).toISOString().slice(0, 10) }));
  f.recent_changes = recent;
  f.snapshot_errors = (d.errors || []).length;
  return f;
}

const SCHEMA = { type: "object", additionalProperties: false, required: ["headline", "what_changed", "hypotheses", "actions", "watch"], properties: {
  headline: { type: "string" },
  what_changed: { type: "array", items: { type: "string" } },
  hypotheses: { type: "array", items: { type: "string" } },
  actions: { type: "array", items: { type: "object", additionalProperties: false, required: ["action", "target", "why", "allowed_now"],
    properties: { action: { type: "string" }, target: { type: "string" }, why: { type: "string" }, allowed_now: { type: "boolean" } } } },
  watch: { type: "array", items: { type: "string" } } } };

export const SYSTEM = `You are the analyst for luchit.app, a Hebrew site that checks Israeli vehicles by licence plate from Ministry of Transport open data (model pages, guides, a monthly magazine, check pages). Each Monday you write a short internal draft for the site's SEO lead, who decides what to do.

Write in Hebrew. Use only the facts given in the user message. Every number you write must appear in those facts exactly as written there; when you need a number that is not there, describe it in words instead. Do not compute new numbers.
- headline: one sentence on the week's most important change.
- what_changed: 3-6 short items, each naming a concrete query, page or section and its numbers.
- hypotheses: 2-4 possible reasons, each written as a possibility ("ייתכן ש..."), never as a certainty. Consider seasonality, Google's own fluctuation, recent site changes from recent_changes, and indexing status.
- actions: 1-4 concrete next steps. A change to a title, meta description or internal links of a URL listed in recent_changes before its locked_until date is not allowed: set allowed_now to false and say when it becomes possible. Never propose buying links, mass page creation, or new-model articles.
- watch: 1-3 things to check next week.
If summary_test is present, it compares model pages that got a written summary (pilot) with matched pages that did not (control); mention it only as an early reading, since indexing takes weeks.
Car dealers and importers are customers of the site, never adversaries. Do not mention licence plates or people.`;

export const request = (f, hint) => ({ model: MODEL, max_tokens: 12000, thinking: { type: "adaptive" }, output_config: { effort: EFFORT, format: { type: "json_schema", schema: SCHEMA } },
  system: SYSTEM, messages: [{ role: "user", content: "Facts (JSON):\n" + JSON.stringify(f) + (hint ? `\n\nYour previous draft was rejected: ${hint}. Write it again.` : "") }] });

const NUM = /\d[\d,.]*\d|\d/g;
const nums = t => [...String(t).matchAll(NUM)].map(m => m[0].replace(/,/g, "").replace(/\.$/, ""));
const flat = x => typeof x === "string" ? [x] : Array.isArray(x) ? x.flatMap(flat) : x && typeof x === "object" ? Object.values(x).flatMap(flat) : [];
export function check(f, draft) {
  if (!draft || typeof draft !== "object" || !draft.headline) return "not JSON";
  const allowed = new Set(nums(JSON.stringify(f)).flatMap(n => [n, n.replace(/^-/, "")]));
  for (const t of flat(draft)) {
    const bad = nums(t).find(n => !allowed.has(n)); if (bad) return "unknown number " + bad;
    if (/זכאי/.test(t)) return "forbidden wording זכאי";
  }
  for (const a of draft.actions || []) if (a.allowed_now && (f.recent_changes || []).some(c => c.locked_until > f.generated && (a.target || "").includes(c.url.replace(/\*$/, "")) && /כותרת|תיאור|meta|קישור/i.test(a.action)))
    return "an action breaks the 21-day rule";
  return "";
}

export async function write(f, { env = process.env, api } = {}) {
  if (!api) { if (!env.ANTHROPIC_API_KEY) return { draft: null, check: "no key" }; const c = await client(env, { timeout: 600000 }); if (!c.api) return { draft: null, check: c.why }; api = c.api; }
  let hint = "", last = "";
  for (let i = 0; i < 2; i++) {
    const r = await ask(api, request(f, hint));
    if (r.error) return { draft: null, check: r.error.why, key: r.error.key };
    const a = answer(r.msg); let draft = null;
    if (a.text) try { draft = JSON.parse(a.text); } catch {}
    const why = a.why || check(f, draft);
    if (!why) return { draft, check: "ok", tries: i + 1 };
    last = why; hint = /^(unknown|forbidden|an action|not JSON)/.test(why) ? why : "";
    if (i === 1 && draft) return { draft, check: "failed: " + why, tries: 2 };
  }
  return { draft: null, check: "failed: " + last, tries: 2 };
}

export function seal(obj, pem) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  const ek = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

async function selftest() {
  let n = 0; const ok = (c, m) => { if (!c) { console.log("FAIL", m); process.exit(1); } n++; console.log("ok  ", m); };
  const d = { errors: [], inspection: [
    { url: "https://luchit.app/model/octavia-676/", coverage: "נסרק - כרגע לא נכלל באינדקס" }, { url: "https://luchit.app/model/i30-253/", coverage: "הדף נשלח ונוסף לאינדקס" },
    { url: "https://luchit.app/", coverage: "הדף נשלח ונוסף לאינדקס" }, { url: "https://luchit.app/guide/x/", error: true }],
    week: { cur: ["2026-10-26", "2026-11-01"], prev: ["2026-10-19", "2026-10-25"],
      byDate: [{ keys: ["2026-10-20"], clicks: 10, impressions: 400, position: 9 }, { keys: ["2026-10-27"], clicks: 6, impressions: 500, position: 8 }],
      byQuery: [{ keys: ["טסט לרכב"], clicks: 4, impressions: 90, position: 6.24 }], byQueryPrev: [{ keys: ["טסט לרכב"], clicks: 7, impressions: 80, position: 5 }, { keys: ["אוקטביה"], clicks: 1, impressions: 3, position: 30 }],
      byPage: [{ keys: ["https://luchit.app/model/octavia-676/"], clicks: 2, impressions: 50, position: 12 }], byPagePrev: [] } };
  const ledger = { _about: "x", "https://luchit.app/model/*": { date: "2026-10-20", what: "breadcrumb" }, "https://luchit.app/old/": { date: "2026-08-01", what: "old" } };
  const f = facts(d, { ledger, answers: { since: "2026-11-01", pilot: ["octavia-676"], control: ["i30-253"] }, today: "2026-11-02" });
  ok(f.totals.this_week.clicks === 6 && f.totals.previous_week.clicks === 10 && f.totals.change_percent.clicks === -40, "week totals and change from the daily rows");
  ok(f.queries.down[0].key === "טסט לרכב" && f.queries.down.some(x => x.key === "אוקטביה") && f.queries.up.length === 0, "query movers, a vanished query counts as down");
  ok(f.pages.new_queries_or_pages === 1, "a page new this week is counted");
  ok(f.index_by_section.model.crawled_not_indexed === 1 && f.index_by_section.model.indexed === 1 && f.index_by_section.home.indexed === 1 && f.index_by_section.guide.error === 1, "coverage by section");
  ok(f.summary_test.pilot.crawled_not_indexed === 1 && f.summary_test.control.indexed === 1, "the pilot against its control group");
  ok(f.recent_changes.length === 1 && f.recent_changes[0].url === "/model/*" && f.recent_changes[0].locked_until === "2026-11-10", "the ledger: recent changes only, with the date they unlock");
  const good = { headline: "הקליקים ירדו ב-40 אחוזים, מ-10 ל-6.", what_changed: ["השאילתה טסט לרכב ירדה מ-7 ל-4 קליקים."], hypotheses: ["ייתכן שזו תנודה של Google."],
    actions: [{ action: "לבדוק את /model/octavia-676/", target: "/model/octavia-676/", why: "נסרק ולא נכלל", allowed_now: true }], watch: ["האינדוקס של עמודי הניסוי."] };
  ok(check(f, good) === "", "a draft with known numbers passes");
  ok(check(f, { ...good, headline: "הקליקים ירדו ב-45 אחוזים." }) === "unknown number 45", "an invented number is caught");
  ok(check(f, { ...good, hypotheses: ["הבעלים זכאי להחזר"] }) === "forbidden wording זכאי", "forbidden wording is caught");
  ok(check(f, { ...good, actions: [{ action: "לשנות כותרת", target: "/model/octavia-676/", why: "x", allowed_now: true }] }) === "an action breaks the 21-day rule", "a locked title change marked allowed is caught");
  ok(check(f, { ...good, actions: [{ action: "לשנות כותרת", target: "/model/octavia-676/", why: "x", allowed_now: false }] }) === "", "the same change marked not allowed passes");
  ok(check(f, null) === "not JSON", "no draft is caught");
  const r = request(f); ok(r.model === MODEL && r.output_config.effort === EFFORT && r.thinking.type === "adaptive" && !("temperature" in r), "the request: model, effort, adaptive thinking");
  const reply = o => ({ msg: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(o) }] } });
  let calls = [];
  const fake = replies => ({ messages: { create: async p => { calls.push(p); const x = replies.shift(); if (x.err) throw x.err; return x.msg; } } });
  calls = []; let w = await write(f, { api: fake([reply({ ...good, headline: "ירידה של 45 אחוזים" }), reply(good)]) });
  ok(w.check === "ok" && w.tries === 2 && /unknown number 45/.test(calls[1].messages[0].content), "a rejected draft is retried once with the reason");
  calls = []; w = await write(f, { api: fake([reply({ ...good, headline: "45" }), reply({ ...good, headline: "46" })]) });
  ok(w.check === "failed: unknown number 46" && w.draft.headline === "46", "a draft that fails twice is kept and marked");
  w = await write(f, { api: fake([{ err: Object.assign(new Error("x"), { status: 401 }) }]) });
  ok(w.draft === null && w.key === true, "a refused key: no draft, flagged as key trouble");
  ok((await write(f, { env: {} })).check === "no key", "no key: nothing written");
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const s = seal({ a: 1 }, publicKey.export({ type: "spki", format: "pem" }));
  const k = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(s.ek, "base64"));
  const dc = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(s.iv, "base64")); dc.setAuthTag(Buffer.from(s.tag, "base64"));
  ok(JSON.parse(Buffer.concat([dc.update(Buffer.from(s.data, "base64")), dc.final()])).a === 1, "the sealed output opens with the private key");
  console.log(`selftest ok (${n})`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "--selftest") await selftest();
  else {
    const d = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
    const read = p => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return {}; } };
    const f = facts(d, { ledger: read("analytics/seo-changes.json"), answers: { ...read(".github/model-answers.json"), ...read("model-answers.json") } });
    const w = await write(f);
    fs.mkdirSync("out-weekly", { recursive: true });
    fs.writeFileSync("out-weekly/seo-weekly.enc.json", JSON.stringify(seal({ facts: f, model: MODEL, ...w }, fs.readFileSync(".github/seo-data.pub.pem", "utf8"))));
    console.log("weekly draft:", w.check, w.tries ? `(${w.tries} ${w.tries === 1 ? "try" : "tries"})` : "");
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `ai=${w.key ? "key" : w.check === "ok" ? "ok" : "fail"}\n`);
  }
}
