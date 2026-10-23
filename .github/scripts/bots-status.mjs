// The bots board for the live dashboard: for every scheduled workflow (and the deploys), its latest run on main, and how often it is meant
// to run. Written as the "bots" metric on the flashes branch (metrics.json), which /live reads; the page decides ok / late / failed.
// Public-safe: workflow names, times, conclusions and run links only (the repository is public anyway).
// Runs from Live watch every 30 minutes. Never fails its job: any error is one log line.
//   node bots-status.mjs            write the board (needs GITHUB_TOKEN with actions: read, contents: write, and GITHUB_REPOSITORY)
//   node bots-status.mjs selftest   check the cron arithmetic offline
import fs from "node:fs";
import { putMetric } from "./flash.mjs";

const DIR = ".github/workflows", EXTRA = ["workers-deploy.yml", "ship-tail.yml"];   // run on a push, not a clock: shown, never "late"

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

function workflows() {
  return fs.readdirSync(DIR).filter(f => f.endsWith(".yml")).map(f => {
    const y = fs.readFileSync(DIR + "/" + f, "utf8"), name = (/^name:\s*(.+)$/m.exec(y) || [])[1];
    const crons = [...y.matchAll(/^\s*-\s*cron:\s*["']([^"']+)["']/gm)].map(m => m[1]);
    return { f, n: name ? name.trim().replace(/^["']|["']$/g, "") : f, p: maxGap(crons) };
  }).filter(w => w.p || EXTRA.includes(w.f));
}

async function latest(f) {
  const r = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/actions/workflows/${f}/runs?branch=main&per_page=5&exclude_pull_requests=true`,
    { headers: { ...(process.env.GITHUB_TOKEN ? { authorization: "Bearer " + process.env.GITHUB_TOKEN } : {}), accept: "application/vnd.github+json", "user-agent": "luchit-bots" }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(f + " " + r.status);
  const runs = (await r.json()).workflow_runs || [], done = runs.find(x => x.status === "completed");
  // c: success | failure | cancelled | timed_out | skipped (switched off by its own condition) | none (never ran on main)
  return done ? { c: done.conclusion || "none", t: done.updated_at, u: done.html_url, run: runs[0].status !== "completed" ? 1 : 0 } : { c: "none", run: runs.length ? 1 : 0 };
}

if (process.argv[2] === "selftest") {
  const eq = (a, b, m) => { if (a !== b) { console.error("FAIL", m, a, "!=", b); process.exit(1); } };
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
  console.log("selftest ok");
} else {
  try {
    const list = [];
    for (const w of workflows()) { try { list.push({ ...w, ...(await latest(w.f)) }); } catch (e) { list.push({ ...w, c: "unread" }); console.log("bots: " + e.message); } }
    console.log(list.map(x => `${x.n}: ${x.c} ${x.t || ""}`).join("\n"));
    if (process.env.BOTS_JSON) fs.writeFileSync(process.env.BOTS_JSON, JSON.stringify(list));   // a local copy, for testing the page
    if (process.env.DRY !== "1") console.log((await putMetric("bots", { list })) ? "bots board written" : "bots board not written");
  } catch (e) { console.log("bots board skipped:", e.message || e); }
}
