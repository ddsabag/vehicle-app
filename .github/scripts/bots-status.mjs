// The bots board for the live dashboard: for every scheduled workflow (and the deploys), its latest run on main, how often it is meant to
// run (and when, in Israel time), its Hebrew name (bot-names.json, the same name Telegram uses) and whether GitHub has it switched off.
// Written as the "bots" metric on the flashes branch (metrics.json), which /live reads; the page decides ok / late / failed.
// Public-safe: workflow names, times, conclusions and run links only (the repository is public anyway).
// Runs from Live watch every 30 minutes. Never fails its job: any error is one log line.
//   node bots-status.mjs            write the board (needs GITHUB_TOKEN with actions: read, contents: write, and GITHUB_REPOSITORY)
//   node bots-status.mjs selftest   check the cron arithmetic and the schedule words offline, and that every bot has its Hebrew names
import fs from "node:fs";
import { putMetric } from "./flash.mjs";

const DIR = ".github/workflows", EXTRA = ["workers-deploy.yml", "ship-tail.yml"];   // run on a push, not a clock: shown, never "late"
const NAMES = ".github/scripts/bot-names.json", WORKER = "worker/live/worker.js";

// the longest wait between two runs, in minutes, from all of a workflow's cron lines (GitHub runs them in UTC), over 62 days from 1.1.2026 so
// monthly lines count too; null when it has none. A workflow with two lines for summer and winter time waits the shorter gap of the pair.
function field(f, lo, hi) {
  const set = new Set();
  for (const part of f.split(",")) {
    const [range, step] = part.split("/"), st = Number(step || 1);
    const [a, b] = range === "*" ? [lo, hi] : range.includes("-") ? range.split("-").map(Number) : [Number(range), step ? hi : Number(range)];
    for (let v = a; v <= b; v += st) set.add(v);
  }
  return set;
}
function maxGap(crons) {
  if (!crons.length) return null;
  const cs = crons.map(c => { const [mi, hr, dom, mo, dow] = c.trim().split(/\s+/); return { mi: field(mi, 0, 59), hr: field(hr, 0, 23), dom: field(dom, 1, 31), domAny: dom === "*", mo: field(mo, 1, 12), dow: field(dow, 0, 6), dowAny: dow === "*" }; });
  const t0 = Date.UTC(2026, 0, 1), fires = [];
  for (let m = 0; m < 62 * 1440; m++) {
    const d = new Date(t0 + m * 60e3), [mi, hr, dd, mo, wd] = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
    // cron's rule: when both day fields are restricted, either one matching is enough
    if (cs.some(c => c.mi.has(mi) && c.hr.has(hr) && c.mo.has(mo) && (c.domAny || c.dowAny ? c.dom.has(dd) && c.dow.has(wd) : c.dom.has(dd) || c.dow.has(wd)))) fires.push(m);
  }
  let g = 0; for (let i = 1; i < fires.length; i++) g = Math.max(g, fires[i] - fires[i - 1]);
  return fires.length > 1 ? g : null;
}

// The schedule in words, Israel time, for the board ("כל יום ב-07:17", "ביום ראשון ב-08:20", "ב-6 בכל חודש ב-10:07", "כל חצי שעה").
// Cron is UTC and Israel moves between UTC+2 and UTC+3, so a clock time is read on the day given (today on the board). Two lines that
// differ by one hour alone are one Israel time written for summer and for winter (the script skips the wrong one): the earlier hour, read in
// summer. Two lines that together cover every day of the month (1 and 2-31) or of the week (1 and 0,2-6) are one daily line.
const DAYS = ["ראשון", "שני", "שלישי", "רביעי", "חמישי", "שישי", "שבת"];
const join = a => a.length > 1 ? a.slice(0, -1).join(", ") + " ו-" + a[a.length - 1] : a[0] || "";
export function schedule(crons, ref = new Date()) {
  const il = (h, mi, summer) => new Date(summer ? Date.UTC(ref.getUTCFullYear(), 6, 15, h, mi) : Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), h, mi)).toLocaleTimeString("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit" });
  const L = crons.map(c => { const [mi, hr, dom, mo, dow] = c.trim().split(/\s+/); return { mi, hr, dom, mo, dow }; }), out = [];
  const fast = L.filter(l => l.hr === "*");
  if (fast.length) { const g = maxGap(fast.map(l => [l.mi, l.hr, l.dom, l.mo, l.dow].join(" "))); out.push(g <= 15 ? "כל רבע שעה" : g <= 30 ? "כל חצי שעה" : g <= 60 ? "כל שעה" : "כל " + g + " דקות"); }
  const rest = L.filter(l => l.hr !== "*"), used = new Set(), items = [];
  rest.forEach((a, i) => { if (used.has(i)) return; used.add(i);
    const j = rest.findIndex((b, k) => k > i && !used.has(k) && b.mi === a.mi && b.dom === a.dom && b.dow === a.dow && /^\d+$/.test(a.hr) && /^\d+$/.test(b.hr) && Math.abs(Number(a.hr) - Number(b.hr)) === 1);
    if (j >= 0) { used.add(j); items.push({ ...a, hr: String(Math.min(Number(a.hr), Number(rest[j].hr))), summer: true }); } else items.push(a); });
  const used2 = new Set(), merged = [], all = (a, b, lo, hi) => new Set([...field(a, lo, hi), ...field(b, lo, hi)]).size === hi - lo + 1;
  items.forEach((a, i) => { if (used2.has(i)) return; used2.add(i);
    const j = items.findIndex((b, k) => k > i && !used2.has(k) && b.mi === a.mi && b.hr === a.hr && !!b.summer === !!a.summer && ((a.dow === "*" && b.dow === "*" && all(a.dom, b.dom, 1, 31)) || (a.dom === "*" && b.dom === "*" && all(a.dow, b.dow, 0, 6))));
    if (j >= 0) { used2.add(j); merged.push({ ...a, dom: "*", dow: "*" }); } else merged.push(a); });
  for (const l of merged) {
    const mi = [...field(l.mi, 0, 59)][0], times = join([...field(l.hr, 0, 23)].sort((a, b) => a - b).map(h => il(h, mi, l.summer)));
    if (l.dom !== "*" && l.dow === "*") out.push("ב-" + join([...field(l.dom, 1, 31)].sort((a, b) => a - b).map(String)) + " בכל חודש ב-" + times);
    else if (l.dow !== "*") { const ds = [...field(l.dow, 0, 6)].sort((a, b) => a - b).map(d => DAYS[d]); out.push((ds.length > 1 ? "בימים " : "ביום ") + join(ds) + " ב-" + times); }
    else out.push("כל יום ב-" + times);
  }
  return out.join(", ");
}

const hebrew = () => { try { return JSON.parse(fs.readFileSync(NAMES, "utf8")); } catch { return {}; } };
function workflows() {
  const he = hebrew();
  return fs.readdirSync(DIR).filter(f => f.endsWith(".yml")).map(f => {
    const y = fs.readFileSync(DIR + "/" + f, "utf8"), name = (/^name:\s*(.+)$/m.exec(y) || [])[1];
    const crons = [...y.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map(m => m[1]), n = name ? name.trim().replace(/^["']|["']$/g, "") : f;
    return { f, n, p: maxGap(crons), w: schedule(crons), ...(he[n] ? { he: he[n] } : {}) };
  }).filter(w => w.p || EXTRA.includes(w.f));
}

const gh = async path => {
  const r = await fetch("https://api.github.com/repos/" + process.env.GITHUB_REPOSITORY + path,
    { headers: { ...(process.env.GITHUB_TOKEN ? { authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}), accept: "application/vnd.github+json", "user-agent": "luchit-bots" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(path.split("?")[0] + " " + r.status);
  return r.json();
};
// which workflows GitHub has switched off (disabled by hand, or by 60 days without a push): { file: "off" }
async function states() {
  const o = {};
  for (const w of (await gh("/actions/workflows?per_page=100")).workflows || []) if (/^disabled/.test(String(w.state || ""))) o[String(w.path || "").split("/").pop()] = "off";
  return o;
}
async function latest(f) {
  const runs = (await gh(`/actions/workflows/${f}/runs?branch=main&per_page=30&exclude_pull_requests=true`)).workflow_runs || [], done = runs.filter(x => x.status === "completed");
  // a run that skipped every job (a push its gate let through with nothing to do) says nothing about the bot: the newest run that did
  // something is its latest, and "skipped" only when there is no other. On 25.10 the daily site test read as "כבוי" after such pushes
  const run = done.find(x => x.conclusion !== "skipped") || done[0];
  // c: success | failure | cancelled | timed_out | skipped (nothing to do) | none (never ran on main)
  return run ? { c: run.conclusion || "none", t: run.updated_at, u: run.html_url, run: runs[0].status !== "completed" ? 1 : 0 } : { c: "none", run: runs.length ? 1 : 0 };
}

if (process.argv[2] === "selftest") {
  const eq = (a, b, m) => { if (a !== b) { console.error("FAIL", m, JSON.stringify(a), "!=", JSON.stringify(b)); process.exit(1); } };
  eq(maxGap(["12,42 * * * *"]), 30, "every 30 min");
  eq(maxGap(["4,19,34,49 * * * *"]), 15, "every 15 min");
  eq(maxGap(["*/10 * * * *"]), 10, "every 10 min");
  eq(maxGap(["5 5 * * *"]), 1440, "daily");
  eq(maxGap(["43 4 * * 0"]), 10080, "weekly");
  eq(maxGap(["7 5 * * 0,2-6", "7 5 * * 1"]), 1440, "daily in two lines");
  eq(maxGap(["40 6,11,17 * * *"]), 780, "three times a day");
  eq(maxGap(["20 5 * * 0", "20 6 * * 0"]), 10020, "weekly, summer and winter time");
  eq(maxGap(["30 5 2-31 * *", "30 5 1 * *"]), 1440, "daily in two lines by day of month");
  eq(maxGap(["7 8 6 * *"]), 31 * 1440, "monthly (January)");
  eq(maxGap([]), null, "no schedule");
  const win = new Date("2026-01-15T12:00:00Z"), sum = new Date("2026-07-15T12:00:00Z");
  eq(schedule(["17 5 * * *"], win), "כל יום ב-07:17", "daily, winter");
  eq(schedule(["17 5 * * *"], sum), "כל יום ב-08:17", "daily, summer");
  eq(schedule(["5 5 * * *", "5 6 * * *"], win), "כל יום ב-08:05", "summer and winter lines, read in winter");
  eq(schedule(["5 5 * * *", "5 6 * * *"], sum), "כל יום ב-08:05", "summer and winter lines, read in summer");
  eq(schedule(["20 5 * * 0", "20 6 * * 0"], win), "ביום ראשון ב-08:20", "weekly, two lines");
  eq(schedule(["12,42 * * * *"], win), "כל חצי שעה", "every 30 min");
  eq(schedule(["4,19,34,49 * * * *"], win), "כל רבע שעה", "every 15 min");
  eq(schedule(["40 6,11,17 * * *"], win), "כל יום ב-08:40, 13:40 ו-19:40", "three times a day");
  eq(schedule(["7 5 * * 0,2-6", "7 5 * * 1"], win), "כל יום ב-07:07", "daily in two lines by weekday");
  eq(schedule(["30 5 2-31 * *", "30 5 1 * *"], win), "כל יום ב-07:30", "daily in two lines by day of month");
  eq(schedule(["47 4 * * *", "17 1 * * 0"], win), "כל יום ב-06:47, ביום ראשון ב-03:17", "daily and a Sunday line");
  eq(schedule(["7 8 6 * *", "30 5 * * 4"], win), "ב-6 בכל חודש ב-10:07, ביום חמישי ב-07:30", "monthly and weekly");
  eq(schedule(["40 4 * * 3"], win), "ביום רביעי ב-06:40", "weekly");
  eq(schedule([]), "", "no schedule");
  // every bot on the board has a Hebrew name for Telegram (bot-names.json, by workflow name) and a line on the board (worker.js BN, by
  // file: name and group), and the two names agree; checked where the files are (the alert router check checks out the whole repository)
  if (fs.existsSync(NAMES) && fs.existsSync(WORKER) && fs.existsSync(DIR)) {
    const he = hebrew(), m = /\bconst BN=(\{[\s\S]*?\});/.exec(fs.readFileSync(WORKER, "utf8")), BN = m ? JSON.parse(m[1]) : null;
    if (!BN) { console.error("FAIL worker.js: no BN map found"); process.exit(1); }
    for (const w of workflows()) {
      if (!he[w.n]) { console.error("FAIL bot-names.json has no Hebrew name for", w.n, "(" + w.f + ")"); process.exit(1); }
      if (!BN[w.f]) { console.error("FAIL worker/live/worker.js BN has no line for", w.f, "(name and group)"); process.exit(1); }
      if (BN[w.f][0] !== he[w.n]) { console.error("FAIL two Hebrew names for", w.f + ":", BN[w.f][0], "(worker.js) and", he[w.n], "(bot-names.json)"); process.exit(1); }
    }
  }
  console.log("selftest ok");
} else {
  try {
    const list = [], off = await states().catch(e => { console.log("bots: states " + e.message); return {}; });
    for (const w of workflows()) { try { list.push({ ...w, ...(await latest(w.f)), ...(off[w.f] ? { s: "off" } : {}) }); } catch (e) { list.push({ ...w, c: "unread" }); console.log("bots: " + e.message); } }
    console.log(list.map(x => `${x.n}: ${x.c}${x.s ? " (" + x.s + ")" : ""} ${x.t || ""} · ${x.w || "on push"}`).join("\n"));
    if (process.env.BOTS_JSON) fs.writeFileSync(process.env.BOTS_JSON, JSON.stringify(list));   // a local copy, for testing the page
    if (process.env.DRY !== "1") console.log((await putMetric("bots", { list })) ? "bots board written" : "bots board not written");
  } catch (e) { console.log("bots board skipped:", e.message || e); }
}
