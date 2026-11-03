#!/usr/bin/env node
// slot-done.mjs: was this cron slot already run? For a bot where a second run costs (a Claude call) or sends twice (ops thread, 3.11.2026).
// From 1.11.2026 GitHub starts scheduled runs hours late or not at all, and the backup clock in luchit-uptime starts a late bot by hand
// (workflow_dispatch with the input "schedule" = the cron line, so the bot acts as that line). When GitHub's own run comes after all, or
// both start together, the later one finds the earlier here and does nothing.
//   A run of the slot: this workflow on main, created since the line's last fire and before this run, whose run name holds "(<the line>)"
//   (so a test run by hand never counts), not failed, cancelled or skipped (a failed one is retried by the next).
// The workflow, three changes and one step:
//   on.workflow_dispatch.inputs.schedule: { type: string, default: "" }        the clock passes its cron line here
//   run-name: <name>${{ (github.event.schedule || inputs.schedule) && format(' ({0})', github.event.schedule || inputs.schedule) || '' }}
//   github.event.schedule -> (github.event.schedule || inputs.schedule) wherever the line picks what the run does
//   - id: slot                                                                 first step of the job; later steps: if: steps.slot.outputs.done != '1'
//     run: node .github/scripts/slot-done.mjs
//     env: { GITHUB_TOKEN: "${{ github.token }}", SLOT: "${{ github.event.schedule || inputs.schedule }}" }   (the job needs actions: read)
// Env: GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_WORKFLOW_REF (set by GitHub), SLOT. No SLOT = not a slot: done=0.
// Writes done=1|0 to GITHUB_OUTPUT. Never fails the step: any error = done=0, the bot runs as it would without the clock.
// Run: node .github/scripts/slot-done.mjs [selftest]
import fs from "node:fs";

// the last time a cron line (UTC: minute hour day-of-month month weekday; numbers, lists, ranges and *) fired at or before now; 0 = none in
// 40 days. The same as clockSlot() in worker/uptime/worker.js (the selftest compares them).
export function lastFire(cron, now) {
  const f = String(cron).trim().split(/\s+/);
  const set = (s, wd) => { if (s === "*") return null; const o = new Set(); for (const p of String(s).split(",")) { const [a, b = a] = p.split("-").map(Number); for (let i = a; i <= b; i++) o.add(wd && i === 7 ? 0 : i); } return o; };
  const [mi, ho, dm, mo, dw] = f.length === 5 ? f.map((v, i) => set(v, i === 4)) : [new Set(), null, null, null, null];
  const has = (S, v) => !S || S.has(v), mins = [...(mi || Array.from({ length: 60 }, (_, i) => i))].sort((a, b) => b - a);
  for (let t = Math.floor(now / 36e5) * 36e5, end = now - 40 * 864e5; t > end; t -= 36e5) {
    const d = new Date(t), day = dm && dw ? dm.has(d.getUTCDate()) || dw.has(d.getUTCDay()) : has(dm, d.getUTCDate()) && has(dw, d.getUTCDay());
    if (!day || !has(mo, d.getUTCMonth() + 1) || !has(ho, d.getUTCHours())) continue;
    for (const m of mins) if (t + m * 6e4 <= now) return t + m * 6e4;
  }
  return 0;
}

const BAD = new Set(["failure", "cancelled", "skipped", "timed_out", "startup_failure", "action_required"]);
// the earlier run of the same slot, or null. runs: the API's list; me: this run (id, created_at)
export function earlier(runs, me, slotLine, slotT) {
  const mt = Date.parse(me.created_at), tag = `(${String(slotLine).trim()})`;
  return (runs || []).filter(r => r.id !== me.id && String(r.display_title || "").includes(tag) && !BAD.has(r.conclusion)
    && Date.parse(r.created_at) >= slotT && (Date.parse(r.created_at) < mt || Date.parse(r.created_at) === mt && r.id < me.id))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] || null;
}

async function api(path, env) {
  const r = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/${path}`, { signal: AbortSignal.timeout(15000),
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "luchit-slot-done" } });
  if (!r.ok) throw new Error(`${path.split("?")[0]}: ${r.status}`);
  return r.json();
}

export async function main(env = process.env, now = Date.now()) {
  const out = v => { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `done=${v}\n`); return v; };
  const line = String(env.SLOT || "").trim();
  if (!line) { console.log("not a slot run (started by hand): it runs"); return out(0); }
  try {
    const slotT = lastFire(line, now);
    if (!slotT) { console.log(`"${line}": no slot in the last 40 days: it runs`); return out(0); }
    const wf = String(env.GITHUB_WORKFLOW_REF || "").replace(/@.*$/, "").split("/").pop();
    const me = await api(`runs/${env.GITHUB_RUN_ID}`, env);
    const since = new Date(slotT).toISOString().replace(/\.\d{3}Z$/, "Z");
    const list = await api(`workflows/${wf}/runs?branch=main&per_page=50&created=${encodeURIComponent(">=" + since)}`, env);
    const e = earlier(list.workflow_runs, me, line, slotT);
    if (!e) { console.log(`slot ${since} (${line}): the first run of it, it runs`); return out(0); }
    console.log(`slot ${since} (${line}): run ${e.id} (${e.event === "schedule" ? "GitHub's schedule" : "started by the backup clock"}, ${e.created_at}) already has it, so this one does nothing`);
    return out(1);
  } catch (err) {
    console.log(`::warning title=Slot check::${String(err?.message || err).slice(0, 120)}: it runs`);
    return out(0);
  }
}

async function selftest() {
  let n = 0;
  const ok = (c, m) => { if (!c) { console.error("FAIL " + m); process.exit(1); } n++; };
  const T = s => Date.parse(s), S = (c, t) => { const v = lastFire(c, T(t)); return v ? new Date(v).toISOString().slice(0, 16) : 0; };
  ok(S("20 6 * * 0", "2026-11-08T09:00:00Z") === "2026-11-08T06:20" && S("20 6 * * 0", "2026-11-08T06:19:00Z") === "2026-11-01T06:20", "a weekly line: today's slot, or last week's before it");
  ok(S("7 8 6 * *", "2026-11-06T12:00:00Z") === "2026-11-06T08:07" && S("40 20 * * 3", "2026-11-05T02:00:00Z") === "2026-11-04T20:40", "monthly; a night slot seen the next morning");
  ok(S("*/5 * * * *", "2026-11-06T12:00:00Z") === 0 && S("", "2026-11-06T12:00:00Z") === 0, "an unsupported or empty line has no slot");
  // the same answers as the backup clock's clockSlot
  try { // optional: a sparse checkout of this script alone has no worker
    const src = fs.readFileSync(new URL("../../worker/uptime/worker.js", import.meta.url), "utf8"); // try: the selftest only
    const { clockSlot } = await import("data:text/javascript," + encodeURIComponent(src));
    const cases = [["20 6 * * 0", "2026-11-08T09:00:00Z"], ["7 8 6 * *", "2026-11-06T12:00:00Z"], ["17 5 1-3 * *", "2026-11-04T00:00:00Z"], ["17 1 * * 7", "2026-11-03T12:00:00Z"], ["0 6 1 * 1", "2026-11-03T12:00:00Z"], ["12,42 * * * *", "2026-11-03T12:50:00Z"], ["*/10 * * * *", "2026-11-03T12:00:00Z"]];
    ok(cases.every(([c, t]) => clockSlot(c, T(t)) === lastFire(c, T(t))), "the same slots as luchit-uptime's clockSlot");
  } catch (e) { if (e.code !== "ENOENT") throw e; console.log("worker/uptime/worker.js not here: the comparison is skipped"); }
  const L = "20 6 * * 0", slot = T("2026-11-08T06:20:00Z"), me = { id: 30, created_at: "2026-11-08T14:05:00Z" };
  const run = (id, at, o = {}) => ({ id, created_at: at, event: "schedule", conclusion: "success", display_title: `Weekly analytics report (${L})`, ...o });
  ok(earlier([run(30, me.created_at), run(20, "2026-11-08T07:20:00Z", { event: "workflow_dispatch" })], me, L, slot)?.id === 20, "GitHub's late run finds the clock's start");
  ok(earlier([run(30, me.created_at), run(20, "2026-11-08T07:20:00Z", { event: "workflow_dispatch", conclusion: null })], me, L, slot)?.id === 20, "running counts");
  ok(earlier([run(31, "2026-11-08T15:00:00Z"), run(30, me.created_at)], me, L, slot) === null, "the clock's start after GitHub's: the later one is not 'earlier'");
  ok(earlier([run(29, me.created_at), run(30, me.created_at)], me, L, slot)?.id === 29 && earlier([run(29, me.created_at), run(30, me.created_at)], { id: 29, created_at: me.created_at }, L, slot) === null, "both in the same second: the lower id goes first");
  ok(earlier([run(20, "2026-11-08T07:20:00Z", { conclusion: "failure" }), run(21, "2026-11-08T08:20:00Z", { conclusion: "cancelled" })], me, L, slot) === null, "a failed or cancelled one does not count: this one retries");
  ok(earlier([run(20, "2026-11-08T07:20:00Z", { display_title: "Weekly analytics report" }), run(21, "2026-11-08T07:30:00Z", { display_title: "Weekly analytics report (20 5 * * 0)" })], me, L, slot) === null, "a run by hand without the line, or of the other line, does not count");
  ok(earlier([run(19, "2026-11-01T06:30:00Z")], me, L, slot) === null, "last week's run does not count");
  // main(): no SLOT, the API (mocked), an error
  const real = globalThis.fetch, outF = `${process.env.TMPDIR || "/tmp"}/slot-done-${process.pid}.txt`;
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", GITHUB_RUN_ID: "30", GITHUB_WORKFLOW_REF: "o/r/.github/workflows/weekly-analytics.yml@refs/heads/main", GITHUB_OUTPUT: outF, SLOT: L };
  let urls = [];
  globalThis.fetch = async u => { urls.push(String(u)); return new Response(JSON.stringify(/runs\/30$/.test(u) ? me : { workflow_runs: [run(30, me.created_at), run(20, "2026-11-08T07:20:00Z", { event: "workflow_dispatch" })] })); };
  ok(await main(env, T("2026-11-08T14:06:00Z")) === 1 && fs.readFileSync(outF, "utf8") === "done=1\n", "done=1 when the slot was run");
  ok(urls[1].includes("workflows/weekly-analytics.yml/runs?branch=main&per_page=50&created=%3E%3D2026-11-08T06%3A20%3A00Z"), "reads this workflow's runs since the slot " + urls[1]);
  globalThis.fetch = async () => new Response("{}", { status: 502 });
  ok(await main(env, T("2026-11-08T14:06:00Z")) === 0, "an API error: done=0, it runs");
  ok(await main({ ...env, SLOT: "" }) === 0, "no SLOT: done=0");
  globalThis.fetch = real; fs.rmSync(outF, { force: true });
  console.log(`slot-done selftest ok (${n} checks)`);
}

if (process.argv[1] && process.argv[1].endsWith("slot-done.mjs")) {
  if (process.argv[2] === "selftest") await selftest();
  else await main();
}
