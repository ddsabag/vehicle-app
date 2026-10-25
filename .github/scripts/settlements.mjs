// Class-action settlements (הסדרי פשרה): the checks behind settlements.json, the list the app reads from the site (and from its bundled copy).
// The list is kept current without app releases: this script checks every change, a weekly run collects news, and Claude's weekly review
// (a scheduled task) reads the run's inbox, verifies each candidate against the importer or the court, and edits settlements.json.
//   node settlements.mjs check [file]    1. the file itself: every entry well formed and compiled by the app's own stlCompile (index.html); exit 1 if not
//                                        2. coverage against the model catalogue (models.json): a rule that matches no model, a rule that now also takes
//                                           a longer model code (CX5 in CX50), model names a rule took on since the last weekly run, entries past `until`
//   node settlements.mjs watch           the weekly run: check, then the free news sources, into out/state.json (inbox + what was seen) and out/inbox.md;
//                                        PREV_STATE = last week's state.json, NEXT_FILE = settlements.json on next (its `checked` date counts too)
//   node settlements.mjs tell <old> <new>   one Telegram line (alert router, day) naming what a push to main added, changed or removed
//   node settlements.mjs selftest        offline
// Entry fields (index.html stlCompile has the matching): id, mk, md, not, y, m [{md, not, y}], color, fuel, nofuel, txt, cc, ccAny, age, made (the
// maker's name with its country as the register writes it, e.g. קיה סלובקיה), nocat (a model the private-car catalogue does not hold, e.g. a pickup:
// no coverage warning), t, b, cond, st (ok | wait = waits for court approval), until, url, low (from the press only: the card adds "ההתאמה לרכב הזה
// פחות ודאית", so cond does not say it). The file's `checked` is the date of the last weekly review, even one that changed nothing.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {msg} from "./tg-text.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = process.env.OUT || "out";
const num = x => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
export const normS = t => String(t || "").toUpperCase().replace(/[^A-Z0-9א-ת]/g, "");
const DATE = /^\d{4}-\d\d-\d\d$/;
const realDate = s => DATE.test(s || "") && new Date(s + "T00:00:00Z").toISOString().slice(0, 10) === s;
const today = () => process.env.TODAY || new Date().toISOString().slice(0, 10);
const days = (a, b) => Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);

export function appCompile(html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8")){
  const m = html.match(/\/\* stl-compile \*\/([\s\S]*?)\/\* \/stl-compile \*\//);
  if (!m) throw new Error("index.html has no stl-compile block");
  return new Function("num", m[1] + "\nreturn stlCompile;")(num);
}

// ---- 1. the file ----
const KEYS = new Set(["id", "mk", "md", "not", "y", "m", "color", "fuel", "nofuel", "txt", "cc", "ccAny", "age", "made", "nocat", "t", "b", "cond", "st", "until", "url", "low"]);
const PAT = ["mk", "md", "not", "color", "fuel", "nofuel", "txt", "made"];
const yOk = y => Array.isArray(y) && y.length === 2 && y.every(Number.isInteger) && y[0] >= 1990 && y[0] <= y[1] && y[1] <= 2040;
// mk and md are tested on normS names (capitals, digits and Hebrew letters only): a lower-case letter, a space or a dash outside the pattern syntax never matches
const deadChars = p => /[a-z \-]/.test(String(p).replace(/\\[a-zA-Z]|\(\?<?[=!]|\[[^\]]*\]/g, ""));
export function validate(j, stlCompile){
  const bad = [], add = (id, why) => bad.push(`${id}: ${why}`);
  if (!j || typeof j !== "object") return ["the file is not a JSON object"];
  if (!realDate(j.updated)) add("file", "updated is not a YYYY-MM-DD date");
  if (j.checked !== undefined && !realDate(j.checked)) add("file", "checked is not a YYYY-MM-DD date");
  if (!Array.isArray(j.items) || !j.items.length) return [...bad, "file: items is empty"];
  const ids = new Set();
  for (const [i, e] of j.items.entries()) {
    const id = e && typeof e.id === "string" ? e.id : `#${i}`;
    if (!e || typeof e !== "object") { add(id, "not an object"); continue; }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.id || "")) add(id, "id must be lower-case words joined by -");
    if (ids.has(e.id)) add(id, "id used twice"); ids.add(e.id);
    for (const k of Object.keys(e)) if (!KEYS.has(k)) add(id, `unknown field ${k}`);
    for (const k of PAT) if (e[k] !== undefined) {
      if (typeof e[k] !== "string" || !e[k]) { add(id, `${k} must be a non-empty pattern`); continue; }
      try { new RegExp(e[k]); } catch (x) { add(id, `${k} is not a valid pattern (${x.message})`); continue; }
      if ((k === "mk" || k === "md" || k === "not") && deadChars(e[k])) add(id, `${k} has a lower-case letter, space or dash, which normalised names never have`);
    }
    if (!e.mk) add(id, "mk (maker) is missing");
    if (e.y !== undefined && !yOk(e.y)) add(id, "y must be [from, to] years");
    if (e.m !== undefined) {
      if (!Array.isArray(e.m) || !e.m.length) add(id, "m must be a non-empty list");
      else e.m.forEach((a, k) => {
        if (!a || typeof a !== "object" || (!a.md && !a.not)) return add(id, `m[${k}] needs md or not`);
        for (const f of Object.keys(a)) if (!["md", "not", "y"].includes(f)) add(id, `m[${k}] unknown field ${f}`);
        for (const f of ["md", "not"]) if (a[f] !== undefined) { try { new RegExp(a[f]); if (deadChars(a[f])) add(id, `m[${k}].${f} has a lower-case letter, space or dash`); } catch (x) { add(id, `m[${k}].${f} is not a valid pattern`); } }
        if (a.y !== undefined && !yOk(a.y)) add(id, `m[${k}].y must be [from, to] years`);
      });
    }
    if (e.cc !== undefined && !(Array.isArray(e.cc) && e.cc.length === 2 && e.cc.every(x => typeof x === "number" && x >= 0) && e.cc[0] <= e.cc[1])) add(id, "cc must be [min, max] engine sizes");
    if (e.age !== undefined && !(Number.isInteger(e.age) && e.age >= 1 && e.age <= 40)) add(id, "age must be whole years, 1 to 40");
    for (const k of ["ccAny", "low", "nocat"]) if (e[k] !== undefined && typeof e[k] !== "boolean") add(id, `${k} must be true or false`);
    for (const k of ["t", "b", "cond"]) {
      if (typeof e[k] !== "string" || e[k].trim().length < 3) add(id, `${k} (text) is missing`);
      else if (/[<>]/.test(e[k])) add(id, `${k} has < or >`);
    }
    if (typeof e.t === "string" && e.t.length > 90) add(id, "t is longer than 90 characters");
    if (e.low && /פחות ודאית/.test(e.cond || "")) add(id, "cond says the match is less certain, which low already adds");
    if (!["ok", "wait"].includes(e.st)) add(id, "st must be ok or wait");
    if (!realDate(e.until)) add(id, "until is not a YYYY-MM-DD date");
    if (typeof e.url !== "string" || !/^https:\/\/[^\s"<>]+$/.test(e.url)) add(id, "url must be an https link");
    if (stlCompile && !stlCompile(e)) add(id, "the app's stlCompile rejects it");
  }
  return bad;
}

// ---- 2. coverage against the catalogue (models.json rows: [maker, model, from year, to year, ...]) ----
const tokens = p => String(p || "").split("|").map(t => t.replace(/\(\?<?[=!][^)]*\)|\\[a-zA-Z]|[\^$()[\]?*+.]/g, "")).filter(t => t.length >= 2);
export function coverage(items, rows, stlCompile, prevSnap = {}, on = today()){
  const r = {none: [], longer: [], fresh: {}, retire: [], soon: [], snap: {}};
  for (const e of items) {
    if (e.until < on) { r.retire.push(e.id); continue; }
    if (days(on, e.until) <= 14) r.soon.push(e.id);
    if (e.nocat) continue;
    const s = stlCompile(e); if (!s) continue;
    const alts = e.m && e.m.length ? e.m : [{}], over = (y, a, b) => !y || a <= y[1] && b >= y[0], aged = e.age ? [+on.slice(0, 4) - e.age, 2100] : null;
    const names = new Set();
    for (const [mk0, md0, y0, y1] of rows) {
      const mk = normS(mk0), md = normS(md0);
      if (!s.mk.test(mk) || s.md && !s.md.test(md) || e.not && new RegExp(e.not).test(md) || !over(e.y, y0, y1) || !over(aged, y0, y1)) continue;   // made is not tested: the catalogue's maker names drop the country
      if (!alts.some(a => (!a.md || new RegExp(a.md).test(md)) && (!a.not || !new RegExp(a.not).test(md)) && over(a.y, y0, y1))) continue;
      names.add(md0);
    }
    const list = [...names].sort();
    r.snap[e.id] = list;
    if (!list.length) { r.none.push(e.id); continue; }
    const toks = [...tokens(e.md), ...alts.flatMap(a => tokens(a.md))];
    // a code that ends in a digit and is followed by another digit of the same word: CX5 in CX-50, מאזדה3 in "מאזדה 323" (not X5 in "X5 3.0D")
    for (const n of list) {
      let t = "", w = []; String(n).toUpperCase().split(/\s+/).forEach((word, i) => { const c = normS(word); t += c; w.push(...Array(c.length).fill(i)); });
      if (toks.some(tk => { const at = t.indexOf(tk), end = at + tk.length; return at >= 0 && /\d$/.test(tk) && /\d/.test(t[end] || "") && w[end] === w[end - 1]; })) r.longer.push(`${e.id}: ${n}`);
    }
    if (prevSnap[e.id]) { const was = new Set(prevSnap[e.id]), add = list.filter(n => !was.has(n)); if (add.length) r.fresh[e.id] = add; }
  }
  return r;
}

// ---- 3. the news sources (free, answer from a GitHub runner: checked 19.10.2026) ----
const q = s => encodeURIComponent(s);
export const SOURCES = [
  {s: "TheCar", u: "https://www.thecar.co.il/feed/"},
  {s: "TheCar תקלות סדרתיות", u: "https://www.thecar.co.il/category/%d7%aa%d7%a7%d7%9c%d7%95%d7%aa-%d7%a1%d7%93%d7%a8%d7%aa%d7%99%d7%95%d7%aa/feed/"},
  {s: "Google News", u: `https://news.google.com/rss/search?q=${q('"הסדר פשרה" רכב')}&hl=he&gl=IL&ceid=IL:he`},
  {s: "Google News", u: `https://news.google.com/rss/search?q=${q("ייצוגית יבואן רכב")}&hl=he&gl=IL&ceid=IL:he`},
  {s: "Google News", u: `https://news.google.com/rss/search?q=${q('"הסכם פשרה" רכב')}&hl=he&gl=IL&ceid=IL:he`},
  {s: "ייצוגית", u: "https://www.yitzugit.co.il/wp-json/wp/v2/posts?per_page=100&_fields=date,link,title", json: true},
];
const SETTLE = /הסדר(?:י)? ?פשרה|הסכם(?:י)? ?פשרה|הסדר הסתלקות|ייצוגית|תובענה|פסק[ -]דין|יפצו|יפצה|פיצוי|החזר כספי|הארכת אחריות/;
// short names only as a word of their own (one prefix letter allowed): צ'רי is not in צפריר, קיה not in טורקיה
const CAR = new RegExp(["רכב", "יבואן", "מכונית", "מוסך", "ריקול", "מוטורס", "כלמוביל", "סמלת", "מכשירי תנועה", "לובינסקי", "קרסו", "יוניון", "צ['׳]?מפיון", "יפנאוטו",
  "טויוטה", "לקסוס", "יונדאי", "מאזדה", "מזדה", "סובארו", "סוזוקי", "הונדה", "ניסאן", "פיג['׳]?ו", "סיטרואן", "שברולט", "פורד", "ב\\.?מ\\.?וו", "מרצדס", "פולקסווגן",
  "סקודה", "אאודי", "קופרה", "וולוו", "מיצובישי", "טסלה", "אומודה", "דאצ['׳]?יה", "פיאט", "פורשה", "לנד רובר", "ג['׳]?יגואר", "\\bBMW\\b", "\\bBYD\\b", "\\bMG\\b",
  "(?<![א-ת])[בוהלמש]?(?:קיה|רנו|אופל|סיאט|צ['׳]רי|ג['׳]יפ|ג['׳]ילי)(?![א-ת])"].join("|"), "i");
const NOT_CAR = /ביטוח רכב|פוליס/;   // motor insurance settlements are not about the car
const ent = s => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ").replace(/&#0?34;|&quot;/g, '"').replace(/&#8211;|&#8212;/g, "-").replace(/&#124;/g, "|").replace(/&#0?39;|&#8217;|&#8216;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/\s+/g, " ").trim();
const tag = (x, t) => { const m = x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return m ? ent(m[1]) : ""; };
export function parseFeed(src, text){
  if (src.json) {
    let a = []; try { a = JSON.parse(text); } catch { return []; }
    return (Array.isArray(a) ? a : []).map(p => ({s: src.s, t: ent(p.title && p.title.rendered || ""), u: p.link, p: String(p.date || "").slice(0, 10), x: ""}));
  }
  return [...text.matchAll(/<item[\s>]([\s\S]*?)<\/item>/g)].map(([, it]) => {
    const t = tag(it, "title"), pub = tag(it, "pubDate"), d = pub ? new Date(pub) : null, so = it.match(/<source url="[^"]*">([^<]+)<\/source>/);
    return {s: so ? `${src.s}: ${ent(so[1])}` : src.s, t: so ? t.replace(/\s+-\s+[^-]+$/, "") : t, u: tag(it, "link"), p: d && !isNaN(d) ? d.toISOString().slice(0, 10) : "", x: tag(it, "description").slice(0, 400)};
  });
}
export const relevant = it => { const s = `${it.t} ${it.x}`; return SETTLE.test(s) && CAR.test(s) && !NOT_CAR.test(it.t); };
const keyOf = it => normS(it.t).slice(0, 60);
async function fetchText(u){
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(u, {headers: {"user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36", "accept-language": "he-IL,he;q=0.9"}, signal: AbortSignal.timeout(30000)});
      if (r.ok) return await r.text();
    } catch {}
  }
  return null;
}

// ---- the weekly run ----
async function watch(){
  const stlCompile = appCompile(), on = today();
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "settlements.json"), "utf8"));
  const prev = process.env.PREV_STATE && fs.existsSync(process.env.PREV_STATE) ? JSON.parse(fs.readFileSync(process.env.PREV_STATE, "utf8")) : {seen: {}, inbox: [], snap: {}, issues: {}};
  let nextChecked = "";
  try { if (process.env.NEXT_FILE && fs.existsSync(process.env.NEXT_FILE)) nextChecked = JSON.parse(fs.readFileSync(process.env.NEXT_FILE, "utf8")).checked || ""; } catch {}
  const checked = [j.checked || j.updated || "", nextChecked].sort().pop();
  const bad = validate(j, stlCompile);
  const rows = JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8")).rows;
  const cov = coverage(j.items, rows, stlCompile, prev.snap || {}, on);
  // news: new items only (seen by title, so the same story from two feeds counts once), kept 120 days; the inbox keeps 60 days
  // the very first run only takes the last 30 days into the inbox: older stories were covered by the research of 10.2026
  const seen = {...(prev.seen || {})}, fresh = [], down = [], first = !prev.ran;
  for (const [i, src] of SOURCES.entries()) {
    const text = await fetchText(src.u);
    if (text == null) { down.push(`${src.s} (${i + 1})`); continue; }
    for (const it of parseFeed(src, text)) {
      if (!it.t || !it.u || !relevant(it)) continue;
      const k = keyOf(it); if (seen[k]) continue;
      seen[k] = on; if (!(first && it.p && days(it.p, on) > 30)) fresh.push({...it, k, d: on});
    }
  }
  for (const [k, d] of Object.entries(seen)) if (days(d, on) > 120) delete seen[k];
  const inbox = [...(prev.inbox || []), ...fresh].filter(it => days(it.d, on) <= 60);
  // an issue is dated from the first run that saw it: the review fixes it within a week, so one older than 15 days means the review is not happening
  const issues = {}, now = [...bad.map(b => "invalid " + b), ...cov.none.map(id => "none " + id), ...cov.longer.map(x => "longer " + x), ...Object.entries(cov.fresh).map(([id, n]) => `fresh ${id}: ${n.join(", ")}`), ...cov.retire.map(id => "retire " + id), ...down.map(s => "source down: " + s)];
  for (const i of now) issues[i] = (prev.issues || {})[i] || on;
  const open = inbox.filter(it => it.d > checked);
  const stuck = [...open.filter(it => days(it.d, on) > 15).map(it => "news " + it.t), ...Object.entries(issues).filter(([, d]) => days(d, on) > 15).map(([i]) => i)];
  // the snapshot moves on only once the review saw it (checked after the last run), so a name a rule took on stays listed until then
  const snap = checked >= (prev.ran || "") ? cov.snap : {...cov.snap, ...prev.snap};
  const state = {v: 1, ran: on, checked, seen, inbox, snap, issues};
  fs.mkdirSync(OUT, {recursive: true});
  fs.writeFileSync(`${OUT}/state.json`, JSON.stringify(state));
  const md = [`# הסדרי פשרה: ריצה שבועית ${on}`, "", `נבדק לאחרונה (checked): ${checked || "אף פעם"}. ${j.items.length} הסדרים בקובץ.`, "",
    "## כתבות חדשות לבדיקה (מאז הבדיקה האחרונה)", ...(open.length ? open.map(it => `- ${it.d} · ${it.s} · ${it.t} · ${it.u}`) : ["- אין"]), "",
    "## בעיות בקובץ ובהתאמות", ...(now.length ? now.map(i => `- ${i} (מאז ${issues[i]})`) : ["- אין"]), "",
    ...(cov.soon.length ? ["## מסתיימים בשבועיים הקרובים", ...cov.soon.map(id => "- " + id), ""] : []),
    ...(down.length ? ["## מקורות שלא ענו", ...down.map(s => "- " + s), ""] : [])];
  fs.writeFileSync(`${OUT}/inbox.md`, md.join("\n") + "\n");
  console.log(md.join("\n"));
  if (stuck.length) await tell1("day", `stl:stuck:${on}`, msg({kind: "today", area: "data", title: "פריטים בהסדרי הפשרה מחכים יותר משבועיים",
    text: `הבדיקה השבועית של הסדרי הפשרה לא טיפלה בהם:\n${stuck.slice(0, 6).map(x => "• " + esc(issueHe(x).slice(0, 140))).join("\n")}${stuck.length > 6 ? `\nועוד ${stuck.length - 6}.` : ""}`,
    what: "לכתוב לי בשרשור \"נתונים ואמינות\" לעבור על הרשימה."}), process.env.RUN_URL || "");
  return bad.length ? 1 : 0;
}

// ---- Telegram ----
const esc = t => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// an issue key of state.json ("none honda-oil", "news <title>") in words for the message; the keys themselves stay as they are (state is matched on them)
const ISSUE_HE = {news: "כתבה חדשה לבדיקה", invalid: "רשומה לא תקינה בקובץ", none: "כלל שלא מתאים לאף דגם", longer: "כלל שתופס גם קוד דגם ארוך יותר", fresh: "דגמים חדשים שנכנסו לכלל", retire: "הסדר שהסתיים וצריך להסיר", "source down:": "מקור חדשות שלא ענה"};
export const issueHe = x => { const m = String(x).match(/^(source down:|\w+)\s+(.*)$/s); return m && ISSUE_HE[m[1]] ? `${ISSUE_HE[m[1]]}: ${m[2]}` : String(x); };
async function telegram(text, silent = false){
  const e = process.env;
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_CHAT_ID) { console.log("no Telegram credentials"); return false; }
  try {
    const r = await fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({chat_id: e.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, ...(silent ? {disable_notification: true} : {})}), signal: AbortSignal.timeout(20000)});
    console.log("telegram " + r.status); return r.ok;
  } catch (x) { console.log("telegram failed " + x.message); return false; }
}
// HTML text (tg-text.mjs); quiet = an update for information only: the router's "summary" level, sent without a ring
async function tell1(level, key, text, link, quiet = false){
  if (!process.env.TELEGRAM_BOT_TOKEN) { console.log("no Telegram credentials:\n" + text); return; }
  let router = null; try { router = await import("./alert.mjs"); } catch {}
  if (router) await router.alert(level, key, text, link || "", {today: quiet ? "silent" : "loud", legacy: () => telegram(text, quiet)});
  else await telegram(text, quiet);
}
const maker = e => [...new Set(String(e.mk).split("|").map(t => t.replace(/\(\?<?[=!][^)]*\)|[\\^$()[\]?*+.]/g, "")).filter(t => /^[א-ת]{2,}$/.test(t)))].slice(0, 2).join(", ") || String(e.mk).split("|")[0];
export function describe(oldJ, newJ){
  const o = new Map((oldJ && oldJ.items || []).map(e => [e.id, e])), n = new Map((newJ.items || []).map(e => [e.id, e]));
  const line = e => `${e.t} (${maker(e)}${e.st === "wait" ? ", מחכה לאישור בית המשפט" : ""})`;
  const added = [...n.values()].filter(e => !o.has(e.id)), gone = [...o.values()].filter(e => !n.has(e.id));
  const changed = [...n.values()].filter(e => o.has(e.id) && JSON.stringify(o.get(e.id)) !== JSON.stringify(e));
  if (!added.length && !gone.length && !changed.length) return "";
  return msg({kind: "done", area: "data", title: "הסדרי הפשרה עודכנו באפליקציה ובאתר", text: [
    ...added.map(e => "נוסף: " + esc(line(e))), ...changed.map(e => "עודכן: " + esc(line(e)) + (o.get(e.id).st === "wait" && e.st === "ok" ? " · אושר בבית המשפט" : "")), ...gone.map(e => "הוסר: " + esc(line(e))),
    `סך הכול ${n.size} הסדרים.`].join("\n"), what: ""});
}

// ---- selftest (offline) ----
function selftest(){
  let fails = 0; const ok = (c, m) => { if (!c) { fails++; console.log("FAIL " + m); } };
  const stlCompile = appCompile();
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "settlements.json"), "utf8"));
  ok(validate(j, stlCompile).length === 0, "settlements.json valid: " + validate(j, stlCompile).join("; "));
  const base = {id: "x-a", mk: "יונדאי", md: "I30", t: "כותרת", b: "הטבה כלשהי", cond: "תנאים כלשהם", st: "ok", until: "2027-01-31", url: "https://a.example/"};
  const v = e => validate({updated: "2026-10-19", items: [{...base, ...e}]}, stlCompile);
  ok(v({}).length === 0, "a plain entry passes");
  ok(v({md: "i30"}).length === 1, "lower-case model pattern is caught");
  ok(v({md: "CX-5"}).length === 1, "dash in a model pattern is caught");
  ok(v({md: "CX5(?!0)"}).length === 0, "lookahead is fine");
  ok(v({mk: "(?<![א-ת])איון"}).length === 0, "lookbehind is fine");
  ok(v({md: "I30("}).length >= 1, "broken pattern is caught");
  ok(v({until: "2027-02-30"}).length === 1, "impossible date is caught");
  ok(v({y: [2019, 2010]}).length === 1, "reversed years are caught");
  ok(v({url: "http://a.example/"}).length === 1, "http link is caught");
  ok(v({t: "<b>x</b>"}).length === 1, "markup in text is caught");
  ok(v({colour: "לבן"}).length === 1, "unknown field is caught");
  ok(v({st: "approved"}).length === 1, "unknown status is caught");
  ok(v({m: [{y: [2010, 2012]}]}).length === 1, "m alternative without md/not is caught");
  ok(validate({updated: "2026-10-19", items: [base, base]}, stlCompile).length === 1, "duplicate id is caught");
  ok(v({made: "סלובקיה"}).length === 0 && v({made: "סלובקיה("}).length >= 1, "made is a pattern");
  ok(v({low: true, cond: "תנאים. ההתאמה לרכב הזה פחות ודאית."}).length === 1, "cond repeating what low adds is caught");
  // the matching, as settlementsFor in index.html runs it on the page's car (the until date aside)
  const fit = (s, mk, car) => { const y = num(car.shnat_yitzur), x = {mk: normS(mk), md: normS([car.kinuy_mishari, car.degem_nm].join(" "))}; return !!s && s.mk.test(x.mk) && (!s.md || s.md.test(x.md)) && (!s.y || y >= s.y[0] && y <= s.y[1]) && (!s.ok || s.ok(car, y, x)); };
  const sk = stlCompile({...base, mk: "קיה", md: "SPORTAGE", made: "סלובקיה"}), sp = {kinuy_mishari: "SPORTAGE", shnat_yitzur: 2017};
  ok(fit(sk, "קיה", {...sp, tozeret_nm: "קיה סלובקיה"}) && !fit(sk, "קיה", {...sp, tozeret_nm: "קיה ד. קוריאה"}) && fit(sk, "קיה", sp), "made: the factory's country decides, a car without the maker's name passes");
  // the file's own entries on the register's spellings (each runs while its entry is in the file)
  const live = id => { const e = j.items.find(x => x.id === id); return e ? stlCompile(e) : null; }, has = (id, mk, car) => fit(live(id), mk, car);
  if (live("honda-oil") && live("honda-oil-typer")) {
    for (const [k, y] of [["CIVIC 5D", 2019], ["CIVIC", 2023], ["CIVIC TYPE R", 2022]]) {
      const tr = {kinuy_mishari: k, ramat_gimur: "TYPE R", sug_delek_nm: "בנזין", nefach_manoa: 1996, shnat_yitzur: y};
      ok(has("honda-oil-typer", "הונדה", tr) && !has("honda-oil", "הונדה", tr), `a Civic Type R (${k}, ${y}) takes its own entry only`);
    }
    const civic = {kinuy_mishari: "CIVIC", ramat_gimur: "SPORT", sug_delek_nm: "בנזין", shnat_yitzur: 2019};
    ok(has("honda-oil", "הונדה", civic) && !has("honda-oil-typer", "הונדה", civic), "a Civic 1.5 takes honda-oil only");
  }
  if (live("audi-etron")) ok(has("audi-etron", "אאודי", {kinuy_mishari: "ETRON", shnat_yitzur: 2020}) && !has("audi-etron", "אאודי", {kinuy_mishari: "E-TRON GT", shnat_yitzur: 2021}) && !has("audi-etron", "אאודי", {kinuy_mishari: "20I VALVETRONIC", shnat_yitzur: 2020}), "e-tron: not the GT, not a 20I VALVETRONIC engine name");
  if (live("mazda-screen")) for (const k of ["MAZDA 3", "MAZDA3", "MAZDA3-SPORT", "MAZDA3 SPORT", "MAZDA 3 SPORT"]) ok(has("mazda-screen", "מזדה", {kinuy_mishari: k, shnat_yitzur: 2018}) && !has("mazda-screen", "מזדה", {kinuy_mishari: k, shnat_yitzur: 2016}), `mazda-screen reads "${k}" as a Mazda 3 (2017 on)`);
  if (live("kia-sport-lamp")) ok(has("kia-sport-lamp", "קיה", {kinuy_mishari: "SPORTAGE", shnat_yitzur: 2017, tozeret_nm: "קיה סלובקיה"}) && !has("kia-sport-lamp", "קיה", {kinuy_mishari: "SPORTAGE", shnat_yitzur: 2017, tozeret_nm: "קיה ד. קוריאה"}), "kia-sport-lamp: a Sportage built in Slovakia only");
  if (live("sub-cvt")) ok(!has("sub-cvt", "סובארו", {kinuy_mishari: "FORESTER", shnat_yitzur: 2012}), "sub-cvt: a 2012 Subaru is past the 10 years");
  const rows = [["מאזדה יפן", "CX-5", 2017, 2026], ["מאזדה יפן", "CX-50", 2023, 2026], ["מאזדה יפן", "CX-30", 2020, 2026], ["יונדאי קוריאה", "I30", 2010, 2020], ["ב.מ.וו גרמניה", "X5 3.0D", 2008, 2012], ["מאזדה יפן", "מאזדה 323", 1995, 2003]];
  const c = coverage([{...base, id: "mz", mk: "מאזדה", md: "CX5"}, {...base, id: "mz2", mk: "מאזדה", md: "CX5(?!0)"}, {...base, id: "none", md: "I40"}, {...base, id: "old", until: "2020-01-01"}, {...base, id: "pick", mk: "שברולט", md: "SILVERADO", nocat: true}, {...base, id: "bmw", mk: "במוו|BMW", md: "X5"}, {...base, id: "m3", mk: "מאזדה", md: "מאזדה3", y: [1995, 2003]}, {...base, id: "m3a", mk: "מאזדה", md: "מאזדה3", age: 6}], rows, stlCompile, {mz2: ["CX-5"], "x-a": []}, "2026-10-19");
  ok(c.longer.join() === "mz: CX-50,m3: מאזדה 323", "CX5 taking CX-50 and מאזדה3 taking 323 are flagged, X5 3.0D is not: " + c.longer);
  ok(c.none.includes("m3a") && !c.snap.m3a.length, "age limits the years a rule covers");
  ok(c.none.join() === "none,m3a", "a rule with no model is flagged: " + c.none);
  ok(c.retire.join() === "old", "an ended entry is listed for removal");
  ok(!c.none.includes("pick"), "nocat is not flagged");
  ok(JSON.stringify(c.snap.mz2) === '["CX-5"]' && !c.fresh.mz2, "no fresh names when nothing changed");
  const c2 = coverage([{...base, id: "mz2", mk: "מאזדה", md: "CX5(?!0)"}], [...rows, ["מאזדה יפן", "CX-5 HYBRID", 2025, 2026]], stlCompile, {mz2: ["CX-5"]}, "2026-10-19");
  ok(c2.fresh.mz2 && c2.fresh.mz2.join() === "CX-5 HYBRID", "a model name a rule took on is listed");
  const feed = `<rss><channel><title>x</title><item><title><![CDATA[יוניון מוטורס תפצה בעלי טויוטה בהסכם פשרה - ביזפורטל]]></title><link>https://news.google.com/rss/articles/abc</link><pubDate>Sun, 18 Oct 2026 08:00:00 GMT</pubDate><source url="https://www.bizportal.co.il">ביזפורטל</source></item><item><title>פשרה: הפניקס תשיב מיליונים למבוטחים בביטוח רכב</title><link>https://x.example/</link></item><item><title>מבחן דרכים: קיה EV3</title><link>https://y.example/</link></item></channel></rss>`;
  const its = parseFeed({s: "Google News"}, feed);
  ok(its.length === 3 && its[0].t === "יוניון מוטורס תפצה בעלי טויוטה בהסכם פשרה" && its[0].s === "Google News: ביזפורטל" && its[0].p === "2026-10-18", "feed parsed: " + JSON.stringify(its[0]));
  ok(its.filter(relevant).length === 1, "only the car settlement is relevant");
  const wp = parseFeed({s: "ייצוגית", json: true}, JSON.stringify([{date: "2026-10-18T10:00:00", link: "https://yitzugit.co.il/a/", title: {rendered: "הסכם פשרה &#124;1-2-3&#124; פלוני נגד קרסו מוטורס בע״מ"}}]));
  ok(wp.length === 1 && wp[0].t.includes("|1-2-3|") && relevant(wp[0]), "court notice parsed and relevant");
  ok(!relevant({t: "הסכם פשרה | 1-2-3 | צפריר פורטנוי נ' ויקטורי רשת סופרמרקטים בע״מ", x: ""}), "צפריר is not צ'רי");
  ok(!relevant({t: "הסכם פשרה בטורקיה על מחירי חשמל", x: ""}) && relevant({t: "הסדר פשרה לבעלי קיה נירו", x: ""}) && relevant({t: "ייצוגית נגד צ'רי", x: ""}), "short brand names as words");
  const d = describe({items: [{...base, st: "wait"}, {...base, id: "gone"}]}, {items: [{...base, st: "ok"}, {...base, id: "new", mk: "טויוטה|לקסוס"}]});
  ok(/נוסף: כותרת \(טויוטה, לקסוס\)/.test(d) && /עודכן: כותרת \(יונדאי\) · אושר/.test(d) && /הוסר: /.test(d) && /סך הכול 2/.test(d), "describe: " + d);
  ok(describe({items: [base]}, {items: [base], checked: "2026-10-26"}) === "", "a review that changed nothing says nothing");
  ok(d.startsWith("<b>✅ בוצע · נתונים</b>") && d.includes("👌"), "describe in the Telegram standard");
  ok(issueHe("none honda-oil") === "כלל שלא מתאים לאף דגם: honda-oil" && issueHe("source down: TheCar (1)") === "מקור חדשות שלא ענה: TheCar (1)" && issueHe("news כותרת") === "כתבה חדשה לבדיקה: כותרת", "issue keys in words");
  console.log(fails ? `${fails} failed` : "settlements selftest ok");
  return fails ? 1 : 0;
}

// ---- CLI (not when imported) ----
const [cmd, a1, a2] = process.argv.slice(2), cliRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
let code = 0;
if (!cliRun) {}
else if (cmd === "check") {
  const file = a1 || path.join(ROOT, "settlements.json");
  const stlCompile = appCompile(), j = JSON.parse(fs.readFileSync(file, "utf8")), bad = validate(j, stlCompile);
  for (const b of bad) console.log(`::error::settlements.json: ${b}`);
  const cov = coverage(j.items, JSON.parse(fs.readFileSync(path.join(ROOT, "models.json"), "utf8")).rows, stlCompile);
  for (const id of cov.none) console.log(`::warning::settlements.json: ${id} matches no model in the catalogue (set nocat when the model is not a private car)`);
  for (const x of cov.longer) console.log(`::warning::settlements.json: ${x}: the rule also takes a longer model code`);
  for (const id of cov.retire) console.log(`::warning::settlements.json: ${id} ended (until passed): remove it`);
  console.log(`settlements.json: ${j.items.length} entries, ${bad.length ? bad.length + " problems" : "valid"}; ${Object.values(cov.snap).reduce((n, l) => n + l.length, 0)} catalogue model names matched`);
  code = bad.length ? 1 : 0;
} else if (cmd === "watch") code = await watch();
else if (cmd === "tell") {
  const rd = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {items: []}; } };
  const old = rd(a1), text = old.items && old.items.length ? describe(old, rd(a2)) : "";
  if (!old.items || !old.items.length) console.log("no earlier list (the file is new): nothing to tell");
  else if (text) await tell1("summary", `stl:update:${today()}`, text + "\nhttps://luchit.app", "https://luchit.app", true);
  else console.log("no entry changed: nothing to tell");
} else if (cmd === "selftest") code = selftest();
else { console.log("usage: settlements.mjs check [file] | watch | tell <old> <new> | selftest"); code = 2; }
if (cliRun) process.exitCode = code;
