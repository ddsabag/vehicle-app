// The live goals engine's selftest and backtest (/live, CEO spec 5.11.2026). The engine is a block of worker/live/worker.js (one file: the
// Workers deploy uploads it without bundling), between "==== live goals engine (begin) ====" and "(end)"; this reads that block and runs it.
//   node .github/scripts/goals-check.mjs selftest            rules on made-up weeks (no real numbers), exit 1 on a failure
//   node .github/scripts/goals-check.mjs backtest <rows.json> [today]   runs the real weeks through the rules and prints what they would set
//     (rows.json: { "YYYY-MM-DD" (a Sunday): { metric: { v } | { x, n } | ... } }, private: never in the repository or a public log)
import fs from "node:fs";
const SRC = process.env.W_JS || new URL("../../worker/live/worker.js", import.meta.url);
export function engine(src = fs.readFileSync(SRC, "utf8")) {
  const m = /\/\/ ==== live goals engine \(begin\) ====[\s\S]*?\/\/ ==== live goals engine \(end\) ====/.exec(src);
  if (!m) throw new Error("the live goals block is missing from worker.js");
  return new Function(m[0] + "\nreturn { G_START, G_LAUNCH, G_REC, G_BY, G_PLAN, G_RE, G_GATEL, gTick, gView, gRate, gTarget, gWilson, gPois, gSun, gAdd, gMed };")();
}
const E = engine();
let fails = 0;
const ok = (c, what) => { if (!c) { fails++; console.log("FAIL", what); } };
const near = (a, b, tol = .01) => a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));
function selftest() {
  const { gView, gRate, gSun, gAdd } = E;
  // the rules of the engine itself, without the one-time re-anchors (G_RE), which have their own checks below
  const gTick = (p, r, t, a, m, u) => E.gTick(p, r, t, a, m, u, []);
  ok(gSun("2026-11-05") === "2026-11-01" && gSun("2026-11-08") === "2026-11-08", "weeks start on Sunday");
  // the plan's slope: about 5% a week until March, about 4% after (base band of the car checks)
  const r1 = gRate("weekly_checks", "base", "2026-11-14"), r2 = gRate("weekly_checks", "base", "2027-05-01");
  ok(r1 > 1.04 && r1 < 1.055, "checks slope until March ~4.6%: " + r1);
  ok(r2 > 1.03 && r2 < 1.045, "checks slope after March ~3.7%: " + r2);
  ok(gRate("weekly_checks", "opt", "2026-11-14") > r1, "the high band is steeper");
  // made-up weeks (not our numbers): 3 weeks of checks before the start, the anchor is their median
  const W = (o, w) => ({ [w]: o });
  let rows = { ...W({ checks: { v: 1000 }, installs: { v: 100 }, d1: { x: 20, n: 200 }, save1: { x: 40, n: 200 }, share: { x: 10, n: 1000 }, fail: { x: 10, n: 1000 } }, "2026-10-18"),
    ...W({ checks: { v: 800 }, installs: { v: 80 }, d1: { x: 30, n: 200 }, save1: { x: 50, n: 200 }, share: { x: 5, n: 800 }, fail: { x: 8, n: 800 } }, "2026-10-25"),
    ...W({ checks: { v: 900 }, installs: { v: 90 }, d1: { x: 10, n: 50 }, save1: { x: 45, n: 180 }, share: { x: 9, n: 900 }, fail: { x: 30, n: 900 } }, "2026-11-01") };
  let st = gTick(null, rows, "2026-11-08", {}, "live");
  let g = st.g.checks;
  ok(g.a === 900 && g.aw === "2026-11-01" && g.b === "base", "first anchor = median of 3 weeks, base band: " + g.a);
  const t1 = E.gTarget(g, E.G_BY.checks, "2026-11-08");
  ok(near(t1, 900 * gRate("weekly_checks", "base", "2026-11-14")), "week 8.11 target = anchor x one week of the plan's slope: " + t1);
  ok(st.g.checks.j["2026-11-01"][2] === "cal", "the week before the start has no target");
  // d1 is lagged: on 8.11 its anchor uses weeks up to 25.10; current = pooled 2 weeks = 50/400 = 12.5%; target = 12.5 + (22.5-12.5)/4 = 15
  ok(near(st.g.d1.T, 15), "ratio target = current + a quarter of the gap: " + st.g.d1.T);
  // save1: best held + 1 point. Pooled 3 weeks = 135/580 = 23.28% -> 24.28
  ok(near(st.g.save1.T, 100 * 135 / 580 + 1), "no outside bar: best held + 1 point: " + st.g.save1.T);
  // fail: 30/900 = 3.33% > 3, interval low (Wilson) about 2.5 <= 3 -> amber, not red
  ok(st.g.fail.j["2026-11-01"][2] === "warn", "a health bar crossed inside the noise is amber: " + JSON.stringify(st.g.fail.j["2026-11-01"]));
  // the next weeks: on target, then below
  rows = { "2026-11-08": { checks: { v: 950 }, installs: { v: 95 } }, "2026-11-15": { checks: { v: 700 }, installs: { v: 60 } } };
  st = gTick(st, rows, "2026-11-22", {}, "live");
  ok(st.g.checks.j["2026-11-08"][2] === "ok", "950 vs ~941 is green: " + JSON.stringify(st.g.checks.j["2026-11-08"]));
  ok(st.g.checks.j["2026-11-15"][2] === "bad", "700 vs ~985 is red");
  ok(st.g.checks.a === 900, "a bad week mid-month does not move the anchor");
  // December's first Sunday (6.12): weeks 8.11-29.11 low -> the median is under 90% of the anchor: the goal stays at 90% and a proposal waits
  rows = { "2026-11-22": { checks: { v: 600 } }, "2026-11-29": { checks: { v: 650 } } };
  st = gTick(st, rows, "2026-12-06", {}, "live");
  g = st.g.checks;
  ok(g.a === 810 && g.ps === "2026-12-06", "floor: the new anchor is 90% of the old one: " + g.a);
  const p = st.props.find(x => x.k === "checks" && x.st === "open");
  ok(p && p.to === 675 && p.id === "goal-checks-20261206", "a proposal to lower to the median waits: " + JSON.stringify(p));
  ok(gView(st, "2026-12-07").props.some(x => x.id === p.id), "the page sees the open proposal");
  // Dudu approves: the anchor drops to the proposed value, logged
  st = gTick(st, {}, "2026-12-07", { [p.id]: { c: "מאשר" } }, "live");
  ok(st.g.checks.a === 675 && st.props[0].st === "yes" && st.log.some(l => l.kind === "approved"), "approved lower goal applies and is logged");
  // a ceiling: a jump of more than x1.5 in a month is capped
  let s2 = gTick(null, { "2026-10-18": { checks: { v: 100 } }, "2026-10-25": { checks: { v: 100 } }, "2026-11-01": { checks: { v: 100 } } }, "2026-11-08", {}, "live");
  s2 = gTick(s2, { "2026-11-08": { checks: { v: 400 } }, "2026-11-15": { checks: { v: 400 } }, "2026-11-22": { checks: { v: 400 } }, "2026-11-29": { checks: { v: 400 } } }, "2026-12-06", {}, "live");
  ok(s2.g.checks.a === 150, "cap: the anchor rises at most x1.5 in a month: " + s2.g.checks.a);
  ok(s2.g.checks.nb === undefined && s2.g.checks.b === "opt", "4 green weeks raised the band at the new month: " + s2.g.checks.b);
  // the kill switch: fixed mode freezes the growth target and stops new anchors
  let s3 = gTick(s2, {}, "2026-12-08", {}, "fixed");
  const fz = s3.g.checks.flat;
  s3 = gTick(s3, { "2026-12-06": { checks: { v: 200 } } }, "2027-01-03", {}, "fixed");
  ok(fz != null && s3.g.checks.flat === fz && s3.g.checks.ps === "2026-12-06", "fixed: the target stays and January sets no new anchor");
  ok(s3.log.some(l => l.kind === "mode"), "the switch is logged");
  // small samples: a ratio from fewer than 100 events is pooled over 4 weeks and says early under 30
  let s4 = gTick(null, { "2026-10-18": { save1: { x: 2, n: 10 } }, "2026-10-25": { save1: { x: 3, n: 10 } }, "2026-11-01": { save1: { x: 1, n: 5 } } }, "2026-11-08", {}, "live");
  ok(s4.g.save1.j["2026-11-01"][2] === "early", "25 installs pooled: too early to judge");
  // health tightens after 8 calm weeks, never loosens
  let s5 = null, rr = {};
  for (let i = 0; i < 10; i++) rr[gAdd("2026-10-25", 7 * i)] = { fail: { x: 5, n: 1000 } };
  s5 = gTick(null, rr, gAdd("2026-10-25", 7 * 10), {}, "live");
  ok(s5.g.fail.warn > .5 && s5.g.fail.warn < 2 && s5.log.some(l => l.kind === "tight"), "8 weeks at 0.5% move the warning line from 2 halfway: " + s5.g.fail.warn);
  // the view has the 8 judged goals and no business number in the log text of a made-up run beyond what was given
  const V = gView(s5, gAdd("2026-10-25", 70));
  ok(V.items.filter(i => i.lens).length === 8, "8 goals judged on the CEO lens");
  ok(V.items.every(i => i.name && i.owner && i.src), "every goal says what it is, who owns it and where its bar comes from");
  reanchor();
  console.log(fails ? fails + " failed" : "selftest ok");
  if (fails) process.exit(1);
}
// the one-time re-anchor of 19.11 (Dudu via the CEO thread), on made-up weeks: the anchor moves to the week 8-14.11, 5% a week until 31.3,
// once; a big week 15-21.11 makes the checks anchor the mean of the two; open proposals to lower close; the ratings count and the gate lines
function reanchor() {
  const { gTick, gView, gTarget, G_BY, G_RE, gAdd } = E, R = G_RE[0];
  ok(R && R.w === "2026-11-08" && R.rate === 1.05 && R.two.w === "2026-11-15", "the 19.11 re-anchor: week 8.11, 5% a week, the 15.11 check");
  const none = [], base = { "2026-10-18": { checks: { v: 3000 }, installs: { v: 500 } }, "2026-10-25": { checks: { v: 2000 }, installs: { v: 300 } }, "2026-11-01": { checks: { v: 1500 }, installs: { v: 120 } } };
  let st = gTick(null, base, "2026-11-08", {}, "live", undefined, none);
  st = gTick(st, { "2026-11-08": { checks: { v: 1000 }, installs: { v: 70 } } }, "2026-11-15", {}, "live", undefined, none);
  ok(st.g.checks.a === 2000 && st.last === "2026-11-15", "before: the anchor is the launch weeks' median: " + st.g.checks.a);
  st.props.unshift({ id: "goal-checks-20261115", k: "checks", at: "2026-11-15", from: 2000, to: 1000, why: "x", st: "open" });
  // the release lands on a Thursday: the re-anchor applies at once, without a new Sunday
  let a = gTick(st, {}, "2026-11-19", {}, "live", "2026-11-15");
  let g = a.g.checks, gi = a.g.installs;
  ok(g.a === 1000 && g.aw === "2026-11-08" && g.rate === 1.05 && gi.a === 70 && gi.aw === "2026-11-08", "the anchor is the week 8.11, for checks and installs: " + g.a + " " + gi.a);
  ok(Math.abs(gTarget(g, G_BY.checks, "2026-11-22") - 1000 * 1.05 * 1.05) < .01 && Math.abs(gTarget(g, G_BY.checks, "2027-03-28") - 1000 * 1.05 ** 20) < .1, "5% a week: 22.11 = a x 1.05^2, 28.3 = a x 1.05^20");
  ok(gTarget(g, G_BY.checks, "2027-05-02") / gTarget(g, G_BY.checks, "2027-04-25") < 1.045, "after 31.3 the plan's slope again");
  ok(a.props[0].st === "re" && a.re[R.id] === "2026-11-19" && a.log.filter(l => l.kind === "re").length === 2, "the open proposal closes; logged once per goal");
  const V = gView(a, "2026-11-19"), vc = V.items.find(i => i.k === "checks");
  ok(vc.fix === 1 && vc.rate === 5 && vc.now === 1050 && V.gl.checks.go === 3000 && V.gl.checks.turn === 1700, "the page: 5% fixed, this week's target, the gate lines: " + JSON.stringify([vc.fix, vc.rate, vc.now]));
  a = gTick(a, {}, "2026-11-20", {}, "live", "2026-11-15");
  ok(a.g.checks.a === 1000 && a.log.filter(l => l.kind === "re").length === 2, "applied once only");
  // Sunday 22.11, a normal week 15.11: judged on the new target, the anchor stays
  let b = gTick(a, { "2026-11-15": { checks: { v: 1100 }, installs: { v: 80 } } }, "2026-11-22", {}, "live");
  ok(b.g.checks.j["2026-11-15"][1] === 1050 && b.g.checks.j["2026-11-15"][2] === "ok", "15.11 judged against a x 1.05: " + JSON.stringify(b.g.checks.j["2026-11-15"]));
  ok(b.g.checks.a === 1000 && b.g.checks.aw === "2026-11-08" && b.re[R.id + ":two"] === "2026-11-22", "under the line: the anchor stays on 8.11");
  // a big week 15.11 (above the line): the checks anchor is the mean of the two weeks, anchored on 15.11; installs stay
  let c = gTick(a, { "2026-11-15": { checks: { v: 1600 }, installs: { v: 90 } } }, "2026-11-22", {}, "live");
  ok(c.g.checks.a === 1300 && c.g.checks.aw === "2026-11-15" && c.g.installs.a === 70, "above the line: mean of the two weeks: " + c.g.checks.a);
  ok(Math.abs(gTarget(c.g.checks, G_BY.checks, "2026-11-22") - 1300 * 1.05) < .01, "the next week's target = the mean x 1.05");
  // December: the monthly anchor comes back (median of 4 weeks, 90% floor) and the 5% slope holds; a late release skips the re-anchor
  let d = gTick(b, { "2026-11-22": { checks: { v: 900 } }, "2026-11-29": { checks: { v: 950 } } }, "2026-12-06", {}, "live");
  ok(d.g.checks.a === 975 && d.g.checks.rate === 1.05 && d.g.checks.aw === "2026-11-29", "6.12: the monthly median anchor is back, still 5% a week: " + d.g.checks.a);
  let d2 = gTick(b, { "2026-11-22": { checks: { v: 500 } }, "2026-11-29": { checks: { v: 500 } } }, "2026-12-06", {}, "live");
  ok(d2.g.checks.a === 900 && d2.props.some(p => p.k === "checks" && p.st === "open"), "6.12, low weeks: the floor is 90% of the re-anchor and a proposal waits: " + d2.g.checks.a);
  let e = gTick(null, base, "2026-11-08", {}, "live", undefined, none);
  e = gTick(e, { "2026-11-08": { checks: { v: 1000 } }, "2026-11-15": { checks: { v: 1000 } }, "2026-11-22": { checks: { v: 1000 } }, "2026-11-29": { checks: { v: 1000 } } }, "2026-12-06", {}, "live", undefined, none);
  e = gTick(e, {}, "2026-12-08", {}, "live", "2026-12-06");
  ok(/^skip/.test(e.re[R.id]) && !e.g.checks.rate, "after 5.12 the re-anchor is skipped: " + e.re[R.id]);
  // fixed mode: the frozen target is recomputed from the new anchor
  let f = gTick(st, {}, "2026-11-16", {}, "fixed", "2026-11-15", none);
  f = gTick(f, {}, "2026-11-19", {}, "fixed", "2026-11-15");
  ok(f.g.checks.flat === 1050, "fixed mode: the frozen target follows the re-anchor: " + f.g.checks.flat);
  // the ratings: 4.5 and more, and 60 by 31.3 on a straight line from the launch (about 12 by 21.11)
  const rt = (v, c) => gTick(a, { "2026-11-15": { rating: { v, c } } }, "2026-11-22", {}, "live").g.rating;
  ok(rt(4.7, 5).j["2026-11-15"][2] === "warn" && rt(4.7, 5).pace === 12, "a good level behind the count line is amber");
  ok(rt(4.7, 20).j["2026-11-15"][2] === "ok" && rt(4.3, 20).j["2026-11-15"][2] === "bad", "on the line green; under 4.5 red");
  ok(gView(a, "2026-11-19").items.find(i => i.k === "share").dep, "share says it depends on a product change");
}
function backtest(file, today) {
  const rows = JSON.parse(fs.readFileSync(file, "utf8")), st = E.gTick(null, rows, today || E.G_START, {}, "live");
  console.log(JSON.stringify(E.gView(st, today || E.G_START), null, 1));
}
const [cmd, a, b] = process.argv.slice(2);
if (cmd === "selftest") selftest(); else if (cmd === "backtest") backtest(a, b); else if (cmd) { console.log("usage: selftest | backtest <rows.json> [today]"); process.exit(2); }
