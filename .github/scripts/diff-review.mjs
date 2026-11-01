// Diff review (QA thread with product; Dudu 1.11.2026 21:16 UTC "מקבל, נלך על 2 החבילות", monthly API credit, package A): Claude Opus reads
// a change before it reaches people, for what the guardians and the lint cannot judge: right-to-left cuts, text that clips at a large font,
// a page line that says more than the data shows, a dealer made a villain, a real plate, an event or an app call left out of its list, a
// release bump that misses one of its three files, a rule changed in one reader and not in the others, and plain bugs.
//   push     a push to next that touches the app (index.html, sw.js, android/, worker/): the push's own commits (before..after)
//   release  a manual run on a branch that waits for "שחרר": everything the branch adds to main (merge-base..head)
// Each point is tied to a line the change touched (a point on an untouched line is dropped and counted), and the review only suggests:
// it never fails a run and never blocks a release. Product's rules (1.11 21:17 UTC) are RULES below; QA's release-sync is rule 9.
// The report: branch diff-review-out, a folder per branch (latest.md and <sha7>.md), state.json (reviews this month, commits done). The
// repo is public and so is its code, so the report may quote code; tokens and dollars go only to usage/*.enc.json, encrypted with
// .github/seo-data.pub.pem (visual-review's format). The cap is a count of reviews a month (CAP), so the spend is bounded in public.
// Router: code:<branch>[:<sha>] (summary) when a review has a high point, so product reads it; ai:diff (summary) when the API failed and the
// review was skipped, ai:key (day) when the key or the credit is why; a good review closes ai:diff and ai:key. No key, DIFF_REVIEW=off,
// the month's cap or nothing to read: it skips quietly. Only a crash of this script is red (Failure alert, summary).
// Node 20, node: builtins, git and ./claude.mjs (its SDK installed by the workflow). Commands:
//   node diff-review.mjs --base SHA --head SHA --branch NAME --kind push|release --out DIR [--run URL]
//   node diff-review.mjs selftest     offline: a made-up repository and a fake API
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import * as claude from "./claude.mjs";

export const V = 1;
export const MODEL = "claude-opus-5-5";
export const CAP = 80;              // reviews a calendar month (~20 pushes to next and a few releases; at ~$0.5 a review well under $45)
export const MAX_CHARS = 320000;    // the diff sent in one request (~100K tokens); the rest is listed as not read
export const FILE_MAX = 90000;      // one file's diff above this is listed as not read (a data dump, a generated page)
export const NEAR = 3;              // a point may sit this many lines from a touched line
const PRICE = { [MODEL]: [4, 20] };   // $ per million tokens, for the encrypted usage file only (cache write 1.25x, read 0.05x)
const SKIP = [/^data\//, /\.(png|jpe?g|webp|gif|ico|svg|pdf|woff2?|ttf|otf|apk|aab|jar|zip|gz|mp4|webm|mp3)$/i, /(^|\/)package-lock\.json$/, /\.enc\.json$/, /\.min\.js$/];
// the order a reviewer reads in: the app first, then what serves it, then the bots
const RANK = [/^index\.html$/, /^sw\.js$/, /^android\//, /^worker\//, /^\.github\/scripts\//, /^\.github\/store-listing\//, /^\.github\/workflows\//, /./];

const IO = { env: process.env, out: s => process.stdout.write(s + "\n"), now: () => Date.now(), claude, router: () => import("./alert.mjs"),
  git: (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }),
  pub: () => fs.readFileSync(new URL("../seo-data.pub.pem", import.meta.url), "utf8"), cwd: process.cwd() };
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

export const RULES = [
  ["rtl", "Right to left: a one-line name that can hold English (a make or model, a dealer, an importer) goes through cutHtml(parts) on a .cut element; never a bare white-space:nowrap + text-overflow:ellipsis on mixed Hebrew/English text (in RTL it cuts the START of the English part: 'טויוטה LLA…'). Arrays or <bdi> where digits could follow an English part."],
  ["zoom", "Text zoom: the app's WebView follows the phone's font size (130% and 200% are tested). Nothing with a fixed height in px that clips text at a large font; no new text under 12px; no tap target under 40px."],
  ["data", "Data accuracy: a page line about recalls, owners, the yearly test, EV / heavy / two-wheeler, personal imports or cancelled cars says only what the data shows. A change to a line that .github/scripts/site-data-audit.mjs mirrors (its GROUPS) must change that guard too. A changed data rule must reach its other readers: catalog-build, models.mjs, pages.mjs, modelstats, new-models.mjs, market.mjs, ideas.mjs, worker/live, site-data-audit.mjs."],
  ["golden", "Golden rule of the wording: dealers and importers are customers, never villains. 'ייתכן' where the data is uncertain. Hebrew in neutral forms (no gendered address to the reader)."],
  ["plates", "No real licence plates anywhere (code, comments, fixtures, logs): only the synthetic ones (12-345-67, 1234567, 7654321 and the fixtures' own). A hash or base64 of a plate is the plate. No business numbers (users, installs, money) in anything public."],
  ["events", "Analytics: a new or renamed GA4 event or parameter must be in .github/scripts/ga4-admin.mjs (its selftest), and the measurement thread must be told."],
  ["bridge", "App bridge: a call to window.Android.* or a page function the Android app calls must stay in .github/scripts/app-wiring.mjs's list."],
  ["release", "A version bump changes three things together: APP_VERSION in index.html, SHELL 'luchit-shell-X.0' in sw.js, and android/release-notes.txt (first line '# X', Hebrew bullets starting with '• ', at most 500 characters)."],
  ["sync", "Release sync: a user-visible feature that is added, changed or removed is reflected where people read about it: the store listing lines (.github/store-listing/), the site, the FAQ and the magazine never promise what the app no longer does; a change in the data collected changes .github/store-listing/data-safety.csv and privacy.html."],
  ["bug", "A plain bug: wrong logic, a crash or an unhandled error, a broken selector or id, a race, a leak of state between screens, a missing await, an off-by-one, a regression of behaviour that existed before the change."],
];
const RULE_IDS = RULES.map(r => r[0]);
const SEVERITIES = ["high", "medium", "low"];

export const SYSTEM = `You review a code change to לוחית (luchit.app), an Israeli car-check app: a single-page Hebrew (right-to-left) web app in index.html that also ships inside an Android WebView app (android/), with a service worker (sw.js), Cloudflare Workers (worker/) and GitHub Actions bots (.github/). People type a licence plate and see the Ministry of Transport's open data about the car.

Facts about the page that a diff does not show: index.html has a global [hidden]{display:none!important}, so setting .hidden always hides an element whatever its display rule; one-line names go through cutHtml() on a .cut element on purpose.

You get the change as a unified diff with context. Report only real problems the change brings, each tied to one line of the NEW version of a file in the diff (a line the change added or touched, or the line where something was removed). Judge by these rules:

${RULES.map((r, i) => `${i + 1}. [${r[0]}] ${r[1]}`).join("\n")}

Leave out: style, naming, formatting and refactoring opinions; anything already caught by the automatic checks (ui-lint, the UI and App guardians, app-wiring, the selftests); problems in lines the change did not touch; guesses about code you cannot see. If you are not fairly sure, say so with confidence "likely" instead of "sure", or leave it out. An empty list is the right answer for a clean change. Never invent a line number: use the new file's line numbers shown in the diff (the hunk headers give them).

severity: high = people would see something wrong or broken, data shown wrong, a real plate or business number exposed, or a release that would ship incomplete; medium = likely to hurt in some cases; low = worth a look.
what: the problem in one or two plain sentences (English). fix: the smallest change that fixes it, in one sentence.`;

const SCHEMA = { type: "object", additionalProperties: false, required: ["points", "note"], properties: {
  note: { type: "string", description: "one sentence on the change as a whole" },
  points: { type: "array", items: { type: "object", additionalProperties: false, required: ["file", "line", "rule", "severity", "confidence", "what", "fix"], properties: {
    file: { type: "string" }, line: { type: "integer" }, rule: { type: "string", enum: RULE_IDS }, severity: { type: "string", enum: SEVERITIES },
    confidence: { type: "string", enum: ["sure", "likely"] }, what: { type: "string" }, fix: { type: "string" } } } } } };

// ---- the diff: which files, in which order, and which new lines each touched
export function pick(names) {
  const read = [], skipped = [];
  for (const f of names) (SKIP.some(r => r.test(f)) ? skipped : read).push(f);
  const rank = f => RANK.findIndex(r => r.test(f));
  read.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return { read, skipped };
}

// new-file line numbers the diff touched: every added line, and for a removal the line it was removed before
export function touched(diff) {
  const lines = new Set(); let n = 0;
  for (const l of diff.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) { n = +h[1]; continue; }
    if (!n) continue;
    if (l.startsWith("+") && !l.startsWith("+++")) { lines.add(n); n++; }
    else if (l.startsWith("-") && !l.startsWith("---")) lines.add(Math.max(1, n));
    else if (!l.startsWith("\\")) n++;
  }
  return lines;
}
export const near = (set, line) => { for (let d = 0; d <= NEAR; d++) if (set.has(line - d) || set.has(line + d)) return true; return false; };

export function gather(base, head, cwd = IO.cwd) {
  const names = IO.git(["diff", "--name-only", "--no-renames", base, head], cwd).split("\n").filter(Boolean);
  const { read, skipped } = pick(names), files = [], notRead = skipped.map(f => ({ file: f, why: "not code" }));
  let total = 0;
  for (const f of read) {
    const d = IO.git(["diff", "--no-color", "--no-renames", "-U25", base, head, "--", f], cwd);
    if (!d.trim()) continue;
    if (/^Binary files /m.test(d)) { notRead.push({ file: f, why: "binary" }); continue; }
    if (d.length > FILE_MAX) { notRead.push({ file: f, why: "too big to read" }); continue; }
    if (total + d.length > MAX_CHARS) { notRead.push({ file: f, why: "over the size of one review" }); continue; }
    total += d.length; files.push({ file: f, diff: d, lines: touched(d) });
  }
  const log = IO.git(["log", "--no-merges", "--format=%h %s", "-n", "60", `${base}..${head}`], cwd).trim();
  return { files, notRead, log, chars: total };
}

export function request(g, o) {
  const text = [`Branch: ${o.branch} (${o.kind === "release" ? "everything it adds to main, before release" : "one push"}). Commits:`, g.log || "(none listed)", "",
    ...g.files.map(f => f.diff), "", g.notRead.length ? `Not shown: ${g.notRead.map(x => x.file).join(", ")}` : ""].join("\n");
  return { model: MODEL, max_tokens: 16000, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } }, messages: [{ role: "user", content: [{ type: "text", text }] }] };
}

// the answer's points that hold: a file in the diff, a line the change touched, a known rule
export function check(reply, g) {
  const by = new Map(g.files.map(f => [f.file, f])), kept = [], dropped = [];
  for (const p of (reply && Array.isArray(reply.points) ? reply.points : [])) {
    const f = by.get(p.file), why = !f ? "a file the diff does not show" : !Number.isInteger(p.line) || !near(f.lines, p.line) ? "a line the change did not touch"
      : !RULE_IDS.includes(p.rule) || !SEVERITIES.includes(p.severity) ? "an unknown rule or severity" : "";
    (why ? dropped : kept).push(why ? { ...p, why } : p);
  }
  kept.sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || ((a.confidence === "sure" ? 0 : 1) - (b.confidence === "sure" ? 0 : 1)) || a.file.localeCompare(b.file) || a.line - b.line);
  return { kept, dropped, note: clip(reply && reply.note, 300) };
}

function seal(obj) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([ci.update(JSON.stringify(obj)), ci.final()]);
  const ek = crypto.publicEncrypt({ key: IO.pub(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  return JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") });
}
const cost = u => { const [i, o] = PRICE[MODEL]; return (u.input * i + u.cacheWrite * i * 1.25 + u.cacheRead * i * 0.05 + u.output * o) / 1e6; };
const folder = b => String(b).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 60) || "branch";
const repoUrl = env => `https://github.com/${env.GITHUB_REPOSITORY || "ddsabag/vehicle-app"}`;

export function reportMd(r, env = IO.env) {
  const blob = (f, l) => `${repoUrl(env)}/blob/${r.head}/${f}#L${l}`, cell = s => clip(s, 400).replace(/\|/g, "/");
  return [`### Diff review: ${r.branch} ${r.head.slice(0, 7)} (${r.kind === "release" ? "before release" : "push"}): ${r.points.length} points, ${r.points.filter(p => p.severity === "high").length} high`, "",
    `Base ${r.base.slice(0, 7)} → ${r.head.slice(0, 7)}. ${r.files} files read${r.notRead.length ? `, ${r.notRead.length} not read` : ""}. ${r.run ? `[run](${r.run}). ` : ""}Suggestions only: nothing here blocks a release.`, "",
    r.note ? `> ${r.note}\n` : "",
    ...(r.points.length ? ["| severity | rule | where | what | fix |", "|---|---|---|---|---|",
      ...r.points.map(p => `| ${p.severity}${p.confidence === "likely" ? " (likely)" : ""} | ${p.rule} | [${p.file}:${p.line}](${blob(p.file, p.line)}) | ${cell(p.what)} | ${cell(p.fix)} |`), ""] : ["No points.", ""]),
    ...(r.dropped.length ? [`Dropped (not tied to a line the change touched): ${r.dropped.length}.`, "", ...r.dropped.slice(0, 10).map(d => `- ${d.file}:${d.line} (${d.why}): ${clip(d.what, 160)}`), ""] : []),
    ...(r.notRead.length ? ["Not read: " + r.notRead.slice(0, 40).map(x => `\`${x.file}\` (${x.why})`).join(", ") + (r.notRead.length > 40 ? ", …" : ""), ""] : []),
  ].join("\n");
}

function summary(md) { try { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* the log has it */ } }

async function tell(kind, o, extra = {}) {
  let router = null, tg = null;
  try { router = await IO.router(); tg = await import("./tg-text.mjs"); } catch { return; }
  try {
    if (kind === "key") await router.alert("day", "ai:key", tg.msg({ kind: "today", area: "bots", title: "מפתח ה-Claude API לא עובד או שהקרדיט נגמר",
      text: `בדיקת הקוד של ${o.branch} לא רצה. סביר שגם שאר הבוטים שנעזרים ב-Claude ממשיכים בלעדיו.`,
      what: "להיכנס לקונסולה של Anthropic ולבדוק את המפתח ואת תקרת ההוצאה של luchit-bots. אם צריך, להדביק את המפתח מחדש בסוד ANTHROPIC_API_KEY." }), o.run || "", { today: "loud", legacy: () => false });
    else if (kind === "api") await router.alert("summary", "ai:diff", tg.msg({ kind: "info", area: "bots", title: "בדיקת הקוד לפני שחרור לא הצליחה לפנות ל-Claude",
      text: `השינוי ב-${o.branch} לא נבדק הפעם. אפשר להריץ אותה שוב ידנית.`, raw: extra.why }), o.run || "", { today: "silent", legacy: () => false });
    else if (kind === "points") await router.alert("summary", extra.key, tg.msg({ kind: "info", area: "app", title: "בדיקת הקוד מצאה נקודות לבדוק לפני שחרור",
      text: `בענף ${o.branch}: ${extra.high} נקודות חשובות מתוך ${extra.all}. הבדיקה רק מציעה ולא עוצרת שום דבר.`, what: "שרשור המוצר עובר על הדוח ומחליט." }), extra.link, { today: "silent", legacy: () => false });
    else await router.resolve(["ai:diff", "ai:key"]);
  } catch { /* the report on the branch still says it */ }
}

export async function run(o) {
  const env = IO.env, say = IO.out, note = t => say(`::notice title=Diff review (${o.branch})::${t}`);
  const stop = t => { note("skipped: " + t); summary(`### Diff review (${o.branch})\n\nSkipped: ${t}.\n`); return 0; };
  if (String(env.DIFF_REVIEW || "").toLowerCase() === "off") return stop("DIFF_REVIEW=off");
  if (!o.base || !o.head || !/^[0-9a-f]{7,40}$/i.test(o.head) || !/^[0-9a-f]{7,40}$/i.test(o.base)) return stop("no base and head commits");
  const statePath = path.join(o.out, "state.json"), now = new Date(IO.now()), month = now.toISOString().slice(0, 7);
  const st = J(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "") || {};
  if (st.month !== month) Object.assign(st, { month, reviews: 0 });
  st.done ||= {};
  if (st.done[o.head]) return stop(`${o.head.slice(0, 7)} was reviewed already`);
  if (st.reviews >= CAP) return stop(`this month's ${CAP} reviews are used`);
  if (!env.ANTHROPIC_API_KEY) return stop("no ANTHROPIC_API_KEY");
  const g = gather(o.base, o.head);
  if (!g.files.length) return stop("no code to read in this change");
  const { api, why } = await IO.claude.client(env, { timeout: 15 * 60000 });
  if (!api) { await tell("api", o, { why }); return stop(why); }
  const r = await IO.claude.ask(api, request(g, o));
  if (r.error) { await tell(r.error.key ? "key" : "api", o, { why: r.error.why }); return stop(`the API: ${r.error.why}`); }
  const a = IO.claude.answer(r.msg), reply = J(a.text);
  if (!reply) { await tell("api", o, { why: a.why || "an answer that is not JSON" }); return stop(`no usable answer (${a.why || "not JSON"})`); }
  const { kept, dropped, note: gist } = check(reply, g), at = now.toISOString(), u = IO.claude.usage(r.msg);
  const rep = { v: V, at, branch: o.branch, kind: o.kind, base: o.base, head: o.head, run: o.run || "", files: g.files.length, notRead: g.notRead, note: gist, points: kept, dropped };
  const md = reportMd(rep), dir = path.join(o.out, folder(o.branch));
  fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(o.out, "usage"), { recursive: true });
  fs.writeFileSync(path.join(dir, `${o.head.slice(0, 7)}.md`), md); fs.writeFileSync(path.join(dir, "latest.md"), md);
  fs.writeFileSync(path.join(dir, `${o.head.slice(0, 7)}.json`), JSON.stringify(rep, null, 1));
  fs.writeFileSync(path.join(o.out, "usage", `${at.replace(/[:.]/g, "-")}.enc.json`), seal({ at, branch: o.branch, model: MODEL, tokens: u, usd: +cost(u).toFixed(4) }));
  st.reviews++; st.done[o.head] = at;
  for (const [k, t] of Object.entries(st.done)) if (IO.now() - Date.parse(t) > 120 * 864e5) delete st.done[k];   // four months is enough
  fs.writeFileSync(statePath, JSON.stringify(st, null, 1));
  summary(md);
  say(`diff review ${o.branch} ${o.head.slice(0, 7)}: ${g.files.length} files read, ${g.notRead.length} not read, ${kept.length} points (${kept.filter(p => p.severity === "high").length} high), ${dropped.length} dropped`);
  for (const p of kept.slice(0, 20)) say(`::notice file=${p.file},line=${p.line},title=Diff review: ${p.rule} (${p.severity})::${clip(p.what, 300)}`);
  const high = kept.filter(p => p.severity === "high").length;
  if (high) {
    const sha = o.head.slice(0, 8), key = `code:${folder(o.branch)}` + (/[a-f]/.test(sha) ? `:${sha}` : "");
    await tell("points", o, { key, high, all: kept.length, link: `${repoUrl(env)}/blob/diff-review-out/${folder(o.branch)}/${o.head.slice(0, 7)}.md` });
  }
  await tell("clean", o);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, "wrote=1\n");
  return 0;
}

function args(argv) {
  const o = { kind: "push" };
  for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ""); if (["base", "head", "branch", "kind", "out", "run"].includes(k)) o[k] = argv[++i]; }
  return o;
}

// ---- self-test: a made-up repository and a fake API, nothing leaves the machine
async function selftest() {
  let bad = 0; const print = IO.out, ok = (c, m) => { print((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const os = await import("node:os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dr-")), repo = path.join(tmp, "repo"), out = path.join(tmp, "out");
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), pub = keys.publicKey.export({ type: "spki", format: "pem" });
  const open = f => { const e = J(fs.readFileSync(f, "utf8"));
    const k = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64")); return J(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString()); };
  const g = (...a) => IO.git(a, repo).trim(), put = (f, s) => { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), s); };
  fs.mkdirSync(repo); g("init", "-q", "-b", "main"); g("config", "user.email", "t@t.invalid"); g("config", "user.name", "t");
  const page = Array.from({ length: 120 }, (_, i) => `<p id="l${i + 1}">line ${i + 1}</p>`);
  put("index.html", page.join("\n") + "\n"); put("sw.js", "const SHELL = 'luchit-shell-1.0';\n"); put("data/big.json", "{}\n"); put("logo.png", "x");
  g("add", "-A"); g("commit", "-q", "-m", "base"); const base = g("rev-parse", "HEAD");
  page[59] = `<p id="l60" class="name" style="white-space:nowrap;text-overflow:ellipsis">טויוטה COROLLA</p>`; page.splice(100, 1);
  put("index.html", page.join("\n") + "\n"); put("data/big.json", '{"a":1}\n'); put("logo.png", "y"); put(".github/scripts/x.mjs", "export const a = 1;\n");
  g("add", "-A"); g("commit", "-q", "-m", "a name on one line"); const head = g("rev-parse", "HEAD");

  // pure parts
  ok(JSON.stringify(pick(["worker/a.js", "README.md", "index.html", "data/x.json", "a.png", "sw.js", "android/b.kt"]).read) === '["index.html","sw.js","android/b.kt","worker/a.js","README.md"]', "pick: the app first, data and pictures left out");
  const t = touched("@@ -10,3 +10,4 @@\n a\n-b\n+c\n+d\n e\n@@ -40,2 +41,1 @@\n x\n-y\n");
  ok([...t].sort((a, b) => a - b).join() === "11,12,42", "touched: added lines and where a line was removed");
  ok(near(t, 15) && !near(t, 16) && near(t, 39) && !near(t, 38), `near: within ${NEAR} lines`);
  const gg = gather(base, head, repo);
  ok(gg.files.map(f => f.file).join() === "index.html,.github/scripts/x.mjs" && gg.notRead.map(x => x.file).sort().join() === "data/big.json,logo.png", "gather: code read, data and pictures listed as not read");
  ok(gg.files[0].lines.has(60) && gg.files[0].lines.has(101) && /^Branch: next/.test(request(gg, { branch: "next", kind: "push" }).messages[0].content[0].text), "gather: the touched lines of index.html; the request names the branch");
  const p = request(gg, { branch: "next", kind: "push" });
  ok(p.model === MODEL && p.output_config.effort === "medium" && p.output_config.format.type === "json_schema" && p.system[0].cache_control && !("temperature" in p) && !("thinking" in p),
    "request: Opus, effort medium, a JSON schema, a cached instruction, no sampling, thinking left to the model");
  ok(RULES.length === 10 && RULE_IDS.every(r => SYSTEM.includes(`[${r}]`)) && /cutHtml/.test(SYSTEM) && /ga4-admin/.test(SYSTEM) && /app-wiring/.test(SYSTEM), "the instruction carries every rule");
  const c = check({ note: "n", points: [
    { file: "index.html", line: 60, rule: "rtl", severity: "high", confidence: "sure", what: "nowrap cuts the start of COROLLA", fix: "cutHtml" },
    { file: "index.html", line: 30, rule: "bug", severity: "low", confidence: "likely", what: "untouched", fix: "-" },
    { file: "other.js", line: 1, rule: "bug", severity: "high", confidence: "sure", what: "not in diff", fix: "-" },
    { file: "index.html", line: 101, rule: "nope", severity: "high", confidence: "sure", what: "bad rule", fix: "-" } ] }, gg);
  ok(c.kept.length === 1 && c.kept[0].line === 60 && c.dropped.map(d => d.why).join("|") === "a line the change did not touch|a file the diff does not show|an unknown rule or severity", "check: only points on touched lines, in the diff, with a known rule");

  // whole runs through a fake API
  const fake = { calls: [], answer: null, error: null };
  const reply = obj => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 9000, output_tokens: 700, cache_read_input_tokens: 2000 } });
  const told = [], logs = [];
  Object.assign(IO, { env: { ANTHROPIC_API_KEY: "test", GITHUB_REPOSITORY: "o/r" }, out: s => logs.push(s), pub: () => pub, cwd: repo, now: () => Date.parse("2026-11-02T10:00:00Z"),
    router: async () => ({ alert: async (lv, key) => { told.push(`${lv} ${key}`); return { delivered: true }; }, resolve: async q => { told.push("resolve " + q.join("+")); return 1; } }),
    claude: { ...claude, client: async env => env.ANTHROPIC_API_KEY ? { api: {}, why: "" } : { api: null, why: "no ANTHROPIC_API_KEY" },
      ask: async (api, q) => { fake.calls.push(q); return fake.error ? { error: fake.error } : { msg: reply(fake.answer) }; } } });
  const go = (extra = {}) => run({ base, head, branch: "next", kind: "push", out, run: "https://example.invalid/run/1", ...extra });
  fake.answer = { note: "one name on one line", points: [c.kept[0], { file: "index.html", line: 30, rule: "bug", severity: "low", confidence: "likely", what: "untouched", fix: "-" }] };
  ok(await go() === 0 && fake.calls.length === 1, "a review: one request");
  const md = fs.readFileSync(path.join(out, "next", `${head.slice(0, 7)}.md`), "utf8"), st = J(fs.readFileSync(path.join(out, "state.json"), "utf8"));
  ok(/1 points, 1 high/.test(md) && md.includes(`https://github.com/o/r/blob/${head}/index.html#L60`) && /Dropped .*: 1/.test(md) && /data\/big\.json/.test(md), "the report: the point with its link, the dropped one counted, what was not read");
  ok(fs.readFileSync(path.join(out, "next", "latest.md"), "utf8") === md && st.reviews === 1 && st.done[head] && st.month === "2026-11", "latest.md and the state");
  const sh = head.slice(0, 8), want = `code:next${/[a-f]/.test(sh) ? ":" + sh : ""}`;
  ok(told.join() === `summary ${want},resolve ai:diff+ai:key`, "a high point tells the router (summary), a good review closes ai:diff and ai:key");
  ok(!/usd|\$|input_tokens|cacheRead/i.test(md + JSON.stringify(st)), "public files: no dollars and no tokens");
  { const u = fs.readdirSync(path.join(out, "usage")); const s = open(path.join(out, "usage", u[0])); ok(u.length === 1 && s.tokens.input === 9000 && s.usd > 0 && s.model === MODEL, "the usage is sealed and opens with the private key"); }
  ok(logs.some(l => l.startsWith("::notice file=index.html,line=60,")), "a notice on the line in the run");
  fake.calls.length = 0; told.length = 0; logs.length = 0;
  ok(await go() === 0 && !fake.calls.length && /reviewed already/.test(logs.at(-1)), "the same commit again: skipped, no request");
  for (const [env, re] of [[{ DIFF_REVIEW: "off", ANTHROPIC_API_KEY: "x" }, /DIFF_REVIEW=off/], [{}, /no ANTHROPIC_API_KEY/]]) {
    IO.env = env; logs.length = 0; ok(await go({ head: base }) === 0 && !fake.calls.length && re.test(logs.at(-1)), "skipped quietly: " + re.source); }
  IO.env = { ANTHROPIC_API_KEY: "test" };
  logs.length = 0; ok(await go({ head: base }) === 0 && /no code/.test(logs.at(-1)), "nothing changed: skipped");
  logs.length = 0; ok(await go({ head: "main; rm -rf /" }) === 0 && /no base and head/.test(logs.at(-1)), "a head that is not a commit id: skipped");
  // API trouble: nothing written, the router told
  const g2 = () => { put("sw.js", `const SHELL = 'luchit-shell-${Math.random()}';\n`); g("commit", "-q", "-am", "x"); return g("rev-parse", "HEAD"); };
  fake.error = { why: "529 server", key: false }; told.length = 0; let h2 = g2();
  ok(await go({ head: h2 }) === 0 && told.join() === "summary ai:diff" && !J(fs.readFileSync(path.join(out, "state.json"), "utf8")).done[h2], "an API error: ai:diff (summary), the commit waits");
  fake.error = { why: "401 key", key: true }; told.length = 0;
  ok(await go({ head: h2 }) === 0 && told.join() === "day ai:key", "the key: ai:key (day)");
  fake.error = null; fake.answer = { note: "clean", points: [] }; told.length = 0;
  ok(await go({ head: h2 }) === 0 && told.join() === "resolve ai:diff+ai:key" && /No points\./.test(fs.readFileSync(path.join(out, "next", `${h2.slice(0, 7)}.md`), "utf8")), "a clean change: no points, no alert, ai:diff and ai:key closed");
  // the cap
  { const s = J(fs.readFileSync(path.join(out, "state.json"), "utf8")); s.reviews = CAP; fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(s)); }
  fake.calls.length = 0; logs.length = 0; const h3 = g2();
  ok(await go({ head: h3 }) === 0 && !fake.calls.length && /reviews are used/.test(logs.at(-1)), "the month's cap: skipped");
  IO.now = () => Date.parse("2026-12-01T10:00:00Z");
  ok(await go({ head: h3 }) === 0 && fake.calls.length === 1 && J(fs.readFileSync(path.join(out, "state.json"), "utf8")).reviews === 1, "a new month: the count starts again");
  // a big file is listed, not sent
  put("worker/big.js", "x".repeat(FILE_MAX + 10) + "\n"); g("add", "-A"); g("commit", "-q", "-m", "big"); const h4 = g("rev-parse", "HEAD");
  ok(gather(h3, h4, repo).notRead.some(x => x.file === "worker/big.js" && x.why === "too big to read"), "a file over FILE_MAX is listed as not read");
  fs.rmSync(tmp, { recursive: true, force: true });
  print(bad ? `selftest: ${bad} failed` : "selftest: all passed");
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("diff-review.mjs")) {
  const a = process.argv.slice(2);
  let code = 0;
  try { code = a[0] === "selftest" ? await selftest() : await run(args(a)); }
  catch (e) { IO.out(`::error title=Diff review::it stopped on its own error (${String(e && e.message || e).replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 160)}), not on a finding`); code = 1; }
  process.exit(code);
}
