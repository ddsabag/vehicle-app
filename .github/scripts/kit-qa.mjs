// Kit visual QA (marketing thread; Dudu approved 1.11.2026 21:16 UTC, monthly API credit package B): Claude looks at every image of a
// queued weekly kit (branch social-queue, kits/<date>/: the PNG posts, the reel cover and frames of the reel) before the autopost bot
// publishes them, for what the kit lint cannot see: cut or overlapping Hebrew, right-to-left mistakes, typos, weak contrast, a crowded or
// missing Google Play badge, a plate that is not one of the demo plates, text outside a network's safe area.
// The defect kinds and the answer schema are the QA thread's (visual-review.mjs), with two of the kit's own (badge, plate). One look by
// claude-sonnet-5-5 at effort medium per image (a kit is about 15 images a week, so a cheaper first look would save next to nothing).
// Report only: a finding never fails a run and never stops a post; the marketing thread reads report.md (branch kit-draft-out, qa-<date>/)
// after it queues the kit and fixes what is real before the posts go out.
// No key, KIT_QA=off or no kit: it skips. An API error: ai:kitqa (summary), or ai:key (day) when the key or the credit is the cause; a good
// run closes both. Only a crash of this script is red (Failure alert). The repo is public: the report holds findings, never tokens or dollars.
// Node 20, node: builtins, ./claude.mjs and ./visual-review.mjs (its kinds and schema). ffmpeg for the reel frames (none: the frames are skipped).
//   node kit-qa.mjs --kit DIR --out DIR
//   node kit-qa.mjs --selftest     offline: made-up images, a fake API
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import * as claude from "./claude.mjs";
import { KINDS as VR_KINDS } from "./visual-review.mjs";

export const MODEL = "claude-sonnet-5-5";
export const KINDS = [...VR_KINDS, "badge", "plate"];
export const MAX_IMAGES = 40;   // a cap on requests per run (a kit has about 15)
const LEVELS = ["high", "medium", "low"];
const DEMO = ["12-345-67", "1234567", "7654321"];

export const SYSTEM = `You are a meticulous visual QA reviewer for the marketing posts of לוחית (Luchit), an Israeli app that checks a car by its licence plate from the Ministry of Transport's open data. The posts are in Hebrew, right to left, made for Instagram, Facebook and TikTok: carousel slides and a dealer post (1080x1350), stories (1080x1920), a reel cover and frames from a 30-second reel (1080x1920).

Your job is the look a careful designer gives a post before it goes out. Report only real, visible defects of these kinds:
- cut_text: text clipped by its box or the image edge, so letters, digits or words are partly or wholly hidden.
- overlap: two things drawn over each other that should not be: text over text, text over the logo or the Google Play badge.
- rtl: a right-to-left mistake: Hebrew aligned left where the text around it aligns right, a number, date or plate reversed or with its parts in the wrong order, punctuation at the wrong end of a Hebrew sentence, an arrow pointing the wrong way.
- typo: a Hebrew spelling or grammar mistake, a missing or doubled word, English or code inside Hebrew text, a placeholder such as {name}, undefined or NaN, broken characters.
- contrast: text that is hard to read against what is behind it.
- layout: a broken layout: uneven margins that look like a bug, a line alone on its own row by mistake, text so close to an edge that a network's interface will cover it (stories and reels: keep the top 250 and bottom 340 pixels for the network's own buttons, except the badge and small footer text).
- badge: the "GET IT ON Google Play" badge is missing on a post or a reel's last frame, cut, crowded by text, or not readable.
- plate: a licence plate that is not one of the demo plates ${DEMO.join(", ")} (a real-looking plate must never appear), or a real person's name or face.
- other: anything else a person would call visibly broken: an image that did not load, a blank frame, two copies of one element.

These are not defects: the demo plates and the made-up example data; "* המחשה" (it marks a mocked scene on purpose); emoji; a design choice that is consistent and readable; a reel frame in the middle of an animation (text sliding in or fading) when the rest of the frame is fine; bold or coloured words inside a title (the house style marks the key words).

Be strict about evidence: report a defect only when you can point to it, quote on-screen text exactly as it appears, and say where to look. Hebrew letters that look alike (ח and ת, ד and ר, ו and י and ן) are easy to misread: report a typo only where the word is clearly legible, otherwise with confidence "low". Write in English, except for quoted on-screen text. An empty list is the right answer for a post that looks fine, and most posts are fine.

For each defect give: kind; part (1); where; text (the on-screen text, or an empty string); what (what is wrong, quoting the text); severity (high: a person cannot read something, or a rule is broken: badge or plate; medium: clearly visible; low: a small blemish); and confidence (high, medium or low).`;

export const SCHEMA = { type: "object", additionalProperties: false, required: ["issues"], properties: { issues: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["kind", "part", "where", "text", "what", "severity", "confidence"], properties: { kind: { type: "string", enum: KINDS }, part: { type: "integer" }, where: { type: "string" },
    text: { type: "string" }, what: { type: "string" }, severity: { type: "string", enum: LEVELS }, confidence: { type: "string", enum: LEVELS } } } } } };

const IO = { env: process.env, out: s => process.stdout.write(s + "\n"), claude, router: () => import("./alert.mjs"), tg: () => import("./tg-text.mjs"),
  ffmpeg: (args) => execFileSync("ffmpeg", args, { stdio: "ignore" }), probe: f => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" })) };
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const MEDIA = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" };

// what one image is, for the model (the file names are the factory's: carousel-NN, story-NN, dealer-post, reel-cover, frames of the reel)
export function describe(name) {
  if (/^carousel-(\d+)/.test(name)) return `Carousel slide ${+RegExp.$1} (1080x1350, Instagram and Facebook).`;
  if (/^story-(\d+)/.test(name)) return `Story screen ${+RegExp.$1} (1080x1920).`;
  if (/^dealer-post/.test(name)) return "The dealer post (1080x1350): for car lots and trade-in businesses.";
  if (/^reel-cover/.test(name)) return "The reel's cover image (1080x1920).";
  const m = name.match(/^(.+)\.frame-(\d+)of(\d+)/);
  if (m) return `Frame ${+m[2]} of ${+m[3]} of the reel ${m[1]} (1080x1920)${+m[2] === +m[3] ? ", its end card: the Google Play badge belongs here" : ""}.`;
  return "A post image.";
}

// the kit's images: the PNG posts (not their .ig.jpg copies), the reel cover, and frames of every reel when ffmpeg is there
export function images(kit, tmp) {
  const files = fs.readdirSync(kit).sort(), out = [];
  for (const f of files) if (/\.png$/.test(f) || /^reel-cover\.jpe?g$/.test(f)) out.push({ name: f, file: path.join(kit, f) });
  for (const f of files.filter(x => /\.mp4$/.test(x))) {
    let dur = 0; try { dur = IO.probe(path.join(kit, f)); } catch { continue; }
    const at = [0.2, 0.4, 0.6, 0.8].map(x => x * dur).concat([Math.max(0, dur - 0.3)]), base = f.replace(/\.mp4$/, "");
    at.forEach((t, i) => { const o = path.join(tmp, `${base}.frame-${i + 1}of${at.length}.jpg`);
      try { IO.ffmpeg(["-y", "-v", "error", "-ss", t.toFixed(2), "-i", path.join(kit, f), "-frames:v", "1", "-q:v", "3", o]); out.push({ name: path.basename(o), file: o }); } catch { /* no ffmpeg: no frames */ } });
  }
  return out.slice(0, MAX_IMAGES);
}

export const request = img => ({ model: MODEL, max_tokens: 4000, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
  output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
  messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: MEDIA[path.extname(img.file).toLowerCase()] || "image/png", data: fs.readFileSync(img.file).toString("base64") } },
    { type: "text", text: `${describe(img.name)}\nList the defects of this image.` }] }] });

// a finding is a defect with medium or high confidence; low-confidence points are listed apart, as notes
export function sortOut(results) {
  const findings = [], notes = [];
  for (const r of results) for (const i of r.issues || []) (i.confidence === "low" ? notes : findings).push({ image: r.name, ...i });
  const rank = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { findings, notes };
}

const clip = (s, n) => (s = String(s || "")).length > n ? s.slice(0, n - 1) + "…" : s;
export function report({ kit, results, failed, findings, notes }) {
  return [`# Kit visual QA: ${kit}`, "", `${results.length} images looked at by ${MODEL}${failed.length ? `, ${failed.length} could not be (${failed.map(f => f.name).join(", ")})` : ""}.`,
    `${findings.length} findings, ${notes.length} low-confidence notes. Report only: decide each one by looking at the image.`, "",
    "## Findings", ...(findings.length ? findings.map(f => `- **${f.severity} · ${f.kind}** · ${f.image} · ${f.where}: ${clip(f.what, 300)}${f.text ? ` («${clip(f.text, 80)}»)` : ""}`) : ["None."]), "",
    "## Low-confidence notes", ...(notes.length ? notes.map(f => `- ${f.kind} · ${f.image} · ${f.where}: ${clip(f.what, 200)}`) : ["None."]), ""].join("\n");
}

async function tell(kind, why) {
  let router, tg; try { router = await IO.router(); tg = await IO.tg(); } catch { return; }
  if (kind === "key") await router.alert("day", "ai:key", tg.msg({ kind: "today", area: "bots", title: "מפתח ה-Claude API לא עובד או שהקרדיט נגמר",
    text: "הבדיקה הוויזואלית של הערכה השבועית לא רצה.", what: "להדביק מחדש את המפתח או להחליט על הקרדיט", raw: why }));
  else if (kind === "fail") await router.alert("summary", "ai:kitqa", tg.msg({ kind: "info", area: "marketing", title: "הבדיקה הוויזואלית של הערכה השבועית לא הצליחה לפנות ל-Claude",
    text: "הפוסטים עדיין יוצאים כמתוכנן; שרשור השיווק בודק אותם בעין.", raw: why }));
  else await router.resolve(["ai:kitqa", "ai:key"]);
}

export async function main(o) {
  const env = IO.env, say = IO.out, summary = t => { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, t + "\n"); };
  const stop = t => { say(`::notice title=Kit visual QA::skipped: ${t}`); summary(`### Kit visual QA\n\nSkipped: ${t}.\n`); return 0; };
  if (env.KIT_QA === "off") return stop("KIT_QA=off");
  if (!o.kit || !fs.existsSync(o.kit)) return stop("no kit folder");
  const { api, why } = await IO.claude.client(env, { timeout: 5 * 60000 });
  if (!api) return stop(why);
  const tmp = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "kqa-"));
  const imgs = images(o.kit, tmp);
  if (!imgs.length) return stop("no images in the kit");
  const results = [], failed = []; let keyFail = null, lastWhy = "";
  for (let i = 0; i < imgs.length; i += 4) {   // four at a time
    await Promise.all(imgs.slice(i, i + 4).map(async img => {
      const r = await IO.claude.ask(api, request(img));
      if (r.error) { failed.push({ name: img.name, why: r.error.why }); lastWhy = r.error.why; if (r.error.key) keyFail = r.error.why; return; }
      const a = IO.claude.answer(r.msg), j = J(a.text);
      if (!j || !Array.isArray(j.issues)) { failed.push({ name: img.name, why: a.why || "no JSON" }); return; }
      results.push({ name: img.name, issues: j.issues });
    }));
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  const { findings, notes } = sortOut(results), kit = path.basename(o.kit);
  fs.mkdirSync(o.out, { recursive: true });
  fs.writeFileSync(path.join(o.out, "report.md"), report({ kit, results, failed, findings, notes }));
  fs.writeFileSync(path.join(o.out, "report.json"), JSON.stringify({ kit, model: MODEL, images: results.length, failed, findings, notes }, null, 1) + "\n");
  if (keyFail) await tell("key", keyFail);
  else if (failed.length * 5 >= imgs.length) await tell("fail", lastWhy || "no answer");
  else await tell("ok");
  for (const f of findings.slice(0, 10)) say(`::notice title=Kit visual QA: ${f.kind} (${f.severity})::${f.image}, ${clip(f.where, 80)}: ${clip(f.what, 200)}`);
  summary(`### Kit visual QA (${kit}): ${findings.length} findings\n\n${results.length} images, ${notes.length} low-confidence notes${failed.length ? `, ${failed.length} not looked at` : ""}. Report: branch kit-draft-out, qa-${kit}/report.md.\n`);
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, "wrote=1\n");
  return 0;
}

// ---------- selftest (offline) ----------
async function selftest() {
  let n = 0, bad = 0; const ok = (c, m) => { n++; if (!c) { bad++; console.log("FAIL " + m); } };
  const os = await import("node:os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kq-")), kit = path.join(tmp, "2026-11-05");
  fs.mkdirSync(kit);
  for (const f of ["carousel-01.png", "carousel-01.ig.jpg", "story-01.png", "dealer-post.png", "reel-cover.jpg", "reel-x.mp4", "autopost.json"]) fs.writeFileSync(path.join(kit, f), "x");
  ok(KINDS.includes("cut_text") && KINDS.includes("badge") && KINDS.includes("plate"), "the QA thread's kinds plus badge and plate");
  ok(/Carousel slide 1/.test(describe("carousel-01.png")) && /end card/.test(describe("reel-x.frame-5of5.jpg")) && !/end card/.test(describe("reel-x.frame-2of5.jpg")), "each image is described, the reel's last frame as its end card");
  IO.probe = () => 10; IO.ffmpeg = args => fs.writeFileSync(args.at(-1), "f");
  const im = images(kit, tmp).map(i => i.name);
  ok(im.includes("carousel-01.png") && !im.includes("carousel-01.ig.jpg") && im.includes("reel-cover.jpg") && im.filter(x => /frame/.test(x)).length === 5 && !im.includes("autopost.json"), "the posts, the cover and five reel frames; not the .ig.jpg copies");
  IO.ffmpeg = () => { throw new Error("no ffmpeg"); };
  ok(images(kit, tmp).every(i => !/frame/.test(i.name)), "no ffmpeg: no frames, no crash");
  const r = request({ name: "story-01.png", file: path.join(kit, "story-01.png") });
  ok(r.model === MODEL && r.output_config.effort === "medium" && r.output_config.format.schema === SCHEMA && r.system[0].cache_control && r.messages[0].content[0].source.media_type === "image/png", "one Sonnet request per image, medium effort, the schema, a cached instruction");
  const s = sortOut([{ name: "a", issues: [{ kind: "typo", severity: "low", confidence: "high" }, { kind: "badge", severity: "high", confidence: "medium" }, { kind: "rtl", severity: "high", confidence: "low" }] }]);
  ok(s.findings.length === 2 && s.findings[0].kind === "badge" && s.notes.length === 1, "low confidence is a note; findings by severity");
  // a whole run on a fake API
  const told = [];
  IO.env = { ANTHROPIC_API_KEY: "k" }; IO.out = () => {};
  IO.claude = { ...claude, client: async e => e.ANTHROPIC_API_KEY ? { api: {}, why: "" } : { api: null, why: "no ANTHROPIC_API_KEY" },
    ask: async (_, p) => ({ msg: { stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify({ issues: /Story/.test(p.messages[0].content[1].text) ? [{ kind: "cut_text", part: 1, where: "top", text: "בודקים", what: "cut", severity: "high", confidence: "high" }] : [] }) }] } }) };
  IO.router = async () => ({ alert: async (lv, k) => told.push(`${lv} ${k}`), resolve: async p => told.push("resolve " + p.join("+")) });
  IO.tg = async () => ({ msg: o => o.title });
  const out = path.join(tmp, "out");
  ok(await main({ kit, out }) === 0, "a run is green");
  const rep = J(fs.readFileSync(path.join(out, "report.json"), "utf8"));
  ok(rep.findings.length === 1 && rep.findings[0].image === "story-01.png" && /cut_text/.test(fs.readFileSync(path.join(out, "report.md"), "utf8")), "the finding is in report.json and report.md");
  ok(told.includes("resolve ai:kitqa+ai:key") && !/\d{3,}.*token|\$/.test(fs.readFileSync(path.join(out, "report.md"), "utf8")), "a good run closes the alerts; no cost in the report");
  told.length = 0; IO.claude.ask = async () => ({ error: { why: "402 billing", key: true } });
  await main({ kit, out: path.join(tmp, "o2") }); ok(told[0] === "day ai:key", "a spent credit: ai:key (day)");
  told.length = 0; IO.claude.ask = async () => ({ error: { why: "529 server", key: false } });
  await main({ kit, out: path.join(tmp, "o3") }); ok(told[0] === "summary ai:kitqa", "other API errors: ai:kitqa (summary)");
  IO.env = {}; told.length = 0;
  ok(await main({ kit, out: path.join(tmp, "o4") }) === 0 && !fs.existsSync(path.join(tmp, "o4")) && !told.length, "no key: skips, writes nothing");
  IO.env = { KIT_QA: "off", ANTHROPIC_API_KEY: "k" };
  ok(await main({ kit, out: path.join(tmp, "o5") }) === 0 && !fs.existsSync(path.join(tmp, "o5")), "KIT_QA=off skips");
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`selftest: ${n - bad}/${n} passed`); process.exit(bad ? 1 : 0);
}

const a = process.argv.slice(2), opt = k => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
if (process.argv[1] && process.argv[1].endsWith("kit-qa.mjs")) {
  if (a.includes("--selftest")) await selftest();
  else try { process.exitCode = await main({ kit: opt("--kit"), out: opt("--out") || "kit-qa-out" }); }
  catch (e) { IO.out(`::error title=Kit visual QA::it stopped on its own error (${String(e && e.message || e).replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 160)}), not on a finding`); process.exitCode = 1; }
}
