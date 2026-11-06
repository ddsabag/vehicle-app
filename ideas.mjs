#!/usr/bin/env node
// Weekly content ideas for לוחית, built only from data files in a checkout of ddsabag/vehicle-app (main). No npm dependencies.
// Every number is emitted as a fact in facts.json format and re-verified against its source before it is printed, so nothing is invented.
//
// usage: node ideas.mjs <repo-checkout> [--gsc <decrypted-search-console.json>] [--camp <decrypted-campaign-opens.json>]
//                       [--catalog <catalog-data checkout>] [--recall-since <RECALL_ID>] [--out ideas.json]
//   Changes over time (fuel price change, models whose recall rate changed) need git history: clone with --depth 200 (a --depth 1
//   clone still works; those ideas then say "no history in this checkout").
//   The Search Console file is the decrypted seo-data snapshot (see RUNBOOK.md). Its numbers are private: use them to pick topics, not in copy.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { checkFact, numbersIn, repoHead } from "./lib/facts.mjs";

const args = process.argv.slice(2);
const opt = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const VALUE_OPTS = ["--gsc", "--out", "--camp", "--catalog", "--recall-since"];
const repo = args.find((a, i) => !a.startsWith("--") && !VALUE_OPTS.includes(args[i - 1]));
if (!repo || !fs.existsSync(path.join(repo, "magazine/posts.json"))) {
  console.error("usage: node ideas.mjs <vehicle-app checkout> [--gsc <seo-data.json>] [--out ideas.json]\n(the folder must contain magazine/posts.json)");
  process.exit(2);
}
const gscPath = opt("--gsc"), outPath = opt("--out"), campPath = opt("--camp"), catalogPath = opt("--catalog");
const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
// the same fact rules as the lint (lint-config.json: bindings, rounding, text must contain the value...)
const FACTS_CFG = JSON.parse(fs.readFileSync(new URL("./lint-config.json", import.meta.url), "utf8")).rules.facts;
const head = repoHead(repo);
const J = p => JSON.parse(fs.readFileSync(path.join(repo, p), "utf8"));
const fmt = n => Math.round(n).toLocaleString("en-US");
const warnings = [], dropped = [];

// emit a fact only after it passes every rule the lint applies (value re-read from the source, text, bindings, rounding).
// fetched_at = when ideas.mjs read the checkout; data_as_of = the date of the data itself (the source file's own "updated"/"checked").
let dataAsOf = null;
function fact(f) {
  const full = { ...f, fetched_at: now, ...(dataAsOf ? { data_as_of: dataAsOf } : {}), repo_commit: head.sha };
  const r = checkFact(full, { repo, now: Date.parse(now), cfg: FACTS_CFG });
  const v = r.verify;
  if (!v || !v.ok || r.errors.length) { dropped.push({ text: f.text, value: f.value, why: [...(!v || !v.ok ? [v && v.error || `source gives ${v && v.computed}`] : []), ...r.errors].join("; ") }); return null; }
  return full;
}
const facts = a => a.filter(Boolean);
function gitRevs(p, n = 200) {
  try { return execFileSync("git", ["-C", repo, "log", `-n${n}`, "--format=%H%x09%cI", "--", p], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n").filter(Boolean).map(l => { const [sha, date] = l.split("\t"); return { sha, date }; }); }
  catch { return []; }
}
function atRev(sha, p) { try { return JSON.parse(execFileSync("git", ["-C", repo, "show", `${sha}:${p}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 })); } catch { return null; } }
const shallow = (() => { try { return execFileSync("git", ["-C", repo, "rev-parse", "--is-shallow-repository"], { encoding: "utf8" }).trim() === "true"; } catch { return null; } })();

const ideas = [];

// 1. latest magazine article (posts.json is sorted newest first by date, then slug)
{
  const posts = J("magazine/posts.json");
  const sorted = [...posts].sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));
  for (const p of sorted.slice(0, 3)) {
    const ptr = `/[slug=${p.slug}]/lead`;
    const ns = numbersIn(p.lead);
    dataAsOf = p.date;
    const fs_ = ns.map((n, i) => {
      // "לכל 1,000" is a unit, and a year is a date: neither is a claim (as facts they would let any "1,000" / "2026" in copy pass)
      const pre = p.lead.slice(Math.max(0, n.index - 6), n.index);
      if (n.value === 1000 && /(?:לכל|מכל|ל-|per)\s*$/.test(pre)) return null;
      if (Number.isInteger(n.value) && n.value >= 1990 && n.value <= 2049 && !n.raw.includes(",")) return null;
      // the sentence fragment that holds the number, for the copywriter
      const a = Math.max(p.lead.lastIndexOf(" ", Math.max(0, n.index - 25)), 0), b = p.lead.indexOf(" ", n.index + n.raw.length + 20);
      return fact({ text: p.lead.slice(a, b < 0 ? undefined : b).trim(), value: n.value, source_path: "magazine/posts.json", json_pointer: ptr, number_index: i });
    });
    const pillar = p.tag === "ריקולים" ? "Trust & Safety" : p.tag === "שוק הרכב" ? "B2B utility" : p.tag === "דגמים חדשים" ? "Efficiency/compare" : "Community";
    ideas.push({
      id: `magazine-${p.slug}`, kind: "magazine", latest: p === sorted[0], pillar_hint: pillar,
      title: p.title, date: p.date, url: `https://luchit.app/magazine/${p.slug}/?utm_source=instagram&utm_medium=social&utm_campaign=${p.slug}`,
      angle: "Turn the article's lead into a carousel (cover = headline number, 3 slides of context, CTA to the article). Quote numbers exactly as in the lead.",
      lead: p.lead, facts: facts(fs_),
      cautions: p.tag === "ריקולים" ? ["A recall count is not a reliability verdict (the article says so); never imply a model is unsafe or a dealer hid something.", "Repair is usually free at the importer: write 'בדרך כלל ללא עלות', not 'זכאים'.",
        "Unit: the magazine's 'N ריקולים לכל 1,000 רכבים פעילים' counts active cars that appear in the open-recall dataset (cars with at least one open recall), not recall campaigns: in copy write 'N מכל 1,000 רכבים פעילים עם ריקול פתוח' (118 per 1,000 = about 12% of the cars).",
        "'בלי אף ריקול רשום' in the lead means a rate that rounds to 0.0 per 1,000 (under 0.05): in copy write 'כמעט בלי ריקולים פתוחים', never 'אף ריקול' / 'אפס'."]
        : p.tag === "שוק הרכב" ? ["Scope: new PRIVATE cars (sug_degem P). Write 'רכבים פרטיים חדשים', not just 'רכבים'."] : [],
    });
  }
}

// 2. recalls: model/stats.json (rcPer = registered recalls per 1,000 active cars, models with >= 3,000 active cars as in the magazine)
{
  const S = J("model/stats.json");
  dataAsOf = S.updated;
  const big = S.models.filter(m => m.act >= 3000);
  const top = big.filter(m => m.rcPer > 0).sort((a, b) => b.rcPer - a.rcPer).slice(0, 5);
  const name = m => (/^[A-Za-z]/.test(m.label) && String(m.disp).toUpperCase().startsWith(String(m.label).toUpperCase())) ? m.disp : `${m.label} ${m.disp}`;
  const fl = [
    fact({ text: `${big.length} דגמים עם לפחות 3,000 רכבים פעילים`, value: big.length, source_path: "model/stats.json", derive: { op: "count_where", args: [{ source_path: "model/stats.json", json_pointer: "/models", where: [["act", ">=", 3000]] }] } }),
    fact({ text: `${big.filter(m => m.rcPer === 0).length} מהם עם שיעור ריקול פתוח שמתעגל ל-0 (פחות מ-0.05 לכל 1,000 רכבים)`, value: big.filter(m => m.rcPer === 0).length, source_path: "model/stats.json", derive: { op: "count_where", args: [{ source_path: "model/stats.json", json_pointer: "/models", where: [["act", ">=", 3000], ["rcPer", "==", 0]] }] } }),
    fact({ text: "סף הרשימה: 3,000 רכבים פעילים", value: 3000, source_path: ".github/scripts/magazine-data.mjs", regex: "m\\.act >= (\\d+)" }),
    ...top.flatMap(m => [
      fact({ text: `${name(m)}: ${Math.round(m.rcPer)} מכל 1,000 רכבים פעילים עם ריקול פתוח (${m.rcPer} לפני עיגול)`, value: Math.round(m.rcPer), round: 0, source_path: "model/stats.json", json_pointer: `/models/[slug=${m.slug}]/rcPer` }),
      fact({ text: `${name(m)}: ${fmt(m.act)} רכבים פעילים`, value: m.act, source_path: "model/stats.json", json_pointer: `/models/[slug=${m.slug}]/act` }),
    ]),
  ];
  // changes since the previous version of the file (needs history)
  const revs = gitRevs("model/stats.json");
  let changes = [], note = null;
  if (revs.length < 2) note = shallow ? `model/stats.json has ${revs.length} version(s) in this shallow checkout: no earlier version to compare (git -C <repo> fetch --deepen 500 for more history)` : "model/stats.json has a single version";
  else {
    const prev = atRev(revs[1].sha, "model/stats.json");
    if (prev) {
      const old = new Map(prev.models.map(m => [m.slug, m]));
      changes = S.models.filter(m => m.act >= 3000 && old.has(m.slug) && m.rcPer > old.get(m.slug).rcPer)
        .sort((a, b) => (b.rcPer - old.get(b.slug).rcPer) - (a.rcPer - old.get(a.slug).rcPer)).slice(0, 5)
        .map(m => ({ slug: m.slug, name: name(m), from: old.get(m.slug).rcPer, to: m.rcPer, prev_rev: revs[1].sha, prev_date: revs[1].date, facts: facts([
          fact({ text: `${name(m)}: ${old.get(m.slug).rcPer} מכל 1,000 רכבים פעילים עם ריקול פתוח (${prev.updated})`, value: old.get(m.slug).rcPer, source_path: "model/stats.json", source_rev: revs[1].sha, json_pointer: `/models/[slug=${m.slug}]/rcPer` }),
          fact({ text: `${name(m)}: ${m.rcPer} מכל 1,000 רכבים פעילים עם ריקול פתוח (${S.updated})`, value: m.rcPer, source_path: "model/stats.json", json_pointer: `/models/[slug=${m.slug}]/rcPer` }),
        ]) }));
      if (!changes.length) note = `no model's recall rate rose between ${prev.updated} and ${S.updated}`;
    }
  }
  ideas.push({
    id: "recalls-model-stats", kind: "recalls", pillar_hint: "Trust & Safety", data_updated: S.updated,
    title: "Recall data: share of active cars with an open recall, per model",
    angle: "Educational, not alarming: 'ריקול = היצרן מתקן, בדרך כלל בלי עלות אצל היבואן'. Good fit for a poll/quiz story (phone only) or a carousel. Use the near-zero models as the positive counterweight.",
    facts: facts(fl), recall_rate_changes: changes, history_note: note,
    notes: ["Individual recall campaigns are not stored in the repo: the app reads them live from data.gov.il (recall dataset 36bf1404-0be4-49d2-82dc-2f1ead4a8b93). Only model-level rates are in model/stats.json and modelstats.json (recallsPer1000 per model and year)."],
    cautions: ["Never name a dealer or importer as the cause; a high count can reflect thorough reporting (the magazine says so).", "Do not write 'זכאים'; write 'ייתכן' / 'בדרך כלל'.",
      "rcPer is the number of active cars (per 1,000) that appear in the open-recall dataset 36bf1404, i.e. cars with at least one open recall; it is NOT a count of recalls. Write 'N מכל 1,000 רכבים פעילים עם ריקול פתוח', never 'N ריקולים לכל 1,000'.",
      "rcPer 0 means under 0.05 per 1,000 after rounding (e.g. a large model can have a few recalled cars and still show 0): write 'כמעט בלי ריקולים פתוחים', never 'בלי אף ריקול' / 'אפס ריקולים'."],
  });
}

// 3. fuel price (fuel.json, written by .github/scripts/fuel.mjs: the regulated 95 price from the gov.il monthly PDF, or, when that fails,
// Delek's full-service list price minus a fixed 0.26 for self-service. Which one it is shows in fuel.json "source".)
{
  const F = J("fuel.json");
  dataAsOf = F.checked || null;
  const official = /(?:^|\.)gov\.il\//i.test(String(F.source || "").replace(/^https?:\/\/(?:www\.)?/, ""));
  const fl = [
    fact({ text: official ? `בנזין 95 (מחיר מפוקח, שירות עצמי): ${F.petrol95} ש"ח לליטר (${F.month})` : `בנזין 95: ${F.petrol95} ש"ח לליטר (${F.month}, מחירון דלק בשירות מלא פחות 0.26, לא המחיר המפוקח)`, value: F.petrol95, source_path: "fuel.json", json_pointer: "/petrol95" }),
    F.diesel != null && F.diesel >= 8 && F.diesel <= 15 ? fact({ text: `סולר במחירון דלק, שירות מלא: ${F.diesel} ש"ח לליטר (${F.month})`, value: F.diesel, source_path: "fuel.json", json_pointer: "/diesel" }) : null,
  ];
  const cautions = [official
    ? `The 95-octane price comes from the gov.il monthly notice (${F.source}, checked ${F.checked}): it is the regulated self-service price; say 'מחיר מפוקח' and the month.`
    : `VERIFY: fuel.json.source is ${F.source} (checked ${F.checked}), not the gov.il notice. The 95 price ${F.petrol95} is Delek's full-service list price minus a fixed 0.26 (fuel.mjs), not the regulated price. Do not call it 'המחיר המפוקח' and do not use it until you confirm the regulated price for ${F.month} on gov.il.`];
  if (!official) warnings.push(`fuel.json: source is ${F.source}, not gov.il: the 95 price is derived from Delek's list (see the fuel idea's cautions)`);
  // diesel is not price-regulated: fuel.json keeps Delek's full-service list price, and chains differ (10.50-12.49 on 17.10.2026), so it is never a national price
  if (F.diesel != null) cautions.push(F.diesel >= 8 && F.diesel <= 15
    ? `Diesel (${F.diesel}) is not a regulated price: it is Delek's full-service list price, and other chains and self-service differ. Never present it as 'מחיר הסולר' (the lint blocks that); if used at all, say 'במחירון דלק, בשירות מלא' with the month.`
    : `Sanity check: diesel (${F.diesel}) is outside the plausible 8-15 range in fuel.json; it is not emitted as a fact. Check the source (${F.source}).`);
  const revs = gitRevs("fuel.json");
  let change = null, note = null;
  // same-month revisions are corrections of the data, not a price change: report them as a caution
  for (const r of revs.slice(1)) {
    const o = atRev(r.sha, "fuel.json");
    if (!o) continue;
    if (o.month === F.month) {
      if (o.petrol95 !== F.petrol95) cautions.push(`VERIFY: fuel.json for ${F.month} changed within the month: ${o.petrol95} (${o.source}, checked ${o.checked}) -> ${F.petrol95} (${F.source}, checked ${F.checked}). The repo does not say why (a mid-month price change, or a switch of source, e.g. gov.il -> Delek list): confirm the current regulated 95-octane price and its start date before quoting it.`);
      continue;
    }
    if (o.petrol95 !== F.petrol95) {
      const d = F.petrol95 - o.petrol95, pc = d / o.petrol95 * 100;
      change = { from: o.petrol95, from_month: o.month, to: F.petrol95, to_month: F.month, direction: d > 0 ? "up" : "down", prev_rev: r.sha, facts: facts([
        fact({ text: `בנזין 95 ב-${o.month}: ${o.petrol95} ש"ח לליטר`, value: o.petrol95, source_path: "fuel.json", source_rev: r.sha, json_pointer: "/petrol95" }),
        fact({ text: `בנזין 95: ${d > 0 ? "עלייה" : "ירידה"} של ${Math.abs(d).toFixed(2)} ש"ח לליטר (${o.month} לעומת ${F.month})`, value: Number(Math.abs(d).toFixed(2)), abs: true, round: 2, source_path: "fuel.json", derive: { op: "diff", args: [{ source_path: "fuel.json", source_rev: r.sha, json_pointer: "/petrol95" }, { source_path: "fuel.json", json_pointer: "/petrol95" }] } }),
        fact({ text: `בנזין 95: ${d > 0 ? "עלייה" : "ירידה"} של ${Math.abs(pc).toFixed(1)}% (${o.month} לעומת ${F.month})`, value: Number(Math.abs(pc).toFixed(1)), abs: true, round: 1, source_path: "fuel.json", derive: { op: "pct_change", args: [{ source_path: "fuel.json", source_rev: r.sha, json_pointer: "/petrol95" }, { source_path: "fuel.json", json_pointer: "/petrol95" }] } }),
      ]) };
    }
    break;
  }
  if (!change) note = revs.length < 2 ? (shallow ? `fuel.json has ${revs.length} version(s) in this shallow checkout: clone with --depth 200 to get last month's price` : "fuel.json has a single version") : "no earlier month with a different price in the available history (the file history may start this month)";
  ideas.push({
    id: `fuel-${F.month}`, kind: "fuel", pillar_hint: "Efficiency/compare", data_month: F.month, checked: F.checked, source_url: F.source,
    title: change ? `מחיר הדלק ב-${F.month}: ${change.to > change.from ? "עלייה" : "ירידה"}` : `מחיר הדלק ב-${F.month}`,
    angle: "Efficiency: what the monthly price means per 1,000 km for two common models (only with consumption figures that exist in the app's data); a compare-two-cars carousel without declaring a winner.",
    facts: facts(fl), change, history_note: note, cautions,
  });
}

// 4. notable models: market.json (new-car deliveries per month) and model/stats.json (fleet on the road)
{
  const M = J("market.json");
  dataAsOf = M.updated || null;
  const months = Object.keys(M.months).sort(), last = months[months.length - 1];
  const lastYear = String(Number(last.slice(0, 4)) - 1) + last.slice(4);
  const fl = [fact({ text: `נמסרו ${fmt(M.months[last])} רכבים פרטיים חדשים ב-${last.slice(4)}/${last.slice(0, 4)}`, value: M.months[last], source_path: "market.json", json_pointer: `/months/${last}` })];
  if (M.months[lastYear]) {
    fl.push(fact({ text: `לעומת ${fmt(M.months[lastYear])} רכבים פרטיים חדשים שנמסרו ב-${lastYear.slice(4)}/${lastYear.slice(0, 4)}`, value: M.months[lastYear], source_path: "market.json", json_pointer: `/months/${lastYear}` }));
    const pct = (M.months[last] - M.months[lastYear]) / M.months[lastYear] * 100;
    fl.push(fact({ text: `${pct < 0 ? "ירידה" : "עלייה"} של כ-${Math.abs(Math.round(pct))}% במסירות רכבים פרטיים חדשים (${last.slice(4)}/${last.slice(0, 4)} לעומת ${lastYear.slice(4)}/${lastYear.slice(0, 4)})`, value: Math.abs(Math.round(pct)), abs: true, round: 0, source_path: "market.json", derive: { op: "pct_change", args: [{ source_path: "market.json", json_pointer: `/months/${lastYear}` }, { source_path: "market.json", json_pointer: `/months/${last}` }] } }));
  }
  const top = Object.entries(M.models).filter(([, v]) => v[last]).sort((a, b) => b[1][last] - a[1][last]).slice(0, 5);
  for (const [k, v] of top) fl.push(fact({ text: `${k.replace("|", " ")}: ${fmt(v[last])} מסירות ב-${last.slice(4)}/${last.slice(0, 4)}`, value: v[last], source_path: "market.json", json_pointer: `/models/${k.replace(/~/g, "~0").replace(/\//g, "~1")}/${last}` }));
  ideas.push({
    id: `market-${last}`, kind: "market", pillar_hint: "B2B utility", data_updated: M.updated,
    title: `שוק הרכב החדש ב-${last.slice(4)}/${last.slice(0, 4)}: מסירות והדגמים המובילים`,
    angle: "Market intel for dealers/trade-in (B2B utility): monthly deliveries and the top models; or Community: 'guess the top model' quiz story (phone only). Ranking by deliveries is a fact, not a recommendation: never call a model 'the best'.",
    facts: facts(fl), cautions: ["Deliveries are not sales quality or satisfaction; avoid 'winner' wording.", "Scope: market.json counts new PRIVATE cars (sug_degem P): write 'רכבים פרטיים חדשים'."],
  });
  const S = J("model/stats.json");
  dataAsOf = S.updated;
  const fleet = [...S.models].sort((a, b) => b.act - a.act).slice(0, 5);
  ideas.push({
    id: "fleet-top-models", kind: "models", pillar_hint: "Community", data_updated: S.updated,
    title: "הדגמים הנפוצים ביותר על הכביש",
    angle: "Community: 'which of these do you drive?' poll (phone only), then the numbers. Neutral, no ranking language beyond counts.",
    facts: facts(fleet.map(m => fact({ text: `${m.label} ${m.disp}: ${fmt(m.act)} רכבים פעילים`, value: m.act, source_path: "model/stats.json", json_pointer: `/models/[slug=${m.slug}]/act` }))),
    cautions: [],
  });
}

// 6. what changed in the app: android/release-notes.txt per released version (the Play "what's new" text, written by every release), from
// git history, versions of the last 14 days, newest first. Feature lines carry no facts: copy describes the feature as the line does.
{
  const NOTES = "android/release-notes.txt", seen = new Set(), cut = Date.parse(now) - 14 * 86400e3;
  for (const r of gitRevs(NOTES, 40)) {
    if (Date.parse(r.date) < cut || seen.size >= 3) break;
    let txt; try { txt = execFileSync("git", ["-C", repo, "show", `${r.sha}:${NOTES}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { continue; }
    const lines = txt.split("\n"), ver = ((lines[0] || "").match(/^#\s*(\d+\.\d+)/) || [])[1];
    if (!ver || seen.has(ver)) continue;
    seen.add(ver);
    const features = lines.slice(1).map(l => l.trim()).filter(l => l && !l.startsWith("#")).map(l => l.replace(/^[•\-*]\s*/, ""));
    if (!features.length) continue;
    ideas.push({
      id: `product-${ver}`, kind: "product", pillar_hint: "Trust & Safety", date: r.date.slice(0, 10), version: ver,
      title: `מה חדש בלוחית ${ver}`, features,
      angle: "Product news: one user-visible feature per story or reel (a screen recording with a demo plate), CTA to install. Phone-only features (alerts, reminders) say 'באפליקציה'. Accuracy lines ('דיוק', 'תוקן') are trust material for the dealer post or a carousel slide, not a headline of their own.",
      facts: [],
      cautions: ["Describe a feature exactly as its line does: no added promises, no 'first in Israel', no numbers (release notes are not facts; a number in copy needs a fact from another idea).",
        "Settlements and recalls: 'ייתכן' / 'בדרך כלל', never 'זכאי' or 'מגיע לכם'.",
        "A version reaches phones only after Google approves it: before the kit's publish dates, check that this version is live in Play (ask Dudu or the release thread)."],
    });
  }
  if (!seen.size) warnings.push(`no app release in the last 14 days (${NOTES} history${shallow ? ", shallow clone" : ""})`);
}

// 5. Search Console top queries (optional, private)
if (gscPath) {
  try {
    const G = JSON.parse(fs.readFileSync(gscPath, "utf8"));
    const abs = path.resolve(gscPath);
    const rows = (G.byQuery || []).slice().sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 15);
    ideas.push({
      id: "gsc-top-queries", kind: "search-console", private: true, pillar_hint: "Community", range: G.range, generated: G.generated,
      title: "What people search before reaching luchit.app (last 28 days)",
      angle: "Pick a topic people already search for (e.g. a check type) and answer it in a carousel/reel. PRIVATE: do not put these numbers in public copy.",
      queries: rows.map(r => ({ query: r.keys[0], clicks: r.clicks, impressions: r.impressions, position: Math.round(r.position * 10) / 10 })),
      // every number of the snapshot is private (clicks, impressions, position): the lint fails any copy number that equals one of them
      // in a search context, or that has no other fact
      facts: (dataAsOf = G.generated ? String(G.generated).slice(0, 10) : null, facts(rows.flatMap(r => {
        const ptr = `/byQuery/[keys.0=${r.keys[0].replace(/~/g, "~0").replace(/\//g, "~1")}]`;
        const pos = Math.round(r.position * 10) / 10;
        return [
          fact({ text: `"${r.keys[0]}": ${r.clicks} קליקים בחיפוש`, value: r.clicks, private: true, source_path: abs, json_pointer: `${ptr}/clicks` }),
          fact({ text: `"${r.keys[0]}": ${r.impressions} הופעות בחיפוש`, value: r.impressions, private: true, source_path: abs, json_pointer: `${ptr}/impressions` }),
          fact({ text: `"${r.keys[0]}": מיקום ${pos} בחיפוש`, value: pos, round: 1, private: true, source_path: abs, json_pointer: `${ptr}/position` }),
        ];
      }))),
      cautions: ["Private Search Console data: topics only, no numbers in copy."],
    });
  } catch (e) { warnings.push("Search Console file: " + e.message); }
}

// 7. news of the week: settlements that are new or changed in settlements.json (main, git history) and recall campaigns that are new in
// the catalogue (branch catalog-data, r/<maker>.json). Angle "check your car": neutral, the importer is the one who fixes, never a villain.
let recallMaxId = null;
{
  const SP = "settlements.json", cut = Date.parse(now) - Number(process.env.IDEAS_NEWS_DAYS || 7) * 86400e3;   // IDEAS_NEWS_DAYS: tests only
  if (fs.existsSync(path.join(repo, SP))) {
    const cur = J(SP), revs = gitRevs(SP, 60), base = revs.find(r => Date.parse(r.date) <= cut);
    const prev = base ? atRev(base.sha, SP) : null;
    if (!prev) warnings.push(`${SP}: no version older than 7 days in this checkout${shallow ? " (shallow clone: git -C <repo> fetch -q --deepen 200)" : ""}: settlement news skipped`);
    else {
      const old = new Map(prev.items.map(x => [x.id, x])), KEYS = ["t", "b", "cond", "until", "st", "m", "md", "color", "age"];
      const items = cur.items.flatMap(x => {
        const o = old.get(x.id);
        const changed = o ? KEYS.filter(k => JSON.stringify(o[k]) !== JSON.stringify(x[k])) : null;
        if (o && !changed.length) return [];
        if (x.st && x.st !== "ok") return [];   // only settlements the app shows as open
        dataAsOf = cur.updated || cur.checked || null;
        const ns = numbersIn(x.b || "");
        return [{ id: x.id, change: o ? "changed" : "new", changed_fields: changed || undefined, maker: x.mk, models: x.md, title: x.t, benefit: x.b, conditions: x.cond,
          until: x.until, url: x.url, facts: facts(ns.map((n, i) => fact({ text: `${x.mk}, ${x.t}: ${(x.b || "").slice(Math.max(0, n.index - 20), n.index + n.raw.length + 6).trim()}`,
            value: n.value, source_path: SP, json_pointer: `/items/[id=${x.id}]/b`, number_index: i }))) }];
      });
      if (items.length) ideas.push({
        id: `news-settlements-${String(cur.updated || now).slice(0, 10)}`, kind: "news-settlements", pillar_hint: "Trust & Safety",
        since: base.date.slice(0, 10), since_rev: base.sha, data_updated: cur.updated, items,
        title: "הסדרי פשרה חדשים או מעודכנים השבוע",
        angle: "Check your car: one story or the dealer post per settlement ('יש לכם <דגם> משנים X-Y? בדקו בלוחית אם ייתכן שמגיעה הטבה'), CTA to enter the plate. The benefit text quotes the settlement as written.",
        cautions: ["The importer is a customer: a settlement is a benefit the importer gives, never 'נתפסו' / 'הודו' / 'נאלצו'. No court drama.",
          "Write 'ייתכן שמגיעה הטבה' / 'ההטבה תלויה בהתאמה לרכב', never 'מגיע לכם' / 'זכאים'.",
          "Numbers only from this idea's facts (the benefit amounts); dates and model years as written in the settlement.",
          "A 'changed' item can be a data fix (changed_fields such as age or m): it is news only when the benefit, the cars or the end date really changed for the owner."],
      });
      else warnings.push(`no new or changed open settlement since ${base.date.slice(0, 10)}`);
    }
  }
  if (!catalogPath) warnings.push("no --catalog <catalog-data checkout>: recall news skipped (git clone -q --depth 1 -b catalog-data https://github.com/ddsabag/vehicle-app $WORK/catalog)");
  else {
    const dir = path.join(catalogPath, "r");
    let rows = [];
    try { for (const f of fs.readdirSync(dir)) if (f.endsWith(".json")) rows.push(...(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).rows || [])); }
    catch (e) { warnings.push(`catalog r/: ${e.message}`); }
    let state = null; try { state = JSON.parse(fs.readFileSync(path.join(catalogPath, "recall-state.json"), "utf8")); } catch {}
    const byId = new Map();
    for (const r of rows) { const k = r.RECALL_ID; if (!byId.has(k)) byId.set(k, r); }
    recallMaxId = byId.size ? Math.max(...byId.keys()) : null;
    // baseline: --recall-since, else the last kit's recall_max_id in rotation.json
    let since = opt("--recall-since") != null ? Number(opt("--recall-since")) : null;
    if (since == null) { try { const R = JSON.parse(fs.readFileSync(new URL("./rotation.json", import.meta.url), "utf8")); since = [...(R.history || [])].reverse().find(h => h.recall_max_id)?.recall_max_id ?? null; } catch {} }
    if (since == null) warnings.push(`recall news: no baseline yet (first run). Record "recall_max_id": ${recallMaxId} in this kit's rotation.json history entry; next week's kit gets the recalls added after it.`);
    else {
      const fresh = [...byId.values()].filter(r => r.RECALL_ID > since)
        .sort((a, b) => (a.TKINA_EU === "M1" ? 0 : 1) - (b.TKINA_EU === "M1" ? 0 : 1) || b.RECALL_ID - a.RECALL_ID);
      if (!fresh.length) warnings.push(`recall news: no recall campaign added to the catalogue after RECALL_ID ${since}`);
      else ideas.push({
        id: `news-recalls-${since}-${recallMaxId}`, kind: "news-recalls", pillar_hint: "Trust & Safety", since_recall_id: since, catalog_updated: state && state.u,
        title: "ריקולים חדשים שנוספו השבוע לרשימת משרד התחבורה",
        recalls: fresh.slice(0, 12).map(r => ({ recall_id: r.RECALL_ID, maker: r.TOZAR_TEUR, models: r.DEGEM, category: r.TKINA_EU, fault: r.TEUR_TAKALA, fix: r.OFEN_TIKUN,
          built: [r.BUILD_BEGIN_A, r.BUILD_END_A], importer: r.YEVUAN_TEUR, importer_site: r.WEBSITE })),
        more: Math.max(0, fresh.length - 12),
        angle: "Check your car: 'יש לכם <יצרן> <דגם>? נפתח ריקול חדש. מקלידים את מספר הרישוי ורואים אם הרכב שלכם ברשימה, ובכרטיס הריקול יש כפתור לבדיקה באתר היבואן.' One recall per story or one carousel of 3-5 private-car (M1) recalls.",
        facts: [],
        cautions: ["The catalogue is not in the main checkout, so these have no facts: no numbers in copy (no counts, no build years as numbers); name the maker, model and the fault as the ministry wrote it.",
          "Neutral: the manufacturer recalls, the importer fixes, 'בדרך כלל ללא עלות'. Never 'מסוכן', 'אסור לנסוע', or blame on an importer or dealer.",
          "A recall applies to cars built in a range: say 'בדקו אם הרכב שלכם ברשימה', never 'כל רכבי <דגם>'.",
          ...(state && state.status && state.status !== "ok" ? [`recall-state status is "${state.status}": the ministry list may lag (recalls after its horizon are not known yet). Do not claim a car has no recall.`] : [])],
      });
    }
  }
}

// 8. what worked: app opens per campaign topic and network (optional, private, the measurement thread's weekly encrypted snapshot of
// link_open camp/via, decrypted like seo-data). Topics only: it ranks what to make next, never a number in copy.
if (campPath) {
  try {
    const C = JSON.parse(fs.readFileSync(campPath, "utf8"));
    const abs = path.resolve(campPath);
    // measurement's camp-data: topics[] {camp, opens:[7d,28d], appOpens, landings, checks, installs (each [7d,28d]), via:{network: 28d opens}}
    const T = (C.topics || []).filter(t => t.camp && Array.isArray(t.opens)).slice(0, 15);
    dataAsOf = C.generated ? String(C.generated).slice(0, 10) : null;
    const M = ["opens", "checks", "installs"], HE = { opens: "פתיחות", checks: "בדיקות רכב", installs: "התקנות" };
    ideas.push({
      id: "camp-topics", kind: "campaign-results", private: true, ranges: C.ranges, generated: C.generated,
      title: "Which topics brought opens, car checks and installs (7 and 28 days)",
      angle: "Rank this week's topics by car checks and installs, not only opens: repeat the angle of the top topics in a new form, drop topics that brought nothing two weeks running. PRIVATE: never in copy.",
      ranking: T.map(t => ({ camp: t.camp, opens_7d: t.opens[0], opens_28d: t.opens[1], checks_7d: (t.checks || [])[0], installs_7d: (t.installs || [])[0], via: t.via })),
      facts: facts(T.flatMap(t => M.flatMap(m => (t[m] || []).slice(0, 2).map((v, i) => fact({ text: `נושא ${t.camp}: ${v} ${HE[m]} ב-${i ? 28 : 7} ימים`, value: v, private: true,
        source_path: abs, json_pointer: `/topics/[camp=${t.camp}]/${m}/${i}` }))))),
      cautions: ["Private analytics: topics only, no numbers in copy.", "A topic with few posts is not a loser yet: compare opens per post when the snapshot gives posts."],
    });
  } catch (e) { warnings.push("campaign snapshot: " + e.message); }
}

const out = { generated: now, repo: { path: path.resolve(repo), commit: head.sha, commit_date: head.date, shallow }, recall_max_id: recallMaxId, count: ideas.length, ideas, dropped_facts: dropped, warnings };
const txt = JSON.stringify(out, null, 1);
if (outPath) fs.writeFileSync(outPath, txt + "\n");
process.stdout.write(txt + "\n");
