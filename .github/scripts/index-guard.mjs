// Index guard (called by seo-data.mjs after the daily URL Inspection): compares today's index state of the sitemap URLs with the last
// clean baseline (metric "index" in metrics.json on the flashes branch, field base) and says when Google dropped pages. Two rules:
//   1. of the pages indexed (verdict PASS) in the baseline and inspected again today, 10% or more are no longer indexed (base of 20 or more);
//   2. a key page (home, /check/*, /magazine/*) that was indexed is now inspected and not indexed.
// Only sitemap URLs count (EXTRA_URLS of a manual run are left out), and a page that left the sitemap is not a drop.
// A run is compared only when it is clean: a sitemap was read, every URL inspected, few API errors, and the sitemap is not much smaller than
// the baseline's (a failed or cut-off sitemap fetch looks like that). Only a clean run becomes the next baseline and has its numbers published
// (clean in the result); otherwise the old one stays. A much smaller sitemap is marked (shrunk, kept on the stored metric) and taken as the new
// size when the next complete run sees it too: pages that left the sitemap are never a drop, so that run is compared and becomes the baseline.
// "Crawled, not indexed" and "unknown to Google" swap places from day to day for the same URLs in the API, so they are not compared.
// metrics.json is public: key pages are stored as paths, every other indexed page only as a short hash of its path.
//   node index-guard.mjs selftest      offline
import { createHash } from "node:crypto";
export const DROP = 0.1, MIN_BASE = 20, MAX_ERRORS = 5, SHRINK = 0.9;
export const KEY = p => p === "/" || /^\/(check|magazine)\//.test(p);
export const pathOf = u => { try { return new URL(u).pathname; } catch { return String(u); } };
const h12 = s => createHash("sha1").update(String(s)).digest("hex").slice(0, 12);
export const idOf = p => (KEY(p) ? p : h12(p));

// prev: the stored metric or null (only when there is none: an unreadable one is not compared at all). now: {sitemap: [urls],
// inspection: [{url, verdict, coverage} | {url, error}], errors: [...]}, at: ISO date
export function compare(prev, now, at = "") {
  const sm = [...new Set(now.sitemap || [])], inSm = new Set(sm);
  const byUrl = new Map(); for (const i of now.inspection || []) if (inSm.has(i.url) && !byUrl.has(i.url)) byUrl.set(i.url, i);
  const done = [...byUrl.values()].filter(i => !i.error);
  const passIds = [...new Set(done.filter(i => i.verdict === "PASS").map(i => idOf(pathOf(i.url))))].sort();
  const base = prev && prev.base && Array.isArray(prev.base.pass) && prev.base.n > 0 ? prev.base : null;
  const out = (skipped, alerts = [], clean = false, shrunk = 0) => ({ indexed: passIds.length, inspected: done.length, total: sm.length, alerts, skipped,
    clean, ...(shrunk ? { shrunk } : {}), base: clean ? { at, n: sm.length, pass: passIds } : base });
  if (!sm.length) return out("no sitemap URLs (the sitemap could not be read)");
  if (done.length !== sm.length || (now.errors || []).length > MAX_ERRORS) return out("this run is incomplete");
  if (base && sm.length < base.n * SHRINK && !prev.shrunk) return out(`the sitemap has ${sm.length} URLs, the baseline ${base.n}: not compared until the next run sees it too`, [], false, sm.length);
  if (!base) return out("no clean baseline yet", [], true);
  const nowById = new Map(done.map(i => [idOf(pathOf(i.url)), i]));
  const lost = base.pass.filter(id => nowById.has(id) && nowById.get(id).verdict !== "PASS");
  const still = base.pass.filter(id => nowById.has(id)).length, alerts = [];
  if (still >= MIN_BASE && lost.length >= still * DROP) alerts.push({ kind: "drop", lost: lost.length, of: still, indexed: passIds.length });
  const key = lost.filter(id => id.startsWith("/")).map(p => ({ path: p, coverage: nowById.get(p).coverage || "" }));
  if (key.length) alerts.push({ kind: "key", lost: key });
  return out(null, alerts, true);
}

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function message(alerts, link = "") {
  const lines = ["⚠️ <b>גוגל הוציא דפים מהאינדקס</b>", ""];
  for (const a of alerts) {
    if (a.kind === "drop") lines.push(`${a.lost} מתוך ${a.of} הדפים שהיו באינדקס כבר לא בו (${Math.round(a.lost / a.of * 100)}%). כרגע באינדקס: ${a.indexed}.`);
    if (a.kind === "key") {
      lines.push("דפים חשובים שיצאו מהאינדקס:");
      for (const l of a.lost.slice(0, 10)) lines.push(`• ${l.path === "/" ? "דף הבית" : esc(l.path)}${l.coverage ? ` (${esc(l.coverage)})` : ""}`);
      if (a.lost.length > 10) lines.push(`ועוד ${a.lost.length - 10}.`);
    }
  }
  lines.push("", "כדאי לבדוק ב-Search Console, במסך Pages, אם יש שגיאה או שינוי באתר.");
  if (link) lines.push(`<a href="${esc(link)}">Search Console</a>`);
  return lines.join("\n");
}
// a short stable id of what the alert says, for the alert router key (the same news is not sent twice within a day, new news is)
export const alertId = alerts => {
  const id = h12(JSON.stringify(alerts.map(a => (a.kind === "key" ? ["key", a.lost.map(l => l.path)] : ["drop", a.lost, a.of]))));
  return /[a-f]/.test(id) ? id : "a" + id.slice(1);   // the router reads an all-digit segment as a number and refuses the key
};

if (process.argv[1] && process.argv[1].endsWith("index-guard.mjs") && process.argv[2] === "selftest") {
  let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
  const U = p => "https://luchit.app" + p, I = (p, v = "PASS", c = "") => ({ url: U(p), verdict: v, coverage: c });
  const paths = Array.from({ length: 30 }, (_, k) => `/model/m${k}/`).concat(["/", "/check/recall/", "/magazine/x/"]);
  const sitemap = paths.map(U), base = paths.map(p => I(p));
  const run = (prev, inspection, extra = {}) => compare(prev, { sitemap, inspection, errors: [], ...extra }, "2026-10-19");
  const day0 = run(null, base);
  ok(day0.skipped === "no clean baseline yet" && day0.clean && day0.base && day0.base.pass.length === 33 && day0.alerts.length === 0, "first run makes the baseline");
  ok(day0.base.pass.includes("/check/recall/") && !day0.base.pass.some(id => id.startsWith("/model/")), "key pages in clear, others hashed");
  const prev = { indexed: 33, inspected: 33, total: 33, base: day0.base };
  ok(run(prev, base).alerts.length === 0 && run(prev, base).clean, "same state: no alert, published");
  const lose = n => base.map((i, k) => (k < n ? { ...i, verdict: "NEUTRAL", coverage: "נסרק אך לא נכלל באינדקס" } : i));
  let r = run(prev, lose(4));
  ok(r.alerts.length === 1 && r.alerts[0].kind === "drop" && r.alerts[0].lost === 4 && r.alerts[0].of === 33, "4 of 33 lost: drop alert");
  ok(run(prev, lose(3)).alerts.length === 0, "3 of 33 lost (9%): no alert");
  const plus = [...lose(4), ...Array.from({ length: 10 }, (_, k) => I(`/model/new${k}/`))];
  ok(run(prev, plus, { sitemap: [...sitemap, ...Array.from({ length: 10 }, (_, k) => U(`/model/new${k}/`))] }).alerts.some(a => a.kind === "drop"), "new pages do not hide lost ones");
  const key = base.map(i => (i.url.endsWith("/check/recall/") ? { ...i, verdict: "NEUTRAL", coverage: "כתובת האתר לא ידועה ל-Google" } : i));
  r = run(prev, key);
  ok(r.alerts.length === 1 && r.alerts[0].kind === "key" && r.alerts[0].lost[0].path === "/check/recall/", "key page lost: alert");
  ok(message(r.alerts, "https://x.example/").includes("/check/recall/") && message(r.alerts).includes("לא ידועה"), "message names the page and its state");
  ok(alertId(r.alerts) === alertId(run(prev, key).alerts) && alertId(r.alerts) !== alertId(run(prev, lose(4)).alerts), "alert id: same news same id");
  // false-alarm cases found in review
  r = run(prev, [], { sitemap: [] });
  ok(r.alerts.length === 0 && r.skipped && r.base === prev.base && !r.clean && !r.shrunk, "empty sitemap: no alert, baseline kept, nothing published");
  r = run(prev, base.slice(0, 20));
  ok(r.alerts.length === 0 && r.skipped && r.base === prev.base && !r.clean, "cut-short run: no alert, baseline kept, nothing published");
  r = run(prev, base.map((i, k) => (k === 0 ? { url: i.url, error: true } : i)));
  ok(r.skipped && r.base === prev.base && !r.clean, "an errored URL makes the run incomplete");
  const shr = lose(10).slice(0, 25), ssm = sitemap.slice(0, 25);
  r = run(prev, shr, { sitemap: ssm });
  ok(r.skipped && r.skipped.includes("sitemap") && !r.clean && r.shrunk === 25 && r.base === prev.base && !r.alerts.length, "a much smaller sitemap is not compared, only marked");
  r = run({ ...prev, shrunk: 25 }, shr, { sitemap: ssm });
  ok(!r.skipped && r.clean && r.base.n === 25 && r.alerts.some(a => a.kind === "drop" && a.lost === 10 && a.of === 25), "the same smaller sitemap on the next run: compared and the new baseline");
  r = run({ ...prev, shrunk: 25 }, base);
  ok(!r.skipped && r.clean && r.base.n === 33 && !r.shrunk && !r.alerts.length, "the full sitemap back after a mark: compared as usual");
  const extras = [...base, I("/check/recall/", "NEUTRAL"), { url: "https://www.luchit.app/", verdict: "NEUTRAL", coverage: "דף עם הפניה" }, I("/model/m1/"), I("/model/m2/")];
  ok(run(prev, extras).alerts.length === 0, "EXTRA_URLS duplicates and www variants are ignored");
  const day1 = run(prev, extras), next = run({ ...prev, base: day1.base }, base);
  ok(day1.indexed === 33 && next.alerts.length === 0, "a manual run with extras does not inflate the baseline");
  const gone = base.slice(4), gsm = sitemap.slice(4);
  ok(run(prev, gone, { sitemap: gsm }).alerts.length === 0, "pages that left the sitemap are not a drop");
  const small = run(null, base.slice(0, 10), { sitemap: sitemap.slice(0, 10) });
  ok(run({ base: small.base }, base.slice(0, 10).map((i, k) => (k < 5 ? { ...i, verdict: "NEUTRAL" } : i)), { sitemap: sitemap.slice(0, 10) }).alerts.length === 0, "below 20 indexed: no drop alert");
  ok(run({ indexed: 33, inspected: 33, total: 33, pass: ["/"] }, lose(4)).skipped === "no clean baseline yet", "an old metric without base starts a baseline");
  ok(/[a-f]/.test(alertId([{ kind: "drop", lost: 1, of: 2 }])), "alert id holds a letter");
  ok(KEY("/") && KEY("/check/") && KEY("/magazine/recalls-2026-10/") && !KEY("/model/x/") && !KEY("/brand/x/"), "key pages");
  console.log(bad ? `${bad} failed` : "selftest ok");
  process.exit(bad ? 1 : 0);
}
