// The weekly review of the class-action settlements list, done by a bot on the monthly API credit (data thread; Dudu 1.11.2026 21:16 UTC
// "נלך על 2 החבילות"). Until now a scheduled Claude Code task did it on the plan; this runs in the Sunday watch, right after Claude's reading
// of the news (settlements-ai.mjs), and edits settlements.json, which the workflow then checks, commits to main and merges into next
// (settlement data publishes without "שחרר", Dudu 19.10.2026).
//   1. By rule, no model: an entry whose `until` passed is removed, and `checked` becomes today.
//   2. Opus 5.5 (effort high, adaptive thinking) with the basic web search and fetch tools, on the same court, press and importer sites
//      as the reading, verifies every story the reading did not skip, every item held from earlier weeks, and every coverage issue that needs
//      judgement; in the first week of January, April, July and October it also reads the importers' settlement pages. It answers one
//      decision per item: add, update, remove, none, or person.
//   3. The machine check (the quote rule): add, update and remove stand only on quotes copied from a page fetched in this same conversation
//      (the page's text, or a passage the API itself cited, which covers PDFs); an entry must pass settlements.mjs validate (the app's own
//      stlCompile) and a coverage fix must clear its issue without making a new one. Text never says "זכאי". An entry only the press
//      supports gets low:true. Anything that fails, and every "person", is held: listed in review.json (carried to next week and checked
//      again) and raised as stl:review (day, quietly; the data thread handles it). A held item that later checks out leaves on its own.
//   Fallback: no key, no SDK, an API error or no valid answer leaves step 1 only, holds the items, and raises ai:stlrev (summary) or ai:key
//   (day, Dudu acts); a good call closes both. The workflow publishes only what passes settlements.mjs check and stl-parity.mjs, else the
//   list after step 1 alone (settlements.base.json). The log is public: no cost, no token count, no business number.
//   node settlements-review.mjs            env: OUT (watch-out: state.json, ai.json, inbox.md), LIST (default settlements.json), PREV_REVIEW, DRY=1
//   node settlements-review.mjs --selftest offline, through a fake API
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { client, ask, answer, keyTrouble } from "./claude.mjs";
import { DOMAINS, judged } from "./settlements-ai.mjs";

export const MODEL = "claude-opus-5-5";
export const SEARCH_CAP = 10, FETCH_CAP = 16, FETCH_CAP_DEEP = 28, ITEM_CAP = 14;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// the sources that are not the press: courts and notices, then the importers (DOMAINS from colmobil.co.il on)
export const PRIMARY = [...DOMAINS.slice(0, 5), ...DOMAINS.slice(DOMAINS.indexOf("colmobil.co.il"))];
// the importers' settlement pages, read in the first week of every quarter (the scheduled task's deep research since 10.2026)
export const DEEP_PAGES = ["https://www.delek-motors.co.il/", "https://www.colmobil.co.il/messages/", "https://www.kia-israel.co.il/", "https://www.toyota.co.il/owners/",
  "https://www.subaru.co.il/compromise-arrangements/", "https://www.suzuki.co.il/pshara/", "https://www.honda.co.il/", "https://www.volvocars.com/il/l/legal/settlement/",
  "https://www.landrover.co.il/", "https://www.championmotors.co.il/"];
const FIELDS = ["mk", "md", "not", "y", "m", "color", "fuel", "nofuel", "txt", "cc", "ccAny", "age", "made", "nocat", "t", "b", "cond", "st", "until", "url", "low"];
const UPDATE = ["st", "until", "y", "md", "not", "m", "b", "cond", "url", "t", "nocat"], COVER = ["md", "not", "m", "nocat"];
const host = u => { try { return new URL(u).host.replace(/^www\./, "").toLowerCase(); } catch { return ""; } };
const norm = u => { try { const x = new URL(u); return (x.host.replace(/^www\./, "") + decodeURI(x.pathname).replace(/\/+$/, "")).toLowerCase(); } catch { return ""; } };
const onSite = (u, list) => { const h = host(u); return !!h && list.some(d => h === d || h.endsWith("." + d)); };
// a quote is compared on letters and digits only, so spacing, punctuation and gershayim differences do not matter
export const squash = t => String(t || "").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const clean = (s, n) => String(s ?? "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, n);
// the list as the repository keeps it: one entry a line, so a week's diff shows only the entries that changed
export const fmt = j => { const { items, ...rest } = j; return JSON.stringify(rest).slice(0, -1) + ',"items":[\n' + items.map(e => JSON.stringify(e)).join(",\n") + "\n]}\n"; };
export const quarterly = today => [1, 4, 7, 10].includes(+today.slice(5, 7)) && +today.slice(8, 10) <= 7;

// what the conversation fetched: url -> squashed page text ("" for a PDF), and every passage the API cited
export function fetched(contents) {
  const pages = new Map(), cited = [];
  for (const content of contents) for (const b of content || []) {
    if (b && b.type === "web_fetch_tool_result" && b.content && b.content.type === "web_fetch_result") {
      const src = b.content.content && b.content.content.source;
      pages.set(norm(b.content.url), (pages.get(norm(b.content.url)) || "") + (src && src.type === "text" ? squash(src.data) : ""));
    }
    if (b && b.type === "text") for (const c of b.citations || []) if (c.cited_text) cited.push(squash(c.cited_text));
  }
  return { pages, cited };
}
// the notice images transcribed before the review (transcribeNotices) count as their pages' text
export const withNotices = (seen, notices) => { for (const [u, t] of notices || []) seen.pages.set(norm(u), (seen.pages.get(norm(u)) || "") + squash(t)); return seen; };
// the quote rule: at least one quote, each from a page fetched here, its words on that page (or in a passage the API cited from it)
export function quoted(quotes, seen) {
  const q = (Array.isArray(quotes) ? quotes : []).filter(x => x && typeof x.url === "string" && typeof x.text === "string").slice(0, 6);
  if (!q.length) return { ok: false, why: "no quote" };
  for (const x of q) {
    const page = seen.pages.get(norm(x.url)), t = squash(x.text);
    if (page === undefined) return { ok: false, why: `quote from a page not fetched here (${host(x.url) || "bad url"})` };
    if (t.length < 12) return { ok: false, why: "quote too short" };
    if (!page.includes(t) && !seen.cited.some(c => c.includes(t))) return { ok: false, why: `quote not on the page (${host(x.url)})` };
  }
  return { ok: true, primary: q.some(x => onSite(x.url, PRIMARY)), urls: q.map(x => x.url) };
}

export function prompt({ today, items, stories, issues, deep, models, notices }) {
  const L = [
    `Today is ${today}. You keep a list of Israeli class-action settlements that give car owners something (a free repair, a refund, a longer warranty). An app shows each entry to owners of matching cars, worded as "ייתכן" (may apply).`,
    "Verify every item below at a primary source: the court notice (yitzugit.co.il posts the published notices), the importer's settlement page, or two independent press reports. Search in Hebrew. Fetch each page you rely on: only what you fetched in this conversation counts.",
    "One decision per item (ref):",
    "- add: a court-approved settlement, a settlement filed and waiting for the court (st wait), a withdrawal settlement (הסדר הסתלקות) or a judgment with a benefit for car owners, not in the list. Give the whole entry.",
    "- update: an entry in the list changed (approved: st wait -> ok, a new deadline, other models or years, another benefit), or a coverage issue needs a tighter rule. Give its id and only the changed fields.",
    "- remove: an entry in the list was cancelled or ended. Give its id.",
    "- none: nothing for the list (a filing or a certified class action without a settlement, not about car owners, not in Israel, already listed and unchanged, old news). For a coverage issue: the rule is right as it is.",
    "- person: you could not verify it at a source, or a person must decide. Say what is missing.",
    "Quotes: for add, update and remove give 1 to 3 quotes, each copied word for word from a page you fetched here, with that page's url. They are checked by machine; a decision without them is held for a person.",
    "Never guess. Importers and dealers are never at fault in your words: describe neutrally. Never write \"זכאי\" or its forms; the app says \"ייתכן\".",
    "Entry fields (Hebrew where text): id = lower-case latin words joined by - (new, not in the list); mk = maker pattern as the Israeli register writes it (Hebrew, e.g. \"פיאט|FIAT\"); md = model pattern in capital latin letters and digits only, no spaces or dashes (e.g. \"CX5(?!0)\"); not = model codes to exclude; y = [from, to] model years; m = [{md, not, y}] when years differ by model; nocat = true for a model that is not a private car; t = short title (90 characters at most); b = the benefit; cond = who it covers and the last date to claim; st = ok or wait; until = YYYY-MM-DD, the last date to claim (about two years after approval if none is stated); url = https link to the importer's page or the court notice.",
    "The list now (JSON):", JSON.stringify(items),
  ];
  if (stories.length) L.push("Stories to verify (ref | first seen | title | link | the news reader's first reading, a lead and never proof):",
    ...stories.map(s => `${s.ref} | ${s.d} | ${s.t} | ${s.u} | ${s.lead}`));
  if (issues.length) L.push("Coverage issues (the list's rules against the model catalogue; fix with update on md, not, m or nocat only, no quotes needed; ref | issue | catalogue model names of that maker):",
    ...issues.map(i => `${i.ref} | ${i.issue} | ${(models[i.id] || []).join(", ")}`));
  for (const [u, t] of notices || []) L.push(`The notice image on ${u} reads (a machine transcription of the picture; quote it with that url, it counts as that page's text):`, t.slice(0, 12000));
  if (deep) L.push("This week also read the importers' settlement pages below (one decision per settlement you find there that is missing from the list or differs from it, ref \"deep\"):", ...DEEP_PAGES);
  L.push("Answer with JSON only, no other text:",
    '{"decisions":[{"ref":"s1","action":"add|update|remove|none|person","id":"","entry":{},"fields":{},"quotes":[{"url":"https://","text":"exact words from that page"}],"why":"one Hebrew sentence"}]}');
  return L.join("\n");
}
export function parse(text) {
  const t = String(text || ""), i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try { const o = JSON.parse(t.slice(i, j + 1)); return o && Array.isArray(o.decisions) ? o : null; } catch { return null; }
}
const pick = (o, keys) => Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([k]) => keys.includes(k)).map(([k, v]) => [k, typeof v === "string" ? clean(v, 500) : v]));
const noZakai = e => !["t", "b", "cond"].some(k => /זכאי/.test(String(e[k] || "")));

// applies the decisions one at a time on a copy of the list; each must pass its own checks and leave the whole list valid
export function apply(decisions, ctx) {
  const { list, refs, seen, validate, coverage, today } = ctx, items = list.items.map(e => ({ ...e })), done = [], held = [], dropped = [];
  const byId = id => items.findIndex(e => e.id === id);
  const hold = (d, why) => held.push({ ref: d.ref, why, ...(refs.get(d.ref) || {}) });
  const covIssues = its => { const c = coverage(its); return new Set([...c.none.map(id => "none " + id), ...c.longer, ...Object.keys(c.fresh).map(id => "fresh " + id)]); };
  const before = covIssues(items);
  const ok = its => validate({ updated: today, items: its }).length === 0;
  for (const d of decisions) {
    const r = refs.get(d.ref);
    if (!r && d.ref !== "deep") { dropped.push(d.ref); continue; }
    const act = ["add", "update", "remove", "none", "person"].includes(d.action) ? d.action : "person";
    if (act === "none") { done.push({ ref: d.ref, action: "none", why: clean(d.why, 200) }); continue; }
    if (act === "person") { hold(d, clean(d.why, 400) || "a person must decide"); continue; }
    const cov = r && r.kind === "issue";
    if (cov && act !== "update") { hold(d, "a coverage issue is fixed by update only"); continue; }
    const q = cov ? { ok: true, primary: true } : quoted(d.quotes, seen);
    if (!q.ok) { hold(d, q.why); continue; }
    const trial = items.map(e => ({ ...e }));
    let id = "";
    if (act === "add") {
      const e = { ...pick(d.entry, FIELDS), id: String(d.id || (d.entry && d.entry.id) || "") };
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id) || byId(e.id) >= 0) { hold(d, "the new entry needs a new id"); continue; }
      if (!q.primary) e.low = true;
      trial.push(e); id = e.id;
    } else {
      const i = trial.findIndex(e => e.id === d.id); id = String(d.id || "");
      if (i < 0) { hold(d, "no entry with that id"); continue; }
      if (cov && id !== r.id) { hold(d, "the fix is for another entry"); continue; }
      if (act === "remove") trial.splice(i, 1);
      else {
        const f = pick(d.fields, cov ? COVER : UPDATE);
        if (!Object.keys(f).length) { hold(d, "no field to change"); continue; }
        trial[i] = { ...trial[i], ...f };
        if (!q.primary && !cov) trial[i].low = true;
      }
    }
    const e = trial.find(x => x.id === id);
    if (e && !noZakai(e)) { hold(d, "the text says זכאי"); continue; }
    if (!ok(trial)) { hold(d, "the entry does not pass the list's check: " + validate({ updated: today, items: trial }).join("; ").slice(0, 200)); continue; }
    const after = covIssues(trial);
    if (cov && after.has(r.issue)) { hold(d, "the fix does not clear the issue"); continue; }
    // new model names on the entry this decision changes are what it means to do; a new "none" or "longer" anywhere is not
    if ([...after].some(x => !before.has(x) && x !== "fresh " + id)) { hold(d, "the change makes a new coverage issue: " + [...after].filter(x => !before.has(x)).join(", ").slice(0, 160)); continue; }
    items.splice(0, items.length, ...trial);
    done.push({ ref: d.ref, action: act, id, why: clean(d.why, 200), sources: q.urls || [] });
  }
  return { items, done, held, dropped };
}

// A court notice on yitzugit is often only a picture of the printed notice, which web_fetch cannot read (8.11.2026: Champion 13195-10-25 was held
// for a person). The runner downloads the post's notice images and the model transcribes each in a call of its own, at low effort. The
// transcription counts as that page's text for the quote rule, and the review reads it in its prompt
export const IMG_CAP = 2, IMG_STORIES = 4, IMG_BYTES = 5 * 2 ** 20;
export function noticeImages(html) {
  const seen = new Set(), out = [];
  for (const m of String(html || "").matchAll(/https?:\/\/(?:www\.)?yitzugit\.co\.il\/wp-content\/uploads\/[^"'\s)<>]+?\.(?:jpe?g|png|webp)/gi)) {
    const u = m[0].replace(/-\d{2,4}x\d{2,4}(?=\.\w+$)/, "");   // the full size, not a thumbnail
    if (/logo|icon|avatar|banner/i.test(u) || seen.has(u)) continue;
    seen.add(u); out.push(u);
  }
  return out.slice(0, IMG_CAP);
}
export async function transcribeNotices(api, stories, get = fetch) {
  const pages = new Map(); let calls = 0;
  for (const s of stories.filter(s => host(s.u) === "yitzugit.co.il").slice(0, IMG_STORIES)) {
    let html = ""; try { const r = await get(s.u); if (r.ok) html = await r.text(); } catch { /* no page, no images */ }
    const texts = [];
    for (const u of noticeImages(html)) {
      try {
        const r = await get(u); if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer()); if (!buf.length || buf.length > IMG_BYTES) continue;
        const media = /\.png$/i.test(u) ? "image/png" : /\.webp$/i.test(u) ? "image/webp" : "image/jpeg";
        calls++;
        const a = await ask(api, { model: MODEL, max_tokens: 4000, output_config: { effort: "low" }, messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: media, data: buf.toString("base64") } },
          { type: "text", text: "Transcribe the Hebrew text of this printed notice word for word, line by line, adding nothing. If it is not a text notice, answer NONE." }] }] });
        const t = a.error ? "" : String(answer(a.msg).text || "").trim();
        if (t && t !== "NONE") texts.push(t);
      } catch { /* one image less */ }
    }
    if (texts.length) pages.set(s.u, texts.join("\n"));
  }
  return { pages, calls };
}

async function tellRouter(router, level, key, text, link) { if (router) try { await router.alert(level, key, text, link || "", { today: "silent", legacy: () => false }); } catch { /* the log says it */ } }
async function closeKeys(router, keys) { if (router) for (const k of keys) try { await router.resolve([k]); } catch { /* the morning ledger shows it */ } }

export async function run({ env = process.env, api, router, log = console.log, today = env.TODAY || new Date().toISOString().slice(0, 10), validate, coverage } = {}) {
  const out = env.OUT || "out", listFile = env.LIST || path.join(ROOT, "settlements.json");
  const rd = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
  const list = rd(listFile), state = rd(path.join(out, "state.json")) || {}, ai = rd(path.join(out, "ai.json")), prev = rd(env.PREV_REVIEW || "");
  if (validate === undefined || coverage === undefined) {
    const s = await import("./settlements.mjs"), c = s.appCompile(), rows = JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8")).rows;
    validate ??= j => s.validate(j, c); coverage ??= its => s.coverage(its, rows, c, state.snap || {}, today);
    ctxModels = (ids, its) => Object.fromEntries(ids.map(id => { const e = its.find(x => x.id === id); const mk = e && c(e) && c(e).mk; return [id, mk ? [...new Set(rows.filter(r => mk.test(s.normS(r[0]))).map(r => r[1]))].slice(0, 120) : []]; }));
  }
  // 1. by rule
  const gone = list.items.filter(e => e.until < today).map(e => e.id);
  const base = { ...list, checked: today, items: list.items.filter(e => !(e.until < today)) };
  if (gone.length) base.updated = today;
  fs.writeFileSync(path.join(out, "settlements.base.json"), fmt(base));
  // 2. what needs verifying: the reading's non-skips, last week's held items, the coverage issues to judge
  const refs = new Map(), stories = [], issues = [];
  const lead = v => [v.kind, v.what, v.id, v.case, v.fields && JSON.stringify(v.fields), v.entry && JSON.stringify(v.entry), v.note, ...(v.sources || [])].filter(Boolean).join(" · ").slice(0, 700);
  const fresh = ((ai && ai.verdicts) || []).filter(v => v.kind !== "skip").map(v => ({ k: v.k, d: v.d, t: v.t, u: v.u, lead: lead(v) }));
  if (!ai || !ai.ok) for (const it of (state.inbox || []).filter(it => it.d > (state.checked || ""))) if (!fresh.some(s => s.k === it.k)) fresh.push({ k: it.k, d: it.d, t: it.t, u: it.u, lead: "not read" });
  const carried = ((prev && prev.held) || []).filter(h => h.kind === "story" && !fresh.some(s => s.k === h.k)).map(h => ({ k: h.k, d: h.d, t: h.t, u: h.u, lead: "held since " + (h.since || h.d) + ": " + h.why }));
  for (const s of [...fresh, ...carried].slice(0, ITEM_CAP)) { const ref = "s" + (stories.length + 1); stories.push({ ...s, ref }); refs.set(ref, { kind: "story", k: s.k, d: s.d, t: s.t, u: s.u, since: ((prev && prev.held) || []).find(h => h.k === s.k)?.since || today }); }
  for (const issue of judged(state.issues).slice(0, 8)) {
    const id = (issue.match(/^(?:none|longer|fresh|invalid)\s+([a-z0-9-]+)/) || [])[1] || ""; if (!id || !base.items.some(e => e.id === id)) continue;
    const ref = "c" + (issues.length + 1); issues.push({ ref, issue, id }); const kind = issue.split(" ")[0];   // the issue as covIssues in apply() names it
    refs.set(ref, { kind: "issue", issue: kind === "longer" ? issue.slice(7) : kind + " " + id, id, since: today });
  }
  const deep = quarterly(today);
  const rep = { v: 1, ran: today, model: "", ok: false, why: "", removed: gone, done: [], held: [], searches: 0, fetches: 0 };
  const finish = (items, extraHeld = []) => {
    rep.held = [...rep.held, ...extraHeld];
    const changed = JSON.stringify(items) !== JSON.stringify(base.items);
    const full = { ...base, items, ...(changed ? { updated: today } : {}) };
    fs.writeFileSync(listFile, fmt(full));
    fs.writeFileSync(path.join(out, "review.json"), JSON.stringify(rep, null, 1) + "\n");
    const he = { add: "נוסף", update: "עודכן", remove: "הוסר", none: "אין שינוי" };
    try { fs.appendFileSync(path.join(out, "inbox.md"), ["", `## הסקירה האוטומטית (${rep.ok ? MODEL : "בלי Claude: " + rep.why})`, ...gone.map(id => `- הוסר כי הסתיים: ${id}`),
      ...rep.done.map(d => `- ${d.ref}: ${he[d.action]}${d.id ? " " + d.id : ""}${d.why ? " · " + d.why : ""}${(d.sources || []).length ? " · " + d.sources.join(" ") : ""}`),
      ...rep.held.map(h => `- ממתין לבדיקה: ${h.t || h.issue || h.ref} · ${h.why}`), ""].join("\n")); } catch {}
    log(`settlements review: ${gone.length} ended removed, ${rep.done.filter(d => d.action !== "none").length} changes, ${rep.held.length} held${rep.ok ? "" : " (no model: " + rep.why + ")"}`);
    return rep;
  };
  const holdAll = why => [...refs.values()].map(r => ({ ...r, why }));
  const held = async () => {
    if (rep.held.length) {
      let t = { msg: o => o.title }; try { t = await import("./tg-text.mjs"); } catch {}
      await tellRouter(router, "day", "stl:review", t.msg({ kind: "today", area: "data", title: "פריטים בהסדרי הפשרה מחכים לבדיקה",
        text: `הסקירה השבועית לא הצליחה לאמת ${rep.held.length === 1 ? "פריט אחד" : rep.held.length + " פריטים"} במקור, ולכן לא שינתה אותם ברשימה.`,
        what: "כלום. זה עובר לבד לטיפול בשרשור \"נתונים ואמינות\", ועדכון יגיע כשזה מטופל.", raw: rep.held.map(h => `${h.t || h.issue}: ${h.why}`).join(" | ").slice(0, 500) }), env.RUN_URL);
    } else await closeKeys(router, ["stl:review"]);
  };
  // only the run on main tells the router: a test run from a branch publishes nothing, so its held items are not real (2.11.2026: a test run
  // from data/stl-review-test opened stl:review)
  if (router === undefined) router = env.GITHUB_REF && env.GITHUB_REF !== "refs/heads/main" ? null : await import("./alert.mjs").catch(() => null);
  // (before the quiet-week return too: a week with nothing to verify closes an open stl:review)
  if (!refs.size && !deep) { rep.ok = true; rep.why = "nothing to verify"; finish(base.items); await held(); return rep; }
  if (env.DRY === "1") { rep.why = "dry run"; return finish(base.items, holdAll("dry run")); }
  const fail = async (why, key) => {
    rep.why = why; finish(base.items, holdAll("not verified: " + why));
    if (/ANTHROPIC_API_KEY/.test(why)) return rep;
    let t = { tag: () => "", todo: () => "", folded: () => "" }; try { t = await import("./tg-text.mjs"); } catch {}
    if (key) await tellRouter(router, "day", "ai:key", [t.tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן הסקירה השבועית של הסדרי הפשרה רק הסירה הסדרים שהסתיימו.", t.todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט")].join("\n") + t.folded(why), env.RUN_URL);
    else await tellRouter(router, "summary", "ai:stlrev", [t.tag("info", "bots"), "הסקירה השבועית של הסדרי הפשרה לא הצליחה הפעם לאמת את הידיעות, ולכן רק הסירה הסדרים שהסתיימו. הפריטים יחכו לשבוע הבא.", t.todo()].join("\n") + t.folded(why), env.RUN_URL);
    await held(); return rep;
  };
  if (api === undefined) { const c = await client(env, { timeout: 10 * 60000 }); api = c.api; if (!api) return fail(c.why, false); }
  const models = typeof ctxModels === "function" ? ctxModels(issues.map(i => i.id), base.items) : {};
  const notices = stories.length ? (await transcribeNotices(api, stories, env.NOTICE_GET || fetch).catch(() => ({ pages: new Map() }))).pages : new Map();
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: SEARCH_CAP, allowed_domains: DOMAINS },
    { type: "web_fetch_20250910", name: "web_fetch", max_uses: deep ? FETCH_CAP_DEEP : FETCH_CAP, allowed_domains: DOMAINS, citations: { enabled: true }, max_content_tokens: 12000 }];
  const params = { model: MODEL, max_tokens: 16000, thinking: { type: "adaptive" }, output_config: { effort: "high" }, tools,
    messages: [{ role: "user", content: prompt({ today, items: base.items, stories, issues, deep, models, notices }) }] }, contents = [];
  let msg = null;
  for (let turn = 0; turn < 6; turn++) {   // a long server-tool turn stops at pause_turn: send it back as it is and the server goes on
    const r = await ask(api, params);
    if (r.error) return fail(r.error.why, r.error.key);
    msg = r.msg; contents.push(msg.content);
    if (msg.stop_reason !== "pause_turn") break;
    params.messages = [...params.messages, { role: "assistant", content: msg.content }];
  }
  const a = answer(msg), o = msg && msg.stop_reason !== "pause_turn" ? parse(a.text) : null;
  if (!o) return fail(a.why || (msg && msg.stop_reason === "pause_turn" ? "still searching after 6 turns" : "no valid JSON"), false);
  rep.model = MODEL; rep.ok = true;
  rep.searches = contents.flat().filter(b => b && b.type === "server_tool_use" && b.name === "web_search").length;
  rep.fetches = contents.flat().filter(b => b && b.type === "server_tool_use" && b.name === "web_fetch").length;
  const res = apply(o.decisions.filter(d => d && typeof d === "object").slice(0, 40), { list: base, refs, seen: withNotices(fetched(contents), notices), validate, coverage, today });
  const answered = new Set(o.decisions.map(d => d && d.ref));
  rep.done = res.done;
  rep.held = [...res.held, ...[...refs.entries()].filter(([ref]) => !answered.has(ref)).map(([ref, r]) => ({ ref, ...r, why: "no decision" }))];
  finish(res.items);
  await closeKeys(router, ["ai:stlrev", "ai:key"]); await held();
  return rep;
}
let ctxModels = null;

if (process.argv[1] && process.argv[1].endsWith("settlements-review.mjs")) {
  if (!process.argv.includes("--selftest")) await run();
  else {
    const os = await import("node:os");
    let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "stlrev-")), quiet = () => {}, today = "2026-11-08";
    const items = [{ id: "fiat-500e", mk: "פיאט|FIAT", md: "500", y: [2021, 2023], t: "טווח נסיעה", b: "הטבה", cond: "תנאים", st: "wait", until: "2027-12-31", url: "https://www.fiat.co.il/x" },
      { id: "kia-ceed", mk: "קיה", md: "CEED", y: [2013, 2018], t: "לוח מחוונים", b: "תיקון", cond: "תנאים", st: "ok", until: "2026-11-01", url: "https://kia-israel.co.il/x" },
      { id: "maz-cx5", mk: "מאזדה", md: "CX5", y: [2017, 2019], t: "מנוע", b: "תיקון", cond: "תנאים", st: "ok", until: "2028-01-01", url: "https://mazda.co.il/x" }];
    const validate = j => j.items.flatMap(e => [!/^[A-Z0-9|()?!]+$/.test(e.md || "") ? `${e.id}: md` : "", !/^\d{4}-\d\d-\d\d$/.test(e.until || "") ? `${e.id}: until` : "", !e.t ? `${e.id}: t` : ""].filter(Boolean));
    const coverage = its => ({ none: its.filter(e => e.md === "NOPE").map(e => e.id), longer: its.filter(e => e.md === "CX5").map(e => "maz-cx5: CX50"), fresh: {} });
    const noNet = async () => ({ ok: false });   // the selftest never goes to the network
    const dir = (n, { verdicts = [], issues = {}, inbox = [], aiOk = true } = {}) => { const d = path.join(tmp, String(n)); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "list.json"), JSON.stringify({ updated: "2026-11-01", checked: "2026-11-01", items }));
      fs.writeFileSync(path.join(d, "state.json"), JSON.stringify({ checked: "2026-11-01", inbox, issues })); fs.writeFileSync(path.join(d, "inbox.md"), "# inbox\n");
      fs.writeFileSync(path.join(d, "ai.json"), JSON.stringify({ ok: aiOk, verdicts })); return { OUT: d, LIST: path.join(d, "list.json"), NOTICE_GET: noNet }; };
    const page = (url, data) => ({ type: "web_fetch_tool_result", tool_use_id: "f", content: { type: "web_fetch_result", url, content: { type: "document", source: { type: "text", media_type: "text/plain", data } } } });
    const pdf = url => ({ type: "web_fetch_tool_result", tool_use_id: "f", content: { type: "web_fetch_result", url, content: { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBE" } } } });
    const json = o => ({ type: "text", text: JSON.stringify(o) });
    const fake = (replies, sent = []) => ({ messages: { create: async p => { sent.push(JSON.parse(JSON.stringify(p))); const r = replies.shift(); if (r instanceof Error) throw r; return r; } } });
    const calls = [], router = { alert: async (lv, key) => { calls.push(["alert", lv, key]); }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } };
    const V = (k, kind, extra = {}) => ({ k, d: "2026-11-08", t: "ידיעה " + k, u: "https://www.yitzugit.co.il/" + k, kind, read: true, sources: [], ...extra });
    const court = "https://www.yitzugit.co.il/2026/11/05/notice/", NOTICE = "בית המשפט המחוזי מרכז אישר ביום 29.8.2026 את הסדר הפשרה בעניין טווח הנסיעה של פיאט 500e. הודעה על הסדר פשרה בעניין חיישני חגורה ברכבי סקודה אוקטביה 2019-2021: החלפה ללא תשלום.";
    let sent = [];
    let r = await run({ env: dir(1, { verdicts: [V("a", "change", { id: "fiat-500e" }), V("b", "new"), V("c", "skip"), V("d", "unclear"), V("e", "new"), V("f", "ended", { id: "maz-cx5" })] }), router, log: quiet, today, validate, coverage,
      api: fake([{ stop_reason: "pause_turn", content: [page(court, NOTICE)] }, { stop_reason: "end_turn", content: [page("https://www.ynet.co.il/n", "כתבה: יבואן הסכים להחליף חיישנים ברכבי סקודה אוקטביה"), pdf("https://www.gov.il/n.pdf"),
        { type: "text", text: "", citations: [{ type: "page_location", cited_text: "הסדר פשרה בעניין המצבר של מאזדה CX5 בוטל בהסכמה" }] },
        json({ decisions: [
          { ref: "s1", action: "update", id: "fiat-500e", fields: { st: "ok", evil: 1 }, quotes: [{ url: court, text: "אישר ביום 29.8.2026 את הסדר הפשרה בעניין טווח הנסיעה" }], why: "אושר" },
          { ref: "s2", action: "add", id: "skoda-belt", entry: { mk: "סקודה", md: "OCTAVIA", y: [2019, 2021], t: "חיישני חגורה", b: "החלפה ללא תשלום", cond: "רכבי אוקטביה", st: "ok", until: "2028-11-01", url: court }, quotes: [{ url: "https://ynet.co.il/n/", text: "יבואן הסכים להחליף חיישנים ברכבי סקודה" }] },
          { ref: "s3", action: "add", id: "made-up", entry: { mk: "x", md: "Y", t: "t", until: "2028-01-01" }, quotes: [{ url: "https://www.ynet.co.il/other", text: "דבר שלא נקרא בכלל בשיחה הזאת" }] },
          { ref: "s4", action: "person", why: "לא נמצא מקור" },
          { ref: "s5", action: "remove", id: "maz-cx5", quotes: [{ url: "https://www.gov.il/n.pdf", text: "הסדר פשרה בעניין המצבר של מאזדה CX5 בוטל" }] },
          { ref: "x9", action: "add" }] })] }], sent) });
    const L = JSON.parse(fs.readFileSync(path.join(tmp, "1", "list.json"), "utf8")), get = id => L.items.find(e => e.id === id);
    ok(sent[0].model === "claude-opus-5-5" && sent[0].thinking.type === "adaptive" && sent[0].output_config.effort === "high" && sent[0].tools[0].type === "web_search_20250305" && sent[0].tools[1].type === "web_fetch_20250910" && sent[0].tools[1].citations.enabled, "Opus 5.5, high, adaptive thinking, the basic tools (raw page text comes back), citations on");
    ok(sent.length === 2 && sent[1].messages.at(-1).role === "assistant", "pause_turn goes back as it is");
    ok(!get("kia-ceed") && L.checked === today && L.updated === today && r.removed.join() === "kia-ceed", "an entry past its date is removed by rule; checked and updated are today");
    ok(get("fiat-500e").st === "ok" && !("evil" in get("fiat-500e")) && !get("fiat-500e").low, "an approval quoted from the court notice: updated, unknown field dropped, not low");
    ok(get("skoda-belt") && get("skoda-belt").low === true, "a new entry quoted from the press only: added with low");
    ok(!get("made-up") && r.held.some(h => h.ref === "s3" && /not fetched/.test(h.why)), "a quote from a page not fetched here: held");
    ok(!get("maz-cx5") && r.done.some(d => d.ref === "s5" && d.action === "remove"), "a quote from a PDF passes on the API's own citation");
    ok(r.held.some(h => h.ref === "s4" && h.kind === "story") && !r.done.some(d => d.ref === "x9") && !/ידיעה c/.test(sent[0].messages[0].content), "person is held; an unknown ref is dropped; a skipped story is not sent");
    ok(calls.some(c => c[2] === "stl:review" && c[1] === "day") && calls.some(c => c[1] === "ai:stlrev") && calls.some(c => c[1] === "ai:key"), "held items raise stl:review; a good call closes ai:stlrev and ai:key");
    const raw = fs.readFileSync(path.join(tmp, "1", "list.json"), "utf8");
    ok(raw.startsWith('{"updated":"2026-11-08","checked":"2026-11-08","items":[\n{"id":"fiat-500e"') && raw.endsWith("}\n]}\n") && raw.split("\n").length === L.items.length + 3, "the list keeps the repository's layout: one entry a line");
    ok(fmt(JSON.parse(fs.readFileSync(path.join(ROOT, "settlements.json"), "utf8"))) === fs.readFileSync(path.join(ROOT, "settlements.json"), "utf8"), "the layout is the repository's own (settlements.json round-trips)");
    ok(JSON.parse(fs.readFileSync(path.join(tmp, "1", "settlements.base.json"), "utf8")).items.length === 2 && /## הסקירה האוטומטית/.test(fs.readFileSync(path.join(tmp, "1", "inbox.md"), "utf8")), "the base list (rule only) and the inbox lines are written");
    const prev = path.join(tmp, "prev.json"); fs.copyFileSync(path.join(tmp, "1", "review.json"), prev);

    sent = []; calls.length = 0;
    r = await run({ env: { ...dir(2, { issues: { "longer maz-cx5: CX50": "2026-11-08", "retire kia-ceed": "2026-11-08" } }), PREV_REVIEW: prev }, router, log: quiet, today, validate, coverage,
      api: fake([{ stop_reason: "end_turn", content: [json({ decisions: [{ ref: "s1", action: "none" }, { ref: "s2", action: "none" }, { ref: "c1", action: "update", id: "maz-cx5", fields: { md: "CX5(?!0)", t: "evil" } }] })] }], sent) });
    const L2 = JSON.parse(fs.readFileSync(path.join(tmp, "2", "list.json"), "utf8"));
    ok(/held since/.test(sent[0].messages[0].content) && /c1 \| longer maz-cx5: CX50/.test(sent[0].messages[0].content), "last week's held items and the coverage issue are sent");
    ok(L2.items.find(e => e.id === "maz-cx5").md === "CX5(?!0)" && L2.items.find(e => e.id === "maz-cx5").t === "מנוע", "a coverage fix changes md only and clears the issue");
    ok(r.held.length === 0 && calls.some(c => c[0] === "resolve" && c[1] === "stl:review"), "held items that check out leave; nothing held closes stl:review");

    r = await run({ env: dir(3, { issues: { "longer maz-cx5: CX50": "2026-11-08" } }), router, log: quiet, today, validate, coverage,
      api: fake([{ stop_reason: "end_turn", content: [json({ decisions: [{ ref: "c1", action: "update", id: "maz-cx5", fields: { md: "NOPE" } }] })] }]) });
    ok(r.held.some(h => /new coverage issue|does not clear/.test(h.why)) && JSON.parse(fs.readFileSync(path.join(tmp, "3", "list.json"), "utf8")).items.find(e => e.id === "maz-cx5").md === "CX5", "a fix that makes a new issue is held");
    r = await run({ env: dir(4, { verdicts: [V("a", "new")] }), router, log: quiet, today, validate, coverage,
      api: fake([{ stop_reason: "end_turn", content: [page(court, NOTICE + " כל בעלי הרכב זכאים להחלפה"), json({ decisions: [{ ref: "s1", action: "add", id: "skoda-x", entry: { mk: "סקודה", md: "OCTAVIA", t: "x", b: "בעלי הרכב זכאים להחלפה", cond: "c", st: "ok", until: "2028-01-01", url: court }, quotes: [{ url: court, text: "כל בעלי הרכב זכאים להחלפה" }] }] })] }]) });
    ok(r.held.some(h => /זכאי/.test(h.why)), "a text that says זכאי is held");
    calls.length = 0;
    r = await run({ env: dir(5, { verdicts: [V("a", "new")] }), router, log: quiet, today, validate, coverage, api: fake([Object.assign(new Error("x"), { status: 400, error: { error: { type: "invalid_request_error", message: "Your credit balance is too low" } } })]) });
    ok(!r.ok && r.held.length === 1 && calls.some(c => c[2] === "ai:key" && c[1] === "day") && JSON.parse(fs.readFileSync(path.join(tmp, "5", "list.json"), "utf8")).items.length === 2, "the credit ran out: rule only, held, ai:key");
    calls.length = 0;
    r = await run({ env: dir(6, { verdicts: [V("a", "new")] }), router, log: quiet, today, validate, coverage, api: fake([{ stop_reason: "end_turn", content: [{ type: "text", text: "sorry" }] }]) });
    ok(!r.ok && r.why === "no valid JSON" && calls.some(c => c[2] === "ai:stlrev" && c[1] === "summary") && calls.some(c => c[2] === "stl:review"), "no valid answer: ai:stlrev quietly, the item held");
    r = await run({ env: { ...dir(7, { verdicts: [V("a", "new")] }), ANTHROPIC_API_KEY: "" }, router, log: quiet, today, validate, coverage });
    ok(!r.ok && /ANTHROPIC_API_KEY/.test(r.why), "no key: rule only");
    sent = [];
    r = await run({ env: dir(8, { verdicts: [V("c", "skip")] }), router, log: quiet, today, validate, coverage, api: fake([], sent) });
    ok(r.ok && sent.length === 0 && r.why === "nothing to verify", "nothing to verify: no call");
    sent = [];
    r = await run({ env: dir(9), router, log: quiet, today: "2027-01-03", validate, coverage, api: fake([{ stop_reason: "end_turn", content: [json({ decisions: [] })] }], sent) });
    ok(sent.length === 1 && /importers' settlement pages/.test(sent[0].messages[0].content) && sent[0].tools[1].max_uses === FETCH_CAP_DEEP && quarterly("2026-10-05") && !quarterly("2026-11-02"), "the first week of a quarter reads the importers' pages");
    r = await run({ env: { ...dir(10, { verdicts: [], inbox: [{ k: "z", d: "2026-11-08", t: "לא נקרא", u: "https://ynet.co.il/z" }], aiOk: false }), DRY: "1" }, router, log: quiet, today, validate, coverage });
    ok(r.held.length === 1 && r.held[0].k === "z", "a reading that failed: the open stories are verified (dry run: held)");
    const lines = []; await run({ env: dir(11, { verdicts: [V("c", "skip")] }), router, log: m => lines.push(m), today, validate, coverage, api: fake([]) });
    ok(lines.length === 1 && !/\$|token|usd|cost/i.test(lines[0]), "one log line, no cost or token count");
    { const html = '<img src="https://yitzugit.co.il/wp-content/uploads/2026/11/notice-1024x768.jpg"><img src="https://yitzugit.co.il/wp-content/uploads/logo.png"><a href="https://yitzugit.co.il/wp-content/uploads/2026/11/notice.jpg">';
      ok(JSON.stringify(noticeImages(html)) === JSON.stringify(["https://yitzugit.co.il/wp-content/uploads/2026/11/notice.jpg"]), "a notice post's image: the full size once, no logo");
      const sentImg = [], img = { messages: { create: async p => { sentImg.push(p); return { stop_reason: "end_turn", content: [{ type: "text", text: "הודעה בדבר הגשת בקשה לאישור הסדר פשרה" }] }; } } };
      const get = async u => /notice\/$/.test(u) ? { ok: true, text: async () => html } : /\.jpg$/.test(u) ? { ok: true, arrayBuffer: async () => new Uint8Array([255, 216, 255]).buffer } : { ok: false };
      const t = await transcribeNotices(img, [{ u: "https://yitzugit.co.il/2026/11/04/notice/" }, { u: "https://www.ynet.co.il/a" }], get);
      const seen = withNotices({ pages: new Map(), cited: [] }, t.pages);
      ok(t.calls === 1 && sentImg[0].messages[0].content[0].type === "image" && sentImg[0].messages[0].content[0].source.media_type === "image/jpeg" && quoted([{ url: "https://yitzugit.co.il/2026/11/04/notice/", text: "בקשה לאישור הסדר פשרה" }], seen).ok
        && /machine transcription/.test(prompt({ today, items: [], stories: [], issues: [], deep: false, models: {}, notices: t.pages })), "a notice image is transcribed once, counts for the quote rule and is in the prompt"); }
    ok(PRIMARY.includes("yitzugit.co.il") && PRIMARY.includes("kia-israel.co.il") && !PRIMARY.includes("ynet.co.il"), "court and importer sites are primary, the press is not");
    console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
  }
}
