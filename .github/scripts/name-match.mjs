// Model-name matching suggestions (use #4 of the monthly Claude API credit, Dudu "לבצע" 28.10.2026), after every catalogue build. Two lists
// the rules leave to a person, each item asked once (the answers are kept next to the catalogue, name-match.json on catalog-data):
//  recalls  rows the app's own matcher ties to no catalogue model (recall-orphans.json, from recall-health.mjs), less the vehicles the catalogue
//           does not hold by design (trucks, motorcycles) and the drive variants: a typo (ANCLAVE), a chassis code (MINI F56), a bare family
//           name (RAM) or an old import. Claude names the maker's catalogue models the row means, or none. An answer is kept only when every
//           name is one of those models, its years meet the recall's build range, and the app's matcher, with the row's model field replaced
//           by the answer, then shows the recall on model-years of them.
//  trims    12-character trim names whose last word the cut rule cannot judge (trim-unsure.json, from catalog-rules.mjs), once per maker and
//           word: whole as it is (QUADRIFOGLIO, AMGLINE), a misspelling of a register word (EDTION), or cut (CARBONEDITIO). Kept only when a
//           misspelling's word and a completion's words are whole words of the register, and a completion starts with the cut letters.
// The small model answers first; when it is not sure, or its answer fails the checks, the larger one answers again with that reason. What
// fails both waits for a person as a doubt. Nothing is applied: name-match.md lists the suggestions for a person, who adds the rule
// (RECALL_TYPOS or TRIM_FIX in index.html, through a release). With no key, no SDK or an API error the run keeps what it had and the
// catalogue is published as always: ai:names goes to the router (ai:key when the key or the credit is the cause), and a good call closes
// both. Nothing here logs a plate, a cost or a token count.
//   env   OUT=<dir> (the catalogue just built)   PREV=<file> (the last name-match.json; default: the catalog-data branch)
//         QUERIES="max=400 minutes=10 dry=1" (at most max items, none started after minutes, so the catalogue job keeps its time; the rest next build)
//   node name-match.mjs --selftest   offline: the checks, the second look, whole runs through a fake API and a fake matcher
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { client, ask, answer } from "./claude.mjs";

export const SMALL = "claude-haiku-5-5", LARGE = "claude-sonnet-5-5";
const RAW = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/name-match.json", WORKERS = 6;
const yearOf = d => { const m = /^(\d{4})/.exec(String(d || "")); return m ? Number(m[1]) : null; };
const up = s => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
export function lev(a, b, max = 3) {   // edit distance, stopping early above max
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let p = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const c = [i]; let lo = i;
    for (let j = 1; j <= b.length; j++) { c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); lo = Math.min(lo, c[j]); }
    if (lo > max) return max + 1;
    p = c;
  }
  return p[b.length];
}

const SYS_RECALL = `You match a recall record of the Israeli Ministry of Transport to car models in a catalogue of the same maker. The record's model field is free text typed by the importer: it can be a model name with a typo, a chassis or platform code, a family name, or several models separated by commas. The catalogue lists the maker's models as the Israeli register names them, each with its model years.

Answer with the catalogue models the record means: exact names from the list, one or more. When the record is for a vehicle the list does not hold (a truck or bus, a motorcycle, a model never registered here), answer none: true and models []. Use what you know of the maker's model names and chassis codes (for example a Mini F56 is the three-door Mini hatch). Only a name from the list counts, and only a model built in the record's years. sure is false when the record could mean other models too, or you are guessing. why: one short English sentence.`;

const SYS_TRIM = `The Israeli vehicle register keeps a car's trim name in a field of 12 characters, so a longer name is cut after the 12th character. You get the last word of such a 12-character trim name, which a rule could not judge, with the register's names that end with it and the whole words of shorter names that are close to it.

Say which it is:
- whole: the last word is complete as it is (a real trim word, or two words written without a space, such as AMGLINE). full is the word as it is.
- typo: the last word is complete but misspelled. full is the correct word, one of the whole words given.
- cut: the last word was cut at the 12th character. full is the complete ending (one or more words, spaces as the maker writes them) that starts with the cut letters, made of the whole words given or of that maker's usual trim words.
sure is false when it could be more than one of these. why: one short English sentence.`;

const RECALL_SCHEMA = { type: "object", additionalProperties: false, required: ["models", "none", "sure", "why"],
  properties: { models: { type: "array", items: { type: "string" } }, none: { type: "boolean" }, sure: { type: "boolean" }, why: { type: "string" } } };
const TRIM_SCHEMA = { type: "object", additionalProperties: false, required: ["kind", "full", "sure", "why"],
  properties: { kind: { type: "string", enum: ["whole", "typo", "cut"] }, full: { type: "string" }, sure: { type: "boolean" }, why: { type: "string" } } };
export const params = (model, system, content, schema) => ({ model, max_tokens: 2000, output_config: { effort: "low", format: { type: "json_schema", schema } },
  system, messages: [{ role: "user", content }] });

// the maker's catalogue models with their years (meta.makers: m names, y [first, last]), over every register code the row is filed under
export function candidates(meta, makers) {
  const out = new Map();
  for (const cd of makers) {
    const x = meta.makers[cd]; if (!x) continue;
    (x.m || []).forEach((name, i) => { const y = (x.y && x.y[i]) || [], e = out.get(name); out.set(name, e ? { name, y0: Math.min(e.y0 || 9999, y[0] || 9999), y1: Math.max(e.y1 || 0, y[1] || 0) } : { name, y0: y[0] || 0, y1: y[1] || 0 }); });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}
const retryLines = r => (r ? ["", `A first answer was rejected: ${JSON.stringify(r.ans)}`, `Why: ${r.why}`, "Answer again."] : []);
export const recallPrompt = (o, cands, r) => [`Maker: ${o.maker}`, `The record's model field: "${o.degem}"`, `Built: ${o.b || "?"} to ${o.e || "?"}`, "",
  "The maker's catalogue models (name: years):", ...cands.map(c => `${c.name}: ${c.y0 || "?"}-${c.y1 || "?"}`), ...retryLines(r)].join("\n");
export function trimPrompt(g, words, r) {
  const L = g.last, near = Object.keys(words).filter(w => w !== L && (w.startsWith(L.slice(0, 3)) || lev(w, L, 2) <= 2)).sort((a, b) => words[b] - words[a] || a.localeCompare(b)).slice(0, 20);
  return [`Maker: ${g.mk}`, `The last word: "${L}"`, "Register names that end with it (model, year, the 12-character name):", ...g.names.map(n => `${n.model}, ${n.y}: "${n.t}"`),
    `Whole words of shorter names close to it: ${near.join(", ") || "(none)"}`, ...retryLines(r)].join("\n");
}

// the checks: "" when the answer holds, else why not (fed back to the larger model, or kept with a doubt)
export function checkRecall(o, ans, cands, verify) {
  if (ans.none) return { why: ans.models.length ? "none, yet models named" : "", hits: 0 };
  if (!ans.models.length) return { why: "no model named and none is false", hits: 0 };
  const by = new Map(cands.map(c => [c.name, c])), unknown = ans.models.filter(m => !by.has(m));
  if (unknown.length) return { why: `not in the list: ${unknown.join(", ")}`, hits: 0 };
  const b = yearOf(o.b), e = yearOf(o.e), off = b && e ? ans.models.filter(m => { const c = by.get(m); return c.y0 && c.y1 && (c.y1 < b - 1 || c.y0 > e + 1); }) : [];
  if (off.length) return { why: `built in other years than the recall: ${off.join(", ")}`, hits: 0 };
  const hits = verify(o, ans.models);
  return { why: hits ? "" : "the app's matcher, with that name, still shows the recall on none of their model-years", hits };
}
export function checkTrim(g, ans, words, fix) {
  const L = g.last, full = up(ans.full), known = w => (words[w] || 0) >= 1 || fix.has(w);
  if (ans.kind === "whole") return full && full.replace(/ /g, "") !== L ? "whole, yet full is another word" : "";
  if (ans.kind === "typo") return !full || full === L ? "a misspelling without the correct word" : !known(full) ? `not a whole word of the register: ${full}`
    : lev(full, L, 3) > 2 ? "too far from the word for a misspelling" : "";
  const flat = full.replace(/ /g, "");
  if (!(flat.length > L.length && flat.startsWith(L))) return `does not start with the cut letters ${L}`;
  const bad = full.split(" ").filter(w => !known(w));
  return bad.length ? `not whole words of the register: ${bad.join(", ")}` : "";
}

// the app's matcher, as recall-health.mjs runs it: the row with its model field replaced, against every model-year (with its drive) of the named models
export async function verifier(out, meta) {
  const { appMatcher } = await import("./app-matcher.mjs"), { matchModelRecalls, brandModels } = appMatcher();
  const idx = new Map(), recRows = new Map(), read = f => JSON.parse(fs.readFileSync(f, "utf8"));
  return (o, models) => {
    let hits = 0;
    for (const cd of o.makers) {
      if (!fs.existsSync(`${out}/c/${cd}.json`) || !fs.existsSync(`${out}/r/${cd}.json`)) continue;
      if (!recRows.has(cd)) { const j = read(`${out}/r/${cd}.json`); recRows.set(cd, j.x ? j.rows.concat(j.x) : j.rows); }
      const row = recRows.get(cd).find(r => Number(r.RECALL_ID) === o.id && String(r.DEGEM || "").trim() === o.degem);
      if (!row) continue;
      if (!idx.has(cd)) idx.set(cd, read(`${out}/c/${cd}.json`));
      const I = idx.get(cd), C = Object.fromEntries(I.cols.map((c, i) => [c, i])), alt = { ...row, DEGEM: models.join(",") }, seen = new Set();
      for (const m of models) for (const a of I.models[m] ? read(`${out}/c/${cd}/${I.models[m][0]}.json`).rows : []) {
        const v = { kinuy_mishari: a[C.kinuy_mishari], degem_nm: a[C.degem_nm], shnat_yitzur: a[C.shnat_yitzur], sug_degem: a[C.sug_degem], tozeret_nm: I.n, tozeret_cd: cd };
        const w = { technologiat_hanaa_nm: a[C.technologiat_hanaa_nm], delek_nm: a[C.delek_nm], merkav: a[C.merkav] }, k = [v.kinuy_mishari, v.degem_nm, v.shnat_yitzur, w.technologiat_hanaa_nm, w.delek_nm, w.merkav].join("|");
        if (seen.has(k)) continue;
        seen.add(k);
        if (matchModelRecalls([alt], v, brandModels(meta, v), w).some(h => h.fits !== false)) hits++;
      }
    }
    return hits;
  };
}

function parse(msg, isRecall) {
  const a = answer(msg);
  if (!a.text) return { why: a.why };
  let o; try { o = JSON.parse(a.text); } catch { return { why: "not json" }; }
  const okR = o && Array.isArray(o.models) && o.models.every(m => typeof m === "string") && typeof o.none === "boolean";
  const okT = o && ["whole", "typo", "cut"].includes(o.kind) && typeof o.full === "string";
  if (!(isRecall ? okR : okT) || typeof o.sure !== "boolean" || typeof o.why !== "string") return { why: "bad fields" };
  return { o: { ...o, why: o.why.slice(0, 200) } };
}
// one item: the small model, then the larger one with the reason when the first is not sure or fails the checks
async function one(api, it, ctx) {
  const isR = it.kind === "recall", cands = isR ? candidates(ctx.meta, it.o.makers) : null;
  if (isR && !cands.length) return { rec: { by: "rules", ans: { models: [], none: true, sure: true, why: "the maker has no model in the catalogue" }, check: "ok", hits: 0, ok: true } };
  let retry = null, last = null;
  for (const [model, by] of [[SMALL, "small"], [LARGE, "large"]]) {
    const content = isR ? recallPrompt(it.o, cands, retry) : trimPrompt(it.g, ctx.words, retry);
    const r = await ask(api, params(model, isR ? SYS_RECALL : SYS_TRIM, content, isR ? RECALL_SCHEMA : TRIM_SCHEMA));
    if (r.error) return { error: r.error };
    const p = parse(r.msg, isR);
    if (p.why) { last = { by, ans: null, check: p.why }; retry = null; continue; }
    const c = isR ? checkRecall(it.o, p.o, cands, ctx.verify) : { why: checkTrim(it.g, p.o, ctx.words, ctx.fix), hits: 0 };
    last = { by, ans: p.o, check: c.why || "ok", ...(isR ? { hits: c.hits } : {}) };
    if (!c.why && (p.o.sure || by === "large")) return { rec: { ...last, ok: true, ...(p.o.sure ? {} : { unsure: true }) } };
    retry = { ans: p.o, why: c.why || "the answer was not sure" };
  }
  return { rec: { ...last, ok: false } };
}

export function queries(s) {
  const q = { max: 400, minutes: 10, dry: false };
  for (const [, k, v] of String(s || "").matchAll(/(\w+)=([\w.-]+)/g)) {
    if (k === "max") q.max = Math.max(1, Math.min(2000, Math.round(+v) || 0));
    else if (k === "minutes") q.minutes = Math.max(1, Math.min(40, Math.round(+v) || 0));
    else if (k === "dry") q.dry = v === "1" || v === "true";
  }
  return q;
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
async function fetchJson(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); return r.ok ? await r.json() : null; } catch { return null; } }
function trimFix(page) {   // what TRIM_FIX in index.html completes to is whole (catalog-rules.mjs reads it the same way)
  try { const src = fs.readFileSync(page, "utf8").match(/const TRIM_FIX = (\{[\s\S]*?\});/); return new Set(Object.values(new Function("return " + src[1])()).flatMap(v => v.split(" "))); } catch { return new Set(); }
}

function review(st, day) {
  const R = Object.values(st.recalls), T = Object.values(st.trims), yrs = o => [yearOf(o.b), yearOf(o.e)].filter(Boolean).join("-");
  const rline = x => `- ${x.maker} "${x.degem}" ${yrs(x)} (${x.id})` + (!x.ans ? ` · אין תשובה (${x.check})` : x.ans.none ? " · לא בקטלוג (משאית, אופנוע או דגם שלא נרשם כאן)"
    : ` → ${x.ans.models.join(", ")}${x.ok ? ` · האפליקציה הייתה מציגה אותו ב-${x.hits} שנות דגם` : ` · לא עבר: ${x.check}`}`) + (x.unsure ? " · לא בטוח" : "") + (x.ans ? ` · ${x.ans.why}` : "");
  const kind = { whole: "שלם", typo: "שגיאת כתיב של", cut: "נקטע, כנראה" };
  const tline = x => `- ${x.mk} "${x.last}" (${x.n} שמות, למשל ${x.names[0].model} ${x.names[0].y} "${x.names[0].t}")` + (!x.ans ? ` · אין תשובה (${x.check})`
    : ` · ${kind[x.ans.kind]}${x.ans.kind === "whole" ? "" : " " + up(x.ans.full)}${x.ok ? "" : ` · לא עבר: ${x.check}`}`) + (x.unsure ? " · לא בטוח" : "");
  const part = (title, xs, f) => (xs.length ? [`## ${title} (${xs.length})`, "", ...xs.map(f), ""] : []);
  return [`# הצעות התאמת שמות לבדיקה`, "", `עודכן ${day}. שום דבר כאן לא מוחל: אדם מוסיף את הכלל (RECALL_TYPOS או TRIM_FIX ב-index.html) בשחרור.`, "",
    ...part("ריקולים: דגם מוצע שעבר את הבדיקות", R.filter(x => x.ok && x.ans && !x.ans.none), rline),
    ...part("ריקולים: לא בקטלוג", R.filter(x => x.ok && x.ans && x.ans.none), rline),
    ...part("ריקולים: צריך עין", R.filter(x => !x.ok), rline),
    ...part("שמות גימור: נקטעו או בשגיאת כתיב (להוסיף ל-TRIM_FIX)", T.filter(x => x.ok && x.ans.kind !== "whole"), tline),
    ...part("שמות גימור: צריך עין", T.filter(x => !x.ok), tline),
    ...part("שמות גימור: שלמים כמו שהם", T.filter(x => x.ok && x.ans.kind === "whole"), tline)].join("\n");
}

// the router (alert.mjs): a failed call is ai:names (summary), the key or the credit is ai:key (day, Dudu acts); a good call closes both
async function tell(router, err, env) {
  if (!router) return;
  const { tag, todo, folded } = await import("./tg-text.mjs");
  const text = err.key
    ? [tag("today", "bots"), "מפתח ה-Claude API לא עובד או שהקרדיט החודשי נגמר, ולכן הצעות התאמת השמות לא נכתבו הפעם. הקטלוג פורסם כרגיל.",
        todo("לבדוק ב-Console של Anthropic שהמפתח פעיל ושנשאר קרדיט, או להדביק מחדש את ANTHROPIC_API_KEY ב-GitHub")].join("\n") + folded(err.why)
    : [tag("info", "data"), err.crash ? "הצעות התאמת השמות לא נכתבו הפעם: הבוט נעצר בשגיאה בקוד שלו. הקטלוג פורסם כרגיל, והתיקון אצל הבוט שאחראי על הנתונים."
        : "הצעות התאמת השמות לא נכתבו הפעם: הפנייה ל-Claude נכשלה. הקטלוג פורסם כרגיל, והבוט ינסה שוב בבנייה הבאה.", todo()].join("\n") + folded(err.why);
  try { await router.alert(err.key ? "day" : "summary", err.key ? "ai:key" : "ai:names", text, env.RUN_URL || "", { today: err.key ? "loud" : "silent", legacy: () => false }); } catch { /* the log line says it */ }
}

export async function run({ env = process.env, api, router, verify, log = console.log, now = new Date() } = {}) {
  const q = queries(env.QUERIES), out = env.OUT || "out", day = now.toISOString().slice(0, 10);
  const meta = readJson(`${out}/meta.json`), orphans = (readJson(`${out}/recall-orphans.json`) || {}).rows || [], tu = readJson(`${out}/trim-unsure.json`) || { words: {}, unsure: [] };
  const prev = env.PREV !== undefined ? readJson(env.PREV) : await fetchJson(RAW), st = { u: day, recalls: (prev && prev.recalls) || {}, trims: (prev && prev.trims) || {} };
  if (router === undefined) router = await import("./alert.mjs").catch(() => null);
  const rep = { asked: 0, kept: 0, doubt: 0, why: "" };
  const done = () => {
    fs.writeFileSync(`${out}/name-match.json`, JSON.stringify(st));
    fs.writeFileSync(`${out}/name-match.md`, review(st, day) + "\n");
    log(`name match: ${Object.keys(st.recalls).length} recall rows and ${Object.keys(st.trims).length} trim words answered; asked ${rep.asked}, kept ${rep.kept}, doubt ${rep.doubt}${rep.why ? " · " + rep.why : ""}`);
    return rep;
  };
  if (!meta) { rep.why = "no meta.json"; return done(); }
  const items = [
    ...orphans.filter(o => !o.notCar && !o.variant).map(o => ({ kind: "recall", key: `${o.id}|${o.degem}`, o })).filter(x => !st.recalls[x.key]),
    ...tu.unsure.map(g => ({ kind: "trim", key: `${g.cd}|${g.last}`, g })).filter(x => !st.trims[x.key]),
  ].slice(0, q.max);
  if (q.dry) { log(`dry run: ${items.length} to ask, nothing sent`); return done(); }
  if (!items.length) return done();
  const c = api ? { api } : await client(env, { timeout: 60000 });
  if (!c.api) { rep.why = c.why; if (!/ANTHROPIC_API_KEY/.test(c.why)) await tell(router, { why: c.why, key: false }, env); return done(); }   // no key: switched off on purpose
  const ctx = { meta, words: tu.words || {}, fix: trimFix(env.PAGE || "index.html"), verify: verify || await verifier(out, meta) };
  let failed = null, good = false, i = 0;
  const until = now.getTime() + q.minutes * 60000;
  await Promise.all(Array.from({ length: WORKERS }, async () => {
    while (!failed && i < items.length && Date.now() < until) {
      const it = items[i++], r = await one(c.api, it, ctx);
      if (r.error) { failed = failed || r.error; break; }   // the rest are asked next time
      good = true; rep.asked++; r.rec.ok ? rep.kept++ : rep.doubt++;
      if (it.kind === "recall") st.recalls[it.key] = { id: it.o.id, maker: it.o.maker, degem: it.o.degem, b: it.o.b, e: it.o.e, makers: it.o.makers, ...r.rec, at: day };
      else st.trims[it.key] = { cd: it.g.cd, mk: it.g.mk, last: it.g.last, n: it.g.n, names: it.g.names.slice(0, 3), ...r.rec, at: day };
    }
  }));
  if (failed) { rep.why = failed.why; await tell(router, failed, env); }
  else if (good && router) { try { await router.resolve(["ai:names"]); await router.resolve(["ai:key"]); } catch { /* the morning ledger still shows it */ } }
  return done();
}

if (process.argv[1] && process.argv[1].endsWith("name-match.mjs") && !process.argv.includes("--selftest")) {
  try { await run(); } catch (e) {   // the catalogue is published either way, and the router hears of the crash as the bot's own failure
    const why = "crash: " + String((e && e.message) || e).slice(0, 160);
    console.log("name match skipped: " + why);
    await tell(await import("./alert.mjs").catch(() => null), { why, key: false, crash: true }, process.env);
  }
}

if (process.argv[1] && process.argv[1].endsWith("name-match.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const meta = { makers: { 1: { n: "BUICK", m: ["ENCLAVE", "LACROSSE"], y: [[2008, 2017], [2005, 2016]] }, 2: { n: "MINI", m: ["MINI COOPER", "MINI COUNTRYMAN"], y: [[2014, 2025], [2011, 2025]] } } };
  const cands = candidates(meta, ["1"]), hitsOf = (o, models) => (models.includes("ENCLAVE") || models.includes("MINI COOPER") ? 3 : 0);
  const O = (degem, b = "2013-01-01", e = "2013-12-31", makers = ["1"], id = 1) => ({ id, makers, maker: makers[0] === "2" ? "BMW" : "BUICK", degem, b, e, variant: false, near: [], notCar: false });
  ok(cands.length === 2 && cands[0].name === "ENCLAVE" && cands[0].y0 === 2008, "candidates: the maker's catalogue models with their years");
  ok(checkRecall(O("ANCLAVE"), { models: ["ENCLAVE"], none: false, sure: true }, cands, hitsOf).why === "" && checkRecall(O("ANCLAVE"), { models: ["ENCLAVE"], none: false, sure: true }, cands, hitsOf).hits === 3, "a typo named right: kept, with the model-years the matcher then shows it on");
  ok(/not in the list/.test(checkRecall(O("RAM"), { models: ["RAM 1500"], none: false, sure: true }, cands, hitsOf).why), "a name that is not one of the maker's models fails");
  ok(/other years/.test(checkRecall(O("X", "2020-01-01", "2021-12-31"), { models: ["LACROSSE"], none: false, sure: true }, cands, hitsOf).why), "a model built in other years fails");
  ok(/matcher/.test(checkRecall(O("X", "2008-01-01", "2010-12-31"), { models: ["LACROSSE"], none: false, sure: true }, cands, hitsOf).why), "a name the app's matcher would still not show it on fails");
  ok(checkRecall(O("NPR 75"), { models: [], none: true, sure: true }, cands, hitsOf).why === "" && /none, yet/.test(checkRecall(O("X"), { models: ["ENCLAVE"], none: true, sure: true }, cands, hitsOf).why), "none: kept; none with names fails");
  const words = { EDITION: 40, CARBON: 3, SPORT: 50, LINE: 30 }, fix = new Set(["PREMIUM"]), G = last => ({ cd: "1", mk: "BUICK", last, n: 1, names: [{ model: "ENCLAVE", y: 2016, t: "X " + last }] });
  ok(checkTrim(G("QUADRIFOGLIO"), { kind: "whole", full: "QUADRIFOGLIO" }, words, fix) === "" && checkTrim(G("EDTION"), { kind: "typo", full: "EDITION" }, words, fix) === ""
    && checkTrim(G("CARBONEDITIO"), { kind: "cut", full: "CARBON EDITION" }, words, fix) === "", "trims: whole, a misspelling of a register word, a cut made of register words");
  ok(/not a whole word/.test(checkTrim(G("EDTION"), { kind: "typo", full: "EDDITION" }, words, fix)) && /cut letters/.test(checkTrim(G("CARBONEDITIO"), { kind: "cut", full: "CARBON LINE" }, words, fix))
    && /not whole words/.test(checkTrim(G("CARBONEDITIO"), { kind: "cut", full: "CARBONEDITIONX" }, words, fix)) && /another word/.test(checkTrim(G("AMGLINE"), { kind: "whole", full: "AMG LINES" }, words, fix)),
    "trims: a correction outside the register, a completion that does not start with the cut letters or has unknown words, a whole that renames");
  ok(lev("EDTION", "EDITION") === 1 && lev("ABC", "XYZW", 2) === 3, "edit distance");
  ok(recallPrompt(O("ANCLAVE"), cands, null).includes("ENCLAVE: 2008-2017") && !/\d{7}/.test(recallPrompt(O("ANCLAVE"), cands, null)) && trimPrompt(G("EDTION"), words, null).includes("EDITION"), "prompts: the model list with years; the close register words");
  ok(JSON.stringify(params(SMALL, "s", "c", TRIM_SCHEMA).output_config) === JSON.stringify({ effort: "low", format: { type: "json_schema", schema: TRIM_SCHEMA } }), "the request: structured output, low effort");
  // whole runs through a fake API: the small model is wrong once (RAM), unsure once (MINI F56), and right for the rest
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nm-")), out = path.join(tmp, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "meta.json"), JSON.stringify(meta));
  fs.writeFileSync(path.join(out, "recall-orphans.json"), JSON.stringify({ rows: [O("ANCLAVE"), O("RAM", "2013-01-01", "2013-12-31", ["1"], 2), O("MINI F56", "2021-01-01", "2021-12-31", ["2"], 3), O("NPR 75", "2010-01-01", "2010-12-31", ["1"], 4),
    { ...O("K 1600"), id: 5, notCar: true }, { ...O("ENCLAVE BEV"), id: 6, variant: true }, { ...O("HUMMER H2", "2005-01-01", "2006-12-31", ["9"]), id: 7 }] }));
  fs.writeFileSync(path.join(out, "trim-unsure.json"), JSON.stringify({ words, unsure: [G("QUADRIFOGLIO"), G("EDTION"), G("CARBONEDITIO"), G("ZZZZZZ")] }));
  const asked = [], reply = (model, u) => {
    asked.push([model, u]);
    const R = o => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(o) }] });
    if (u.includes('"ANCLAVE"')) return R({ models: ["ENCLAVE"], none: false, sure: true, why: "typo" });
    if (u.includes('"RAM"')) return R(model === SMALL ? { models: ["RAM 1500"], none: false, sure: true, why: "family" } : { models: [], none: true, sure: true, why: "no Ram in the list" });
    if (u.includes('"MINI F56"')) return R({ models: ["MINI COOPER"], none: false, sure: model !== SMALL, why: "F56 is the hatch" });
    if (u.includes('"NPR 75"')) return R({ models: [], none: true, sure: true, why: "a truck" });
    if (u.includes('"QUADRIFOGLIO"')) return R({ kind: "whole", full: "QUADRIFOGLIO", sure: true, why: "Alfa trim" });
    if (u.includes('"EDTION"')) return R({ kind: "typo", full: "EDITION", sure: true, why: "missing I" });
    if (u.includes('"CARBONEDITIO"')) return R({ kind: "cut", full: "CARBON EDITION", sure: true, why: "cut" });
    return R({ kind: "cut", full: "ZZZZZZQ", sure: true, why: "guess" });
  };
  const fake = (fail = 0) => ({ messages: { create: async p => { if (fail) { const e = new Error("x"); e.status = fail; throw e; } return reply(p.model, p.messages[0].content); } } });
  const calls = [], router = { alert: async (lv, key) => { calls.push(["alert", lv, key]); }, resolve: async p => { calls.push(["resolve", p[0]]); return 0; } }, quiet = () => {};
  let r = await run({ env: { OUT: out, PREV: path.join(tmp, "none.json"), PAGE: path.join(tmp, "none.html") }, api: fake(), router, verify: hitsOf, log: quiet });
  const st = JSON.parse(fs.readFileSync(path.join(out, "name-match.json"), "utf8")), rec = id => Object.values(st.recalls).find(x => x.id === id), tr = w => st.trims["1|" + w];
  ok(rec(7) && rec(7).by === "rules" && rec(7).ans.none && !asked.some(([, u]) => u.includes('"HUMMER H2"')), "a maker with no catalogue model: none by the rules, no call");
  ok(r.asked === 9 && Object.keys(st.recalls).length === 5 && !Object.values(st.recalls).some(x => x.id === 5 || x.id === 6), "8 asked: 4 recall rows (not the truck flagged by the rules, not the drive variant) and 4 trim words");
  ok(rec(1).ok && rec(1).by === "small" && rec(1).hits === 3 && rec(4).ok && rec(4).ans.none, "a typo: the small model, checked by the matcher; a truck: none");
  ok(rec(2).ok && rec(2).by === "large" && rec(2).ans.none && asked.some(([m, u]) => m === LARGE && u.includes('"RAM"') && u.includes("not in the list: RAM 1500")), "a name outside the list goes to the larger model with the reason, which answers none");
  ok(rec(3).ok && rec(3).by === "large" && asked.some(([m, u]) => m === LARGE && u.includes('"MINI F56"') && u.includes("not sure")), "an unsure small answer gets a second look");
  ok(tr("QUADRIFOGLIO").ok && tr("EDTION").ok && tr("CARBONEDITIO").ok && !tr("ZZZZZZ").ok && tr("ZZZZZZ").by === "large" && r.doubt === 1, "trims: three kept, a completion of unknown words is a doubt after both models");
  ok(calls.some(c => c[1] === "ai:names") && calls.some(c => c[1] === "ai:key") && !calls.some(c => c[0] === "alert"), "a good run closes ai:names and ai:key");
  const md = fs.readFileSync(path.join(out, "name-match.md"), "utf8");
  ok(md.includes("→ ENCLAVE") && md.includes("לא בקטלוג") && md.includes("נקטע, כנראה CARBON EDITION") && md.includes("צריך עין (1)"), "name-match.md: the suggestions by kind, the doubt apart");
  asked.length = 0; calls.length = 0;
  r = await run({ env: { OUT: out, PREV: path.join(out, "name-match.json") }, api: fake(), router, verify: hitsOf, log: quiet });
  ok(r.asked === 0 && !asked.length, "the next run asks nothing: each item once");
  r = await run({ env: { OUT: out, PREV: path.join(tmp, "none.json") }, router, log: quiet });
  ok(r.why === "no ANTHROPIC_API_KEY" && !calls.length, "no key: nothing asked, nothing raised");
  r = await run({ env: { OUT: out, PREV: path.join(tmp, "none.json") }, api: fake(529), router, verify: hitsOf, log: quiet });
  ok(r.why === "529 server" && calls.some(c => c[0] === "alert" && c[1] === "summary" && c[2] === "ai:names") && !calls.some(c => c[0] === "resolve"), "an API error: ai:names (summary), nothing closed");
  calls.length = 0;
  r = await run({ env: { OUT: out, PREV: path.join(tmp, "none.json") }, api: fake(401), router, verify: hitsOf, log: quiet });
  ok(r.why === "401 key" && calls.some(c => c[1] === "day" && c[2] === "ai:key"), "a refused key: ai:key (day)");
  const logs = [];
  r = await run({ env: { OUT: out, PREV: path.join(tmp, "none.json"), QUERIES: "dry=1" }, api: fake(500), router, log: l => logs.push(l) });
  ok(logs.some(l => /^dry run: 9 to ask/.test(l)), "dry: counts only");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
