// Visual review (QA thread; Dudu "לבצע" 28.10, use #3 of the monthly API credit): Claude's second look at the screenshots the two look
// guardians take every night, for what their code checks cannot judge: cut text, overlaps, right-to-left mistakes, Hebrew typos, weak
// contrast (dark mode most of all) and broken layouts.
//   app  App guardian (real app): app-real/api<N>/<setting>/shots/*.png, one phone screen each (540 px wide)
//   ui   UI guardian (browser): ui-shots/*.png, whole pages 320 or 390 px wide at 1x, cut into parts as high as its screen (800 px) and
//        drawn at twice the size, where Hebrew letters are big enough to read
// The first look (claude-haiku-5-5) sees every shot that is new or changed; the second look (claude-sonnet-5-5) sees only the shots the
// first look found something on, and confirms or rejects each point. A finding is a point the second look confirmed. A shot that looks as
// the one judged before (under 0.2% of its pixels changed: the clock, a date) on the same app code keeps that verdict and is not sent
// again, so a quiet night costs next to nothing and a finding is new only on the night it first appears.
// Report only (until its false findings are measured): a finding never fails a run. No key, VISUAL_REVIEW=off or no screenshots: it skips.
// An API error: the shots wait for the next run, and the router hears ai:shots (summary), or ai:key (day) when the key or the credit is
// the cause; the next good run closes them. Only a crash of this script is red, which Failure alert reports (summary).
// A shot the guardians stopped taking leaves the state after 14 days.
// The screenshots hold only the guardians' made-up test cars (the sample plates and the fixtures' own numbers, nothing from the registry):
// only files named as the guardians name them are read, and the workflow takes them only from runs of the two guardians.
// State and report: branch visual-review-out, a folder per guardian (state.json, report.md, report.json, reviewed/ = each shot as judged).
// The repo is public: they hold findings and counts of shots, never tokens or dollars, which go to usage/*.enc.json, encrypted with
// .github/seo-data.pub.pem (reviews-monitor's format). The caps are counts of requests, per run and per calendar month, so the spend is
// bounded without a dollar figure in public; beyond a cap the rest waits for the next run, the oldest verdict first.
// Node 20, node: builtins and ./claude.mjs (its SDK installed by the workflow). Commands:
//   node visual-review.mjs --source app|ui --shots DIR --state DIR [--code ID] [--mode batch|sync] [--run URL]
//   node visual-review.mjs selftest     offline: made-up screenshots, a fake API
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as claude from "./claude.mjs";

export const V = 5;   // the prompt and the schemas: a new V judges every shot again (3: the non-defects of the first real runs, 28.10, and text;
// 4: the second look judges the defect itself, more carefully, and says why it rejects a point; 5: a cut placeholder and a cut at a large
// font are defects, which the second look had read as allowed)
export const MODELS = { first: "claude-haiku-5-5", second: "claude-sonnet-5-5" };
export const CAPS = { runFirst: 300, runSecond: 40, monthFirst: 4000, monthSecond: 400 };
// a point goes on to the second look from severity x confidence 3 up (each high 3, medium 2, low 1): medium/medium, low but sure, high but
// unsure. In the first real run (28.10, 66 app shots) every true defect came at 4 or more and every point below 3 the second look kept was
// a false one, so points under the bar stay first-look notes, counted in the report, at no cost
export const BAR = 3;
export const SAME = 0.002, PART = 800, SCALE = 2, SHORT = 200, CHUNK = 40, POOL = 4, TRIES = 2;
export const KINDS = ["cut_text", "overlap", "rtl", "typo", "contrast", "layout", "other"];
const LEVELS = ["high", "medium", "low"];
// $ per million tokens (prompts up to 100K tokens), for the encrypted usage file only: a cache write is 1.25x, a cache read 0.1x, a Batch half
const PRICE = { [MODELS.first]: [0.10, 0.50], [MODELS.second]: [2, 10] };

const IO = { env: process.env, out: s => process.stdout.write(s + "\n"), now: () => Date.now(), claude, router: () => import("./alert.mjs"),
  lexicon: () => lexicon(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")),
  pub: () => fs.readFileSync(new URL("../seo-data.pub.pem", import.meta.url), "utf8"), wait: { minutes: 90, every: 30 } };   // a Batch: most end in minutes; at 90 the rest is cancelled and waits
const J = s => { try { return JSON.parse(s); } catch { return null; } };
const read = f => { try { return fs.readFileSync(f); } catch { return null; } };

// ---- PNG, enough for screenshots: 8-bit grey, RGB, grey+alpha or RGBA, not interlaced; kept as RGB (a screenshot has no transparency)
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readPng(buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error("not a PNG");
  let p = 8, w = 0, h = 0, depth = 0, type = -1, inter = 0; const idat = [];
  while (p + 8 <= buf.length) {
    const len = buf.readUInt32BE(p), kind = buf.toString("latin1", p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (kind === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; inter = data[12]; }
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    p += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || inter || !w || !h) throw new Error(`a PNG this does not read (depth ${depth}, type ${type}, interlace ${inter})`);
  const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * ch, rgb = Buffer.alloc(w * h * 3);
  if (raw.length < h * (stride + 1)) throw new Error("a PNG cut short");
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), f = raw[o];
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0, v = raw[o + 1 + i];
      cur[i] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1)
        : v + (Math.abs(b - c) <= Math.abs(a - c) && Math.abs(b - c) <= Math.abs(a + b - 2 * c) ? a : Math.abs(a - c) <= Math.abs(a + b - 2 * c) ? b : c);
    }
    for (let x = 0, d = y * w * 3; x < w; x++, d += 3) {
      const i = x * ch;
      if (ch >= 3) { rgb[d] = cur[i]; rgb[d + 1] = cur[i + 1]; rgb[d + 2] = cur[i + 2]; } else rgb[d] = rgb[d + 1] = rgb[d + 2] = cur[i];
    }
    [prev, cur] = [cur, prev];
  }
  return { w, h, rgb };
}
// RGB, each row filtered Sub or Up, whichever is smaller (a part drawn at twice the size repeats every row, which Up turns into zeros)
export function writePng({ w, h, rgb }) {
  const stride = w * 3, raw = Buffer.alloc(h * (stride + 1)), sub = Buffer.alloc(stride), up = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const s = y * stride; let a = 0, b = 0;
    for (let i = 0; i < stride; i++) {
      sub[i] = rgb[s + i] - (i >= 3 ? rgb[s + i - 3] : 0); up[i] = rgb[s + i] - (y ? rgb[s + i - stride] : 0);
      a += sub[i] < 128 ? sub[i] : 256 - sub[i]; b += up[i] < 128 ? up[i] : 256 - up[i];
    }
    raw[y * (stride + 1)] = a <= b ? 1 : 2; (a <= b ? sub : up).copy(raw, y * (stride + 1) + 1);
  }
  const chunk = (kind, data) => { const k = Buffer.from(kind, "latin1"), b = Buffer.alloc(12 + data.length); b.writeUInt32BE(data.length, 0); k.copy(b, 4); data.copy(b, 8);
    b.writeUInt32BE(crc32(Buffer.concat([k, data])), 8 + data.length); return b; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}
export const tryPng = buf => { try { return readPng(buf); } catch { return null; } };

// rows y0..y0+hh of an image, each pixel drawn k x k
export function crop(img, y0, hh, k = 1) {
  const w = img.w * k, h = hh * k, rgb = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const sr = (y0 + Math.floor(y / k)) * img.w * 3, dr = y * w * 3;
    for (let x = 0; x < w; x++) { const s = sr + Math.floor(x / k) * 3, d = dr + x * 3; rgb[d] = img.rgb[s]; rgb[d + 1] = img.rgb[s + 1]; rgb[d + 2] = img.rgb[s + 2]; }
  }
  return { w, h, rgb };
}
// a whole website page in parts as high as the guardian's screen, the last one longer rather than a sliver under SHORT px; a phone shot is one part
export function parts(img, source) {
  if (source !== "ui") return [img];
  const cuts = [];
  for (let y = 0; y < img.h; y += PART) cuts.push([y, Math.min(PART, img.h - y)]);
  if (cuts.length > 1 && cuts[cuts.length - 1][1] < SHORT) cuts[cuts.length - 2][1] += cuts.pop()[1];
  return cuts.map(([y, hh]) => crop(img, y, hh, SCALE));
}
// the share of pixels that differ visibly between two images; 1 when one is missing or the sizes differ
export function changed(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return 1;
  let n = 0;
  for (let i = 0; i < a.rgb.length; i += 3) if (Math.abs(a.rgb[i] - b.rgb[i]) + Math.abs(a.rgb[i + 1] - b.rgb[i + 1]) + Math.abs(a.rgb[i + 2] - b.rgb[i + 2]) > 48) n++;
  return n / (a.w * a.h);
}

// ---- the shots: only the names the guardians give them
export function collect(source, dir) {
  const files = [], walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith(".png")) files.push(f); } };
  if (dir && fs.existsSync(dir)) walk(dir);
  return files.map(file => {
    const rel = path.relative(dir, file).split(path.sep).join("/");
    if (source === "app") {
      const m = /^api(\d{2})\/((?:\d{3}-f\d{3}|\d{3}-extra))\/shots\/(\2__[A-Za-z0-9_-]+)\.png$/.exec(rel);   // a setting's "-first-try" folder: the try the emulator lost
      return m ? { key: `api${m[1]}/${m[3]}`, file, api: +m[1], setting: m[2], name: m[3] } : null;
    }
    const m = /^([a-z0-9-]+-(?:320|390)-(?:light|dark))\.png$/.exec(rel);   // ui-shots/diff/ holds the guardian's diff pictures, not screens
    return source === "ui" && m ? { key: m[1], file, name: m[1] } : null;
  }).filter(Boolean).sort((a, b) => (a.key < b.key ? -1 : 1));
}

const FIXTURES = { "petrol-clean": "a petrol car with nothing open", "test-soon": "a car whose yearly test is due in 18 days", "test-expired": "a car whose yearly test ran out 30 days ago",
  ev: "an electric car", owner: "the person's own car, with a service log", "open-recall": "a car with an open recall", "settlement-only": "a car with a class-action settlement and no open recall",
  checked: "a car checked against the recall list, nothing found", "maybe-recall": "a car whose model has a recall that may apply to it", "recall-unknown": "a car whose recall check failed (the registry did not answer)",
  "list-reloading": "a car whose recall list is being loaded again", "saved-copy": "a saved copy of a check from 12 days ago" };
const TABS = { overview: "the overview tab (סקירה)", recalls: "the recalls tab (ריקולים)", buy: "the buying tab (קנייה)", specs: "the specifications tab (מפרט)", file: "the car's file tab (תיק הרכב)" };
const SCREENS = { home: "the home screen with saved cars", "home-new": "the home screen on a first visit", cars: "my cars (הרכבים שלי) as a list", "cars-table": "my cars as a table",
  "cars-empty": "my cars with no car saved", alerts: "the alerts screen (התראות)", bulk: "the tool that checks several cars at once" };
// what the model is told about one shot: where it comes from and what is on purpose in it
export function describe(s, n = 1) {
  if (s.api) {
    const m = /^(\d{3})-f(\d{3})$/.exec(s.setting), [, theme = "", screen = "", step = ""] = s.name.split("__"), notes = [];
    if (/launch/.test(s.name)) notes.push("taken while the app is starting, so a plain screen in the theme's colour is expected");
    if (/keyboard/.test(s.name)) notes.push("the on-screen keyboard is open on purpose");
    if (/landscape/.test(s.name)) notes.push("the phone is turned sideways");
    if (/entry/.test(s.name)) notes.push("the app was opened from outside (a link, a shortcut or a notification)");
    if (/^auto-/.test(theme)) notes.push("the phone itself is set to " + (/dark/.test(theme) ? "dark" : "light") + " mode and the app follows it");
    const where = m ? `a phone ${m[1]} dp wide with the font size at ${+m[2]}%` : "a phone 411 dp wide with the font size at 100%";
    return `The Android app (the page in a WebView) on ${{ 31: "Android 12", 35: "Android 15" }[s.api] || "Android API " + s.api}, ${where}. Screenshot "${s.name}"`
      + (m ? ` (${theme} theme; screen ${screen}; journey step ${step})` : "") + ". One phone screen." + (notes.length ? " Note: " + notes.join("; ") + "." : "");
  }
  const m = /^(.*)-(\d{3})-(light|dark)$/.exec(s.name) || [], what = m[1] || s.name, t = /^(.*)-(overview|recalls|buy|specs|file)$/.exec(what), sc = /^screen-(.*)$/.exec(what);
  const screen = t ? `a car's page: ${FIXTURES[t[1]] || t[1]}, on ${TABS[t[2]]}` : sc ? SCREENS[sc[1]] || sc[1] : what;
  return `The website luchit.app in a phone browser (Chromium), ${m[2] || "?"} px wide, ${m[3] || "?"} theme: ${screen}. Screenshot "${s.name}". `
    + (n > 1 ? `The whole page in ${n} parts, top to bottom without overlap, each drawn at twice its size. Part 1 is what the screen shows first, so the `
      + "bottom navigation bar and the floating buttons, which stay fixed on the screen, appear at the bottom of part 1 only. A line or a card cut at the top "
      + "or bottom edge of a part goes on in the next part and is not a defect." : "The whole page in one part, drawn at twice its size.");
}

// one instruction for both looks (cached: it is the same in every request of a model)
export const SYSTEM = `You are a meticulous visual QA reviewer for לוחית (Luchit), an Israeli car-check service in Hebrew: a person types a licence plate number and sees the car's public record from the Ministry of Transport (tests, recalls, owners, price). It is an Android app (the page in a WebView) and the same page is the website luchit.app. The interface is in Hebrew and right to left.

You receive screenshots that automated test runs took of the real app and website, filled with made-up test data. Code checks already measure overflow, tap target sizes, font sizes and accessibility rules. Your job is the second look a careful human tester gives a screen: find what a person would see is broken and code cannot judge.

Report only real, visible defects of these kinds:
- cut_text: text clipped by its box, a button, a card or the screen edge, so letters, digits or words are partly or wholly hidden: also the example text (placeholder) of an empty input, and also at the large font sizes. A one-line label that ends in an ellipsis (…) on purpose is not a defect.
- overlap: two things drawn over each other that should not be: text over text, an icon or a label on top of other words, a button covering words that cannot scroll out from under it.
- rtl: a right-to-left mistake: Hebrew text aligned to the left where the text around it aligns right; an arrow or chevron pointing the wrong way for what it does (right to left, "next" or "open" points left and "back" points right); a number, date, plate or phone number shown reversed or with its parts in the wrong order; punctuation at the wrong end of a Hebrew sentence.
- typo: a Hebrew spelling or grammar mistake, a wrong or missing word, a gender or number mismatch, English or code left inside Hebrew text, a placeholder such as {name}, undefined or NaN, broken characters (boxes, question marks).
- contrast: text or an icon that is hard to read against what is behind it, for example grey text on a dark card in dark mode or white text on a light colour. Readable secondary grey text is fine.
- layout: a broken layout: a single control dropped alone onto its own line, misaligned rows or columns, a card or button wider than the screen, spacing so uneven it looks like a bug, a large empty area where content should be, something cut off by a side of the screen in a part that does not scroll sideways.
- other: anything else a person would call visibly broken, such as a missing icon, an image that did not load, or two copies of one element.

These are not defects, do not report them:
- The test data itself: plates such as 12-345-67, 1234567, 7654321, 385-48-003 or 111-22-233, and the car names, prices, dates and counts, are invented for the test. Car makes and models may be in English inside Hebrew text (טויוטה COROLLA).
- Android's own parts: the status bar at the top (time, battery, notification icons), the navigation bar at the bottom or at the side, and the on-screen keyboard.
- Large font settings (130% and 200%): text that is bigger, wraps onto more lines or makes a card taller is correct there. Clipping, overlap or a broken layout there is a defect as at any size: the app must work at the font size a person chose.
- Scrolling: content that goes on below the bottom of a phone screen, below the end of a part of a long page, or under the app's bottom navigation bar, even in the middle of a sentence; a floating button (such as השוואה) or a bar fixed to the screen, drawn over content that scrolls under it; a row of cards that scrolls sideways, with its last card cut at the screen edge.
- Text shortened on purpose with an ellipsis (…), and a loading message that ends in one.
- A notification badge (a small red circle, often with a number) on the corner of its icon, even where it covers part of the icon.
- Empty inputs: the example text (placeholder), such as 12-345-67, is dimmer than typed text on purpose, in grey or in a darker shade of the field's colour; that dimness is not a defect, but a placeholder cut at the edge of its box is cut_text. An empty input under its own label may show only its unit (₪) or nothing.
- Arrows and chevrons that point left to open something or to go forward: in right to left that is the right way.
- Design choices: colours, fonts, sizes, icons and wording that are consistent and readable, even where you would design them differently.

Be strict about evidence: report a defect only when you can point to it in the screenshot, and say exactly where to look. Quote on-screen text exactly as it appears. Hebrew letters that look alike (ח and ת, ד and ר, ו and י and ן) are easy to misread, all the more in small or very large text: report a typo only where the word is clearly legible, and when the word you read is one letter away from a common word, give it confidence "low". When you are unsure, report it with confidence "low" rather than not at all. Write in English, except for quoted on-screen text. An empty list is the right answer for a screen that looks fine, and most screens are fine.

For each defect give: kind; part (the number of the image it is in, 1 when there is one image); where (the part of the screen, such as "the car card's header", "the bottom navigation bar", "the second card in the list"); text (the on-screen text the defect is about, copied exactly as you read it on the screen, or an empty string when there is none); what (what is wrong, quoting the text); severity (high: a person cannot read or use something; medium: clearly visible but usable; low: a small blemish); and confidence (high, medium or low).`;

const ISSUE = { kind: { type: "string", enum: KINDS }, part: { type: "integer" }, where: { type: "string" }, text: { type: "string" }, what: { type: "string" }, severity: { type: "string", enum: LEVELS } };
export const FIRST = { type: "object", additionalProperties: false, required: ["issues"], properties: { issues: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["kind", "part", "where", "text", "what", "severity", "confidence"], properties: { ...ISSUE, confidence: { type: "string", enum: LEVELS } } } } } };
export const SECOND = { type: "object", additionalProperties: false, required: ["checked"], properties: { checked: { type: "array", items: { type: "object", additionalProperties: false,
  required: ["claim", "real", "kind", "part", "where", "text", "what", "severity", "why"], properties: { claim: { type: "integer" }, real: { type: "boolean" }, ...ISSUE, why: { type: "string" } } } } } };

const image = png => ({ type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } });
const claimsText = issues => issues.map((i, n) => `${n + 1}. ${i.kind}, part ${i.part}, ${i.where}: ${i.what} (severity ${i.severity}, confidence ${i.confidence})`).join("\n");
// one request about the shot as judged (s.judged): a phone shot as it is, a page in its parts; null when the file is not a PNG this reads
export function params(look, s) {
  const img = s.api ? null : tryPng(read(s.judged)), shots = s.api ? [read(s.judged)].filter(b => b && b.subarray(0, 8).equals(SIG)) : img ? parts(img, "ui").map(writePng) : [];
  if (!shots.length) return null;
  s.n = shots.length;
  const ask = look === "first" ? "Find the visible defects on this screen."
    : `A quicker first look at this screen reported these possible defects:\n${claimsText(worth(s.entry))}\nCheck each one against the screenshot. The first look can get details wrong (the cause, the exact place, typed text or a placeholder): judge the defect itself. For cut text, read the text at the edge one letter or digit at a time and compare it with the whole word or number it should be (the example plate is 12-345-67): a letter or digit drawn only in part, or missing at the edge of its box (12-345- where 12-345-67 should be), is a cut. real is true only when you can see that defect, and why says what you saw. Keep its number as claim. Then add any other clear defect it missed, with claim 0.`;
  // the second look at effort medium: at low it rejected 4 of the 9 true points of 28.10 (the same cut plate example it confirmed on other shots)
  return { model: MODELS[look], max_tokens: look === "first" ? 4000 : 8000, system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { effort: look === "first" ? "low" : "medium", format: { type: "json_schema", schema: look === "first" ? FIRST : SECOND } },
    messages: [{ role: "user", content: [...shots.map(image), { type: "text", text: `${describe(s, shots.length)}\n${ask}` }] }] };
}

const clip = (t, n = 300) => String(t || "").replace(/\s+/g, " ").trim().slice(0, n);
// the Hebrew words of a text (two letters or more, without vowel marks)
export const hebrew = t => String(t || "").replace(/[\u0591-\u05C7]/g, "").match(/[\u05D0-\u05EA]{2,}/g) || [];
// every Hebrew word in the repository's own text: the page, its scripts and data, the guardians' fixtures, the Android app. A typo must quote
// a word that is there; one that is not is a misreading of the screenshot (28.10: the footer's "מדריך לקונה" read as "מדריך לקנה"). Empty
// outside a checkout, and then no typo is dropped.
export function lexicon(root) {
  const set = new Set();
  try {
    const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] }).toString().split("\0");
    const self = path.relative(root, fileURLToPath(import.meta.url)).split(path.sep).join("/");   // this file quotes misreadings in its notes and tests
    for (const f of files.filter(f => f !== self && /\.(html|m?js|cjs|json|xml|java|kt|txt)$/.test(f))) { const b = read(path.join(root, f)); if (b && b.length < 8e6) for (const w of hebrew(b.toString("utf8"))) set.add(w); }
  } catch { /* not a checkout */ }
  return set;
}
const issue = (i, n) => (i && KINDS.includes(i.kind) && LEVELS.includes(i.severity) ? { kind: i.kind, part: Math.min(Math.max(1, Math.round(+i.part) || 1), n), where: clip(i.where, 120),
  text: clip(i.text, 200), what: clip(i.what),
  severity: i.severity, ...(LEVELS.includes(i.confidence) ? { confidence: i.confidence } : {}) } : null);
const lv = x => { const k = LEVELS.indexOf(x); return k < 0 ? 1 : 3 - k; };   // high 3, medium 2, low (or none) 1
const weight = i => lv(i.severity) * lv(i.confidence);
const worth = e => (e.first?.issues || []).filter(i => weight(i) >= BAR);   // the first look's points the second look checks
const score = e => Math.max(0, ...(e.first?.issues || []).map(weight));
// one defect, as two looks quote it: the same kind, and the same text or, from 4 characters, one inside the other ("12-345-6" and
// "12-345-67"), spaces aside; a short text such as a badge's "1" only as itself
const flat = t => String(t || "").replace(/\s+/g, "");
const alike = (a, b) => { const x = flat(a.text), y = flat(b.text);
  return a.kind === b.kind && !!x && !!y && (x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)))); };

// ---- the state on branch visual-review-out
// known: every confirmed defect (kind, text, first and last night), so the same one on another shot, or after a new V judged every shot
// again, is not new
export function loadState(dir) {
  const j = J(read(path.join(dir, "state.json"))) || {};
  const prior = Object.values(j.shots || {}).flatMap(e => (e?.second?.issues || []).map(i => ({ kind: i.kind, text: i.text, since: i.since, seen: e.seen || i.since })));
  const known = [...(Array.isArray(j.known) ? j.known : []), ...prior].filter(k => k && KINDS.includes(k.kind) && flat(k.text) && /^\d{4}-\d{2}-\d{2}$/.test(k.since || ""));
  return { v: V, month: j.month || "", used: { first: j.used?.first || 0, second: j.used?.second || 0 }, shots: j.v === V && j.shots ? j.shots : {}, fails: j.v === V && j.fails ? j.fails : {}, known };
}

// requests to the API, in a Batch (half price; several at once, CHUNK shots each, so no request body grows past the Batch limit) or one by one
// (POOL at a time); jobs: [{id, make()}] -> Map id -> {ok, msg} | {ok:false, why, answer} (answer: the shot itself is the problem, not the
// API), and whether the key or the credit was the cause
const UNREADABLE = { ok: false, why: "the screenshot is not a PNG this reads", answer: true };
async function send(api, jobs, mode) {
  const out = new Map(); let key = false;
  if (mode === "batch") {
    const chunks = []; for (let i = 0; i < jobs.length; i += CHUNK) chunks.push(jobs.slice(i, i + CHUNK));
    await Promise.all(chunks.map(async list => {
      const reqs = list.map(j => ({ custom_id: j.id, params: j.make() })).filter(q => q.params || (out.set(q.custom_id, UNREADABLE), false));
      if (!reqs.length) return;
      let r = await IO.claude.batch(api, reqs, { ...IO.wait, cancel: true });
      if (r.id && !r.ended && r.error) r = { id: r.id, ...await IO.claude.collect(api, r.id, { minutes: 10, every: 15, cancel: true }) };   // the wait broke: stop it and keep what it did
      if (r.error?.key) key = true;
      for (const q of reqs) out.set(q.custom_id, r.results?.get(q.custom_id) || { ok: false, why: r.error?.why || (r.ended === false ? "not done in time" : "no result") });
    }));
    return { out, key };
  }
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < jobs.length && !key) {
      const j = jobs[next++], p = j.make();
      if (!p) { out.set(j.id, UNREADABLE); continue; }
      const r = await IO.claude.ask(api, p);
      if (r.error?.key) key = true;
      out.set(j.id, r.msg ? { ok: true, msg: r.msg } : { ok: false, why: r.error?.why || "no reply" });
    }
  }));
  for (const j of jobs) if (!out.has(j.id)) out.set(j.id, { ok: false, why: "not sent (the key failed)" });
  return { out, key };
}

const cost = (model, u, half) => { const [i, o] = PRICE[model] || [0, 0]; return (u.input * i + u.cacheWrite * i * 1.25 + u.cacheRead * i * 0.1 + u.output * o) / 1e6 / (half ? 2 : 1); };
function seal(obj) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([ci.update(JSON.stringify(obj)), ci.final()]);
  const ek = crypto.publicEncrypt({ key: IO.pub(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  return JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") });
}

export async function run(o) {
  const env = IO.env, say = IO.out, note = t => say(`::notice title=Visual review (${o.source})::${t}`);
  const stop = t => { note("skipped: " + t); summary(`### Visual review (${o.source})\n\nSkipped: ${t}.\n`); return 0; };
  if (String(env.VISUAL_REVIEW || "").trim().toLowerCase() === "off") return stop("the repo variable VISUAL_REVIEW is off");
  const list = collect(o.source, o.shots);
  if (!list.length) return stop("no screenshots of the guardian in " + (o.shots || "(no folder)"));
  const { api, why } = await IO.claude.client(env);
  if (!api) { if (env.ANTHROPIC_API_KEY) await tell(false, why, false, o); return stop(why); }   // a key without the SDK is a broken install, not off
  const st = loadState(o.state), at = new Date(IO.now()).toISOString(), day = at.slice(0, 10), month = at.slice(0, 7), code = o.code || "";
  if (st.month !== month) Object.assign(st, { month, used: { first: 0, second: 0 } });
  const before = Object.fromEntries(Object.entries(st.shots).map(([k, e]) => [k, e.second?.issues || []]));
  const judged = k => path.join(o.state, "reviewed", k + ".png");
  // 1. a shot that looks as the one judged before, on the same app code, keeps its verdict
  const fresh = [];
  for (const s of list) {
    const e = st.shots[s.key], now = read(s.file), then = e && e.code === code ? read(judged(s.key)) : null;
    const a = then && tryPng(then), b = then && tryPng(now);
    s.same = !!then && (a && b ? changed(a, b) < SAME : then.equals(now));
    if (!s.same) fresh.push(s);
  }
  // 2. the first look, oldest verdict first, within the caps
  fresh.sort((x, y) => (st.shots[x.key]?.at || "").localeCompare(st.shots[y.key]?.at || "") || (x.key < y.key ? -1 : 1));
  const firstN = Math.max(0, Math.min(CAPS.runFirst, CAPS.monthFirst - st.used.first)), first = fresh.slice(0, firstN), tally = { requests: {}, tokens: {}, usd: 0 };
  const count = (model, msg, half) => { const u = IO.claude.usage(msg), t = tally.tokens[model] ||= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const k in t) t[k] += u[k]; tally.usd += cost(model, u, half); };
  const errors = [], half = o.mode === "batch";
  let lex = null;   // read once, when the first typo comes
  const misread = i => { if (i.kind !== "typo") return false; const ws = hebrew(i.text); if (!ws.length) return false; lex ||= IO.lexicon(); return lex.size > 0 && ws.some(w => !lex.has(w)); };
  const sift = list => { const out = list.filter(Boolean), mis = out.filter(misread).length; return { issues: out.filter(i => !misread(i)), ...(mis ? { misread: mis } : {}) }; };
  let ok = 0, keyFail = false;
  const failed = (s, why) => { errors.push(why); const f = st.fails[s.key] = { code, n: (st.fails[s.key]?.code === code ? st.fails[s.key].n : 0) + 1, why, at };
    if (f.n >= TRIES) { st.shots[s.key] = { code, at, first: { failed: why }, second: null }; fs.mkdirSync(path.dirname(judged(s.key)), { recursive: true }); fs.copyFileSync(s.file, judged(s.key)); } };
  if (first.length) {
    for (const s of first) s.judged = s.file;
    const jobs = first.map((s, i) => ({ id: "f" + i, s, make: () => params("first", s) }));
    st.used.first += jobs.length; tally.requests[MODELS.first] = jobs.length;
    const r = await send(api, jobs, o.mode); keyFail ||= r.key;
    for (const j of jobs) {
      const res = r.out.get(j.id), s = j.s;
      if (!res?.ok) { if (res?.answer) failed(s, res.why); else errors.push(res?.why || "no result"); continue; }   // an API error: the shot waits for the next run
      ok++; count(MODELS.first, res.msg, half);
      const a = IO.claude.answer(res.msg), js = !a.why && J(a.text);
      if (/^refusal/.test(a.why)) { st.shots[s.key] = { code, at, first: { refused: a.why }, second: null }; }
      else if (!js || !Array.isArray(js.issues)) { failed(s, a.why || "the answer was not the JSON asked for"); continue; }
      else st.shots[s.key] = { code, at, first: sift(js.issues.map(i => issue(i, s.n || 99))), second: null };
      delete st.fails[s.key]; fs.mkdirSync(path.dirname(judged(s.key)), { recursive: true }); fs.copyFileSync(s.file, judged(s.key));
    }
  }
  // 3. the second look, on the shots the first look found something on (this run's or an earlier one's), most serious first
  const byKey = Object.fromEntries(list.map(s => [s.key, s]));
  const waiting = Object.entries(st.shots).filter(([k, e]) => byKey[k] && score(e) >= BAR && !e.second).sort(([, a], [, b]) => score(b) - score(a) || a.at.localeCompare(b.at));
  const secondN = keyFail ? 0 : Math.max(0, Math.min(CAPS.runSecond, CAPS.monthSecond - st.used.second)), second = waiting.slice(0, secondN).map(([k, e]) => Object.assign(byKey[k], { entry: e, judged: judged(k) }));
  if (second.length) {
    const jobs = second.map((s, i) => ({ id: "s" + i, s, make: () => params("second", s) }));
    st.used.second += jobs.length; tally.requests[MODELS.second] = jobs.length;
    const r = await send(api, jobs, o.mode); keyFail ||= r.key;
    for (const j of jobs) {
      const res = r.out.get(j.id), s = j.s, e = s.entry;
      const flop = why => { errors.push(why); if ((e.tries2 = (e.tries2 || 0) + 1) >= TRIES) e.second = { failed: why, at }; };   // the same answer problem twice: stop asking
      if (!res?.ok) { if (res?.answer) flop(res.why); else errors.push(res?.why || "no result"); continue; }
      ok++; count(MODELS.second, res.msg, half);
      const a = IO.claude.answer(res.msg), js = !a.why && J(a.text);
      if (/^refusal/.test(a.why)) { e.second = { refused: a.why, at }; continue; }
      if (!js || !Array.isArray(js.checked)) { flop(a.why || "the answer was not the JSON asked for"); continue; }
      const asked = worth(e), n = asked.length, seen = before[s.key] || [];
      const kept = sift(js.checked.filter(c => c && c.real === true).map(c => issue(c, s.n || 99)));
      const no = js.checked.filter(c => c && c.real === false && c.claim >= 1 && c.claim <= n);
      // a point keeps the night it was first confirmed: on this shot, or on another shot or under an earlier V (the same kind and text)
      const since = i => [seen.find(x => x.kind === i.kind)?.since, st.known.find(k => alike(k, i))?.since, day].filter(Boolean).sort()[0];
      e.second = { ...kept, issues: kept.issues.map(i => ({ ...i, since: since(i) })),
        rejected: no.length, ...(no.length ? { notes: no.map(c => ({ claim: clip(asked[c.claim - 1].what, 160), why: clip(c.why, 200) })) } : {}), at };
      delete e.tries2;
    }
  }
  // 4. the report, the state, the usage, the router; a shot not taken for 14 days (renamed or dropped by its guardian) leaves the state
  const gone = new Date(IO.now() - 14 * 864e5).toISOString().slice(0, 10);
  for (const s of list) if (st.shots[s.key]) st.shots[s.key].seen = day;
  for (const [k, e] of Object.entries(st.shots)) if (!byKey[k] && (e.seen || e.at.slice(0, 10)) < gone) { delete st.shots[k]; fs.rmSync(judged(k), { force: true }); }
  for (const k of Object.keys(st.fails)) if (!byKey[k]) delete st.fails[k];
  const sent = first.length + second.length, failedShare = sent ? errors.length / sent : 0;
  const findings = list.flatMap(s => (st.shots[s.key]?.second?.issues || []).map(i => ({ shot: s.key, ...i, new: i.since === day })));
  for (const f of findings.filter(x => flat(x.text))) {
    const k = st.known.find(x => alike(x, f));
    if (k) Object.assign(k, { since: k.since < f.since ? k.since : f.since, seen: day }); else st.known.push({ kind: f.kind, text: f.text, since: f.since, seen: day });
  }
  const merged = [];   // one entry per defect, with its first and last night; one not seen for 14 days goes
  for (const k of st.known) { const m = merged.find(x => alike(x, k));
    if (!m) merged.push({ ...k }); else Object.assign(m, { since: m.since < k.since ? m.since : k.since, seen: (m.seen || "") > (k.seen || "") ? m.seen : k.seen }); }
  st.known = merged.filter(k => (k.seen || k.since) >= gone).slice(-300);
  // the points the second look rejected, with its reason: kept in the report while the review is report only, to measure what it misses
  const dropped = list.flatMap(s => (st.shots[s.key]?.second?.notes || []).map(x => ({ shot: s.key, ...x })));
  const pending = list.filter(s => st.shots[s.key] && score(st.shots[s.key]) >= BAR && !st.shots[s.key].second).map(s => ({ shot: s.key, issues: st.shots[s.key].first.issues }));
  const unsure = list.filter(s => st.shots[s.key]?.first?.issues?.length && score(st.shots[s.key]) < BAR).length;
  const rejected = list.reduce((n, s) => n + (st.shots[s.key]?.second?.rejected || 0), 0);
  const misreads = list.reduce((n, s) => n + (st.shots[s.key]?.first?.misread || 0) + (st.shots[s.key]?.second?.misread || 0), 0);
  const counts = { shots: list.length, kept: list.filter(s => s.same).length, first: first.length, second: second.length, waitingFirst: fresh.length - first.length,
    waitingSecond: pending.length, unsure, errors: errors.length, findings: findings.length, new: findings.filter(f => f.new).length, rejected, misreads };
  const report = { v: V, at, source: o.source, run: o.run || "", code, mode: o.mode, counts, month: { first: st.used.first, second: st.used.second, caps: CAPS }, findings, pending,
    dropped, errors: [...new Set(errors)].slice(0, 10) };
  fs.mkdirSync(path.join(o.state, "usage"), { recursive: true });
  fs.writeFileSync(path.join(o.state, "state.json"), JSON.stringify({ v: V, month: st.month, used: st.used, shots: st.shots, fails: st.fails, known: st.known }, null, 1) + "\n");
  fs.writeFileSync(path.join(o.state, "report.json"), JSON.stringify(report, null, 1) + "\n");
  const md = reportMd(report);
  fs.writeFileSync(path.join(o.state, "report.md"), md);
  try { if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, "wrote=1\n"); } catch { /* the workflow then keeps the branch as it was */ }
  if (sent) {
    fs.writeFileSync(path.join(o.state, "usage", `${at.replace(/[:.]/g, "-")}.enc.json`), seal({ at, source: o.source, mode: o.mode, requests: tally.requests, tokens: tally.tokens, usd: +tally.usd.toFixed(4) }));
    const old = fs.readdirSync(path.join(o.state, "usage")).filter(f => f.endsWith(".enc.json")).sort().slice(0, -62);
    for (const f of old) fs.rmSync(path.join(o.state, "usage", f));
  }
  summary(md);
  say(`visual review ${o.source}: ${counts.shots} shots, ${counts.kept} kept their verdict, ${counts.first} first looks, ${counts.second} second looks, `
    + `${counts.findings} findings (${counts.new} new), ${counts.waitingFirst + counts.waitingSecond} waiting, ${counts.errors} errors`);
  for (const f of findings.filter(x => x.new).slice(0, 10)) say(`::notice title=Visual review: ${f.kind} (${f.severity})::${f.shot}, part ${f.part}, ${clip(f.where, 80)}: ${clip(f.what, 200)}`);
  if (errors.length) note(`${errors.length} of ${sent} requests got no answer (${report.errors.slice(0, 3).join("; ")}); those shots wait for the next run`);
  await tell(keyFail, sent && failedShare >= 0.2 && !keyFail ? report.errors[0] : "", ok > 0 && !errors.length, o);
  return 0;
}

// the router: ai:key (day) when the key or the credit failed, ai:shots (summary) when a fifth or more of the requests failed; a clean run closes both
async function tell(keyFail, why, clean, o) {
  if (!keyFail && !why && !clean) return;
  let router = null, tg = null;
  try { router = await IO.router(); tg = await import("./tg-text.mjs"); } catch { return; }
  const where = o.source === "app" ? "האפליקציה" : "האתר", link = o.run || "";
  try {
    if (keyFail) await router.alert("day", "ai:key", tg.msg({ kind: "today", area: "bots", title: "מפתח ה-Claude API לא עובד או שהקרדיט נגמר",
      text: `העין השנייה על צילומי המסך של ${where} לא רצה, וצילומי הלילה יחכו לריצה הבאה. סביר שגם שאר הבוטים שנעזרים ב-Claude ממשיכים בלעדיו.`,
      what: "להיכנס לקונסולה של Anthropic ולבדוק את המפתח ואת תקרת ההוצאה של luchit-bots. אם צריך, להדביק את המפתח מחדש בסוד ANTHROPIC_API_KEY." }), link, { today: "loud", legacy: () => false });
    else if (why) await router.alert("summary", "ai:shots", tg.msg({ kind: "info", area: "bots", title: "העין השנייה על צילומי המסך לא הצליחה לפנות ל-Claude",
      text: `הבדיקה של צילומי ${where} המשיכה בלעדיו, והצילומים שלא נבדקו יחכו לריצה הבאה.`, raw: why }), link, { today: "silent", legacy: () => false });
    else await router.resolve(["ai:shots", "ai:key"]);
  } catch { /* the report on the branch still says it */ }
}

function summary(md) { try { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); } catch { /* the log has the counts */ } }

export function reportMd(r) {
  const c = r.counts, row = f => `| ${f.new ? "**new** " : ""}${f.kind} | ${f.severity} | \`${f.shot}\` part ${f.part} | ${clip(f.where, 80).replace(/\|/g, "/")}: ${clip(f.what, 240).replace(/\|/g, "/")} |`;
  const order = (a, b) => (b.new - a.new) || LEVELS.indexOf(a.severity) - LEVELS.indexOf(b.severity) || a.kind.localeCompare(b.kind) || a.shot.localeCompare(b.shot);
  return [`### Visual review (${r.source}): ${c.findings} findings, ${c.new} new`, "",
    `${r.at.slice(0, 16).replace("T", " ")} UTC${r.run ? `, screenshots of ${r.run}` : ""}. Report only: nothing here fails a run.`, "",
    `Shots: ${c.shots}; kept their verdict (unchanged): ${c.kept}; first look now: ${c.first}; second look now: ${c.second}; waiting for a first look: ${c.waitingFirst}; `
    + `waiting for a second look: ${c.waitingSecond}; with first-look points under the bar only (not sent on): ${c.unsure}; points the second look rejected: ${c.rejected}; `
    + `typos dropped as misreadings (a word the app's text does not have): ${c.misreads}; `
    + `requests without an answer: ${c.errors}.`,
    `This month: ${r.month.first} of ${r.month.caps.monthFirst} first looks and ${r.month.second} of ${r.month.caps.monthSecond} second looks.`, "",
    ...(r.findings.length ? ["| kind | severity | shot | what |", "|---|---|---|---|", ...[...r.findings].sort(order).slice(0, 60).map(row), ""] : ["No confirmed finding.", ""]),
    ...(r.pending.length ? [`First look only, waiting for the second look: ${r.pending.length} shots (${r.pending.slice(0, 8).map(p => "`" + p.shot + "`").join(", ")}${r.pending.length > 8 ? ", ..." : ""}).`, ""] : []),
    ...(r.dropped?.length ? ["Points the second look rejected (listed while the review is report only, to measure what it misses):", "",
      "| shot | the first look's point | why it was rejected |", "|---|---|---|",
      ...r.dropped.slice(0, 30).map(d => `| \`${d.shot}\` | ${clip(d.claim, 160).replace(/\|/g, "/")} | ${clip(d.why, 200).replace(/\|/g, "/")} |`), ""] : []),
  ].join("\n");
}

function args(argv) {
  const o = { mode: "batch" };
  for (let i = 0; i < argv.length; i++) { const k = argv[i].replace(/^--/, ""); if (["source", "shots", "state", "code", "mode", "run"].includes(k)) o[k] = argv[++i]; }
  return o;
}

// ---- self-test: made-up screenshots and a fake API, nothing leaves the machine
async function selftest() {
  let bad = 0; const print = IO.out, ok = (c, m) => { print((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const tmp = fs.mkdtempSync(path.join((await import("node:os")).tmpdir(), "vr-")), keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = keys.publicKey.export({ type: "spki", format: "pem" }), open = f => { const e = J(fs.readFileSync(f, "utf8"));
    const k = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64")); return J(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString()); };
  const pic = (w, h, f) => { const rgb = Buffer.alloc(w * h * 3); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y); rgb.set([r, g, b], (y * w + x) * 3); } return { w, h, rgb }; };
  const same = (a, b) => a.w === b.w && a.h === b.h && a.rgb.equals(b.rgb);

  // PNG: every filter type, RGBA and grey, round trip of the writer
  const raw = (img, ch, filters) => { const stride = img.w * ch, px = (y, i) => (y < 0 || i < 0 ? 0 : img.data[y * stride + i]), out = Buffer.alloc(img.h * (stride + 1));
    for (let y = 0; y < img.h; y++) { const f = filters[y % filters.length]; out[y * (stride + 1)] = f;
      for (let i = 0; i < stride; i++) { const v = px(y, i), a = px(y, i - ch), b = px(y - 1, i), c = px(y - 1, i - ch), p = a + b - c;
        const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
        out[y * (stride + 1) + 1 + i] = (v - [0, a, b, (a + b) >> 1, pr][f]) & 255; } }
    return out; };
  const pngOf = (w, h, type, data, filters) => { const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type], ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = type;
    const c = (k, d) => { const kb = Buffer.from(k, "latin1"), b = Buffer.alloc(12 + d.length); b.writeUInt32BE(d.length, 0); kb.copy(b, 4); d.copy(b, 8); b.writeUInt32BE(crc32(Buffer.concat([kb, d])), 8 + d.length); return b; };
    return Buffer.concat([SIG, c("IHDR", ihdr), c("IDAT", zlib.deflateSync(raw({ w, h, data }, ch, filters))), c("IEND", Buffer.alloc(0))]); };
  { const w = 7, h = 10, data = Buffer.alloc(w * h * 4); for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >> 3) * 11) & 255; for (let i = 3; i < data.length; i += 4) data[i] = 255;
    const img = readPng(pngOf(w, h, 6, data, [0, 1, 2, 3, 4]));
    ok(img.w === 7 && img.h === 10 && [...Array(w * h).keys()].every(p => img.rgb[p * 3] === data[p * 4] && img.rgb[p * 3 + 2] === data[p * 4 + 2]), "PNG: RGBA through all five filters reads back exactly");
    const g = Buffer.from([...Array(5 * 4).keys()].map(i => i * 12)), gi = readPng(pngOf(5, 4, 0, g, [4, 3]));
    ok(gi.rgb[3 * 7] === g[7] && gi.rgb[3 * 7 + 1] === g[7], "PNG: grey reads as RGB"); }
  { const img = pic(33, 21, (x, y) => [x * 7, y * 9, (x * y) & 255]); ok(same(readPng(writePng(img)), img), "PNG: what the writer writes reads back the same"); }
  ok(tryPng(Buffer.from("not an image")) === null && tryPng(null) === null, "PNG: anything else is no image, not a crash");

  // parts and the change measure
  { const page = pic(390, 2084, (x, y) => [y & 255, x & 255, 0]), p = parts(page, "ui");
    ok(p.length === 3 && p[0].w === 780 && p[0].h === 1600 && p[2].h === 968, "a 390x2084 page: three parts of 800, 800 and 484 px, each at twice the size");
    ok(p[1].rgb[0] === (800 & 255) && p[0].rgb[(1 * 780 + 2) * 3 + 1] === 1, "each part starts at its row, each pixel doubled");
    ok(parts(pic(390, 1650, () => [9, 9, 9]), "ui").map(x => x.h).join() === "1600,1700", "a sliver under 200 px joins the part above");
    ok(parts(pic(540, 1200, () => [1, 2, 3]), "app").length === 1 && parts(pic(540, 1200, () => [1, 2, 3]), "app")[0].w === 540, "a phone shot is one part, at its own size"); }
  { const a = pic(100, 100, () => [200, 200, 200]), b = pic(100, 100, (x, y) => (x < 2 && y < 10 ? [0, 0, 0] : [200, 200, 200]));
    ok(changed(a, a) === 0 && Math.abs(changed(a, b) - 0.002) < 1e-9 && changed(a, pic(100, 101, () => [0, 0, 0])) === 1 && changed(null, a) === 1, "change measure: share of pixels, 1 on another size");
    ok(changed(a, pic(100, 100, () => [210, 205, 200])) === 0, "a faint shade is no change"); }

  // the names the guardians give
  const tree = (root, files) => { for (const [f, img] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }); fs.writeFileSync(path.join(root, f), writePng(img)); } };
  const W = pic(54, 120, (x, y) => [240, 240, (x + y) & 255]);
  tree(path.join(tmp, "app"), { "api35/411-f100/shots/411-f100__light__car__check-check.png": W, "api35/411-extra-first-try/shots/411-extra__keyboard.png": W,
    "api35/360-f130/shots/360-f130__light__sub-compareSheet__compare-compare.png": W,
    "api31/411-extra/shots/411-extra__keyboard.png": W, "api31/411-extra/findings.json.png": W, "api35/411-f100/shots/../evil.png": W });
  tree(path.join(tmp, "ui"), { "open-recall-recalls-320-dark.png": W, "screen-home-390-light.png": W, "diff/screen-home-390-light.png": W, "inspect-plate-390-light.png.txt": W });
  { const a = collect("app", path.join(tmp, "app")), u = collect("ui", path.join(tmp, "ui"));
    ok(a.map(s => s.key).join() === "api31/411-extra__keyboard,api35/360-f130__light__sub-compareSheet__compare-compare,api35/411-f100__light__car__check-check", "app shots: the guardian's names only, not the lost first try");
    ok(u.map(s => s.key).join() === "open-recall-recalls-320-dark,screen-home-390-light", "ui shots: the pages only, not the diff pictures");
    ok(collect("app", path.join(tmp, "nothing")).length === 0 && collect("other", path.join(tmp, "ui")).length === 0, "no folder or another source: nothing");
    ok(/Android 15, a phone 411 dp wide with the font size at 100%/.test(describe(a[2])) && /keyboard is open on purpose/.test(describe(a[0])) && /360 dp wide with the font size at 130%/.test(describe(a[1])), "app: the phone setting and what is on purpose");
    ok(/320 px wide, dark theme: a car's page: a car with an open recall, on the recalls tab/.test(describe(u[0], 3)) && /in 3 parts/.test(describe(u[0], 3)), "ui: the page, its theme and its parts"); }

  // the prompt and the schemas
  ok(SYSTEM.length > 3000 && !/\d{4}-\d{2}-\d{2}/.test(SYSTEM), "the instruction is long enough to cache (512 tokens) and holds no date");
  const objs = s => (s && typeof s === "object" ? [...(s.type === "object" ? [s] : []), ...Object.values(s).flatMap(objs)] : []);
  ok([...objs(FIRST), ...objs(SECOND)].every(x => x.additionalProperties === false && x.required.length === Object.keys(x.properties).length), "schemas: every object closed, every field required");
  ok(!/"(minimum|maximum|minLength|maxLength|pattern)"/.test(JSON.stringify([FIRST, SECOND])), "schemas: no constraint structured outputs refuse");

  // a run against a fake API
  const reply = (obj, extra = {}) => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(obj) }], usage: { input_tokens: 900, output_tokens: 300, cache_read_input_tokens: 1800 }, ...extra });
  const fake = { calls: [], batches: 0, fail: null, refuse: null, answer: p => {
    const text = p.messages[0].content.at(-1).text, name = /Screenshot "([^"]+)"/.exec(text)[1];
    if (fake.fail && fake.fail.test(name)) return { error: { why: fake.why || "529 server", key: !!fake.key } };
    if (fake.refuse && fake.refuse.test(name)) return { msg: { stop_reason: "refusal", stop_details: { category: "general_harms" }, content: [] } };
    if (fake.garble && fake.garble.test(name)) return { msg: { stop_reason: "end_turn", content: [{ type: "text", text: "not json" }], usage: {} } };
    const cut = { kind: "cut_text", part: 1, where: "the plate field", what: "the last digit is cut", severity: "medium", confidence: "high" }, badge = { kind: "overlap", part: 1, where: "the bell", what: "the badge covers the bell", severity: "low", confidence: "medium" };
    const misread = { kind: "typo", part: 1, where: "the footer", text: "מדריך לקנה", what: "a letter is missing", severity: "medium", confidence: "high" };
    if (p.model === MODELS.first) return { msg: reply({ issues: /check-check|open-recall/.test(name) ? [badge, cut] : /tour-home/.test(name) ? [badge] : /tour-cars/.test(name) ? [misread] : [] }) };
    const real = !/open-recall/.test(name);
    return { msg: reply({ checked: [{ claim: 1, real, kind: "cut_text", part: 1, where: "the plate field", text: /f200/.test(name) ? "12-345-" : "12-345-6", what: "the last digit \"7\" is cut", severity: "medium",
      why: real ? "visible" : "the digit is whole" }] }) };
  } };
  const api = { fake: true };
  IO.claude = { ...claude, client: async env => (env.ANTHROPIC_API_KEY ? { api, why: "" } : { api: null, why: "no ANTHROPIC_API_KEY" }),
    ask: async (_, p) => { fake.calls.push(p); return fake.answer(p); },
    batch: async (_, reqs) => { fake.batches++; const results = new Map(); for (const r of reqs) { fake.calls.push(r.params); const a = fake.answer(r.params); results.set(r.custom_id, a.msg ? { ok: true, msg: a.msg } : { ok: false, why: "errored api_error" }); }
      return fake.batchFail ? { error: { why: "401 key", key: true } } : { id: "msgbatch_x", ended: true, results }; } };
  const told = [];
  IO.router = async () => ({ alert: async (lv, key) => { told.push(`${lv} ${key}`); return { delivered: true }; }, resolve: async p => { told.push("resolve " + p.join("+")); return 1; } });
  IO.pub = () => pub; IO.lexicon = () => new Set(["מדריך", "לקונה"]);
  const logs = []; IO.out = s => logs.push(s);
  let clock = Date.parse("2026-10-29T02:40:00Z"); IO.now = () => clock;
  const shots = path.join(tmp, "shots-app"), state = path.join(tmp, "state-app"), base = pic(54, 120, (x, y) => [250, 250, (x * 3 + y) & 255]);
  tree(shots, { "api35/411-f100/shots/411-f100__light__car__check-check.png": base, "api35/411-f100/shots/411-f100__light__home__tour-home.png": base,
    "api35/320-f130/shots/320-f130__dark__cars__tour-cars.png": base });
  IO.env = { ANTHROPIC_API_KEY: "test" };
  const go = (extra = {}) => run({ source: "app", shots, state, code: "c1", mode: "sync", run: "https://example.invalid/run/1", ...extra });
  const st = () => J(fs.readFileSync(path.join(state, "state.json"), "utf8")), rep = () => J(fs.readFileSync(path.join(state, "report.json"), "utf8"));

  ok(await go() === 0 && fake.calls.length === 4, "night 1: three first looks, one second look (only the shot with a point)");
  ok(fake.calls.every(p => p.output_config.effort === (p.model === MODELS.first ? "low" : "medium") && p.output_config.format.type === "json_schema" && p.system[0].cache_control && !("temperature" in p) && !("thinking" in p)),
    "requests: effort low for the first look and medium for the second, a JSON schema, a cached instruction, no sampling, thinking left to the model");
  ok(fake.calls.filter(p => p.model === MODELS.first).length === 3 && fake.calls.filter(p => p.model === MODELS.second).length === 1, "Haiku for every shot, Sonnet for the suspect one");
  ok(rep().counts.findings === 1 && rep().findings[0].new && rep().findings[0].shot === "api35/411-f100__light__car__check-check", "the confirmed point is a new finding");
  { const asked = fake.calls.find(p => p.model === MODELS.second).messages[0].content.at(-1).text;
    ok(rep().counts.unsure === 1 && /1\. cut_text/.test(asked) && !/badge/.test(asked), "a point under the bar (low, fairly sure) is not sent on, and the second look is asked about the points over it only"); }
  ok(rep().counts.misreads === 1 && st().shots["api35/320-f130__dark__cars__tour-cars"].first.issues.length === 0, "a typo quoting a word the app's text does not have is a misreading: dropped, counted, not sent on");
  { const real = lexicon(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
    if (real.size) ok(real.has("לקונה") && real.has("התראות") && !real.has("לקנה") && !real.has("החראות"), "the repository's words: the footer's and the alerts' are there, the two misreadings of 28.10 are not");
    else print("skip the repository's words: not a git checkout"); }
  ok(fs.existsSync(path.join(state, "reviewed", "api35/411-f100__light__car__check-check.png")), "each shot is kept as judged");
  { const pub1 = ["state.json", "report.json", "report.md"].map(f => fs.readFileSync(path.join(state, f), "utf8")).join("\n");
    ok(!/usd|\$|input_tokens|cacheRead|"output"/i.test(pub1), "public files: no dollars and no tokens");
    const u = fs.readdirSync(path.join(state, "usage")); const sealed = open(path.join(state, "usage", u[0]));
    ok(u.length === 1 && sealed.requests[MODELS.first] === 3 && sealed.tokens[MODELS.first].input === 2700 && sealed.usd > 0, "the usage is sealed with the public key and opens with the private one"); }
  ok(told.join() === "resolve ai:shots+ai:key", "a clean run closes ai:shots and ai:key");

  // night 2: the same pictures (a clock changed a few pixels): no request at all, the finding is known
  fake.calls = []; told.length = 0; clock += 864e5;
  tree(shots, { "api35/411-f100/shots/411-f100__light__car__check-check.png": pic(54, 120, (x, y) => (x < 3 && y < 2 ? [0, 0, 0] : [250, 250, (x * 3 + y) & 255])) });
  ok(await go() === 0 && fake.calls.length === 0 && rep().counts.kept === 3, "night 2: nothing changed, nothing sent");
  ok(rep().counts.findings === 1 && rep().findings[0].new === false && rep().findings[0].since === "2026-10-29", "night 2: the finding is the known one, not new");

  // a changed shot, then new app code
  fake.calls = []; clock += 864e5;
  tree(shots, { "api35/411-f100/shots/411-f100__light__home__tour-home.png": pic(54, 120, (x, y) => [10, 10, (x + y) & 255]) });
  await go(); ok(fake.calls.length === 1 && fake.calls[0].model === MODELS.first && /tour-home/.test(fake.calls[0].messages[0].content.at(-1).text), "a changed shot: only it is looked at again");
  fake.calls = []; await go({ code: "c2" });
  ok(fake.calls.filter(p => p.model === MODELS.first).length === 3 && fake.calls.filter(p => p.model === MODELS.second).length === 1, "new app code: every shot again");
  ok(rep().findings.length === 1 && rep().findings[0].since === "2026-10-29" && !rep().findings[0].new, "the same finding after a fresh look keeps its first night");

  // caps: the run's and the month's; the rest waits, oldest verdict first
  { const c = { ...CAPS }; CAPS.runFirst = 1; fake.calls = []; await go({ code: "c3" });
    ok(fake.calls.filter(p => p.model === MODELS.first).length === 1 && rep().counts.waitingFirst === 2, "run cap: one first look, two wait");
    const done1 = Object.entries(st().shots).filter(([, e]) => e.code === "c3").map(([k]) => k);
    fake.calls = []; await go({ code: "c3" });
    const done2 = Object.entries(st().shots).filter(([, e]) => e.code === "c3").map(([k]) => k);
    ok(done2.length === 2 && done1.every(k => done2.includes(k)), "the next run takes a shot that waited, not the same one again");
    CAPS.runFirst = c.runFirst; CAPS.monthFirst = st().used.first; fake.calls = []; await go({ code: "c4" });
    ok(fake.calls.length === 0 && rep().counts.waitingFirst === 3, "month cap reached: no request, everything waits");
    clock = Date.parse("2026-11-01T02:40:00Z"); await go({ code: "c4" });
    ok(fake.calls.filter(p => p.model === MODELS.first).length >= 1 && st().month === "2026-11", "a new month: the counts start again");
    Object.assign(CAPS, c); }

  // the same defect on another shot, or after a new V judged every shot again, is not new: it keeps the night it was first confirmed
  { const sh = path.join(tmp, "shots-known"), ks = path.join(tmp, "state-known"), kst = () => J(fs.readFileSync(path.join(ks, "state.json"), "utf8"));
    const krep = () => J(fs.readFileSync(path.join(ks, "report.json"), "utf8")), kgo = () => run({ source: "app", shots: sh, state: ks, code: "k1", mode: "sync" });
    clock = Date.parse("2026-11-03T02:40:00Z"); tree(sh, { "api35/411-f100/shots/411-f100__light__car__check-check.png": base }); await kgo();
    ok(krep().findings.length === 1 && krep().findings[0].new && kst().known.length === 1 && kst().known[0].text === "12-345-6", "a confirmed defect is remembered by its kind and text");
    clock += 864e5; tree(sh, { "api31/411-f200/shots/411-f200__light__car__check-check.png": pic(54, 120, () => [5, 5, 5]) }); fake.calls = []; await kgo();
    const other = krep().findings.find(f => f.shot === "api31/411-f200__light__car__check-check");
    ok(fake.calls.length === 2 && other && other.text === "12-345-" && other.since === "2026-11-03" && !other.new && krep().counts.new === 0, "the same defect on another shot is not new: it keeps its first night");
    const s0 = kst(); s0.v = V - 1; fs.writeFileSync(path.join(ks, "state.json"), JSON.stringify(s0)); clock += 864e5; fake.calls = []; await kgo();
    ok(fake.calls.length === 4 && krep().findings.length === 2 && krep().findings.every(f => f.since === "2026-11-03" && !f.new), "a new V judges every shot again, and its findings keep their first night");
    ok(kst().known.length === 1 && kst().known[0].seen === "2026-11-05", "one entry per defect, seen tonight");
    ok(!alike({ kind: "overlap", text: "1" }, { kind: "overlap", text: "12-345-67" }) && alike({ kind: "overlap", text: "1" }, { kind: "overlap", text: " 1 " })
      && !alike({ kind: "cut_text", text: "ישראל" }, { kind: "overlap", text: "ישראל" }) && alike({ kind: "cut_text", text: "IL ישראל" }, { kind: "cut_text", text: "ישראל" }),
      "one defect: the same kind and text, a short text only as itself"); }

  // no key, switched off, no shots: skipped, the state untouched
  { const before = fs.readFileSync(path.join(state, "state.json"), "utf8"); fake.calls = [];
    IO.env = {}; ok(await go({ code: "c9" }) === 0 && logs.at(-1).includes("skipped: no ANTHROPIC_API_KEY"), "no key: skipped, quietly");
    IO.env = { ANTHROPIC_API_KEY: "test", VISUAL_REVIEW: "off" }; ok(await go({ code: "c9" }) === 0 && /VISUAL_REVIEW is off/.test(logs.at(-1)), "switched off: skipped");
    IO.env = { ANTHROPIC_API_KEY: "test" }; ok(await run({ source: "app", shots: path.join(tmp, "none"), state, code: "c9", mode: "sync" }) === 0 && /no screenshots/.test(logs.at(-1)), "no screenshots: skipped");
    ok(fake.calls.length === 0 && fs.readFileSync(path.join(state, "state.json"), "utf8") === before, "skipping touches nothing");
    told.length = 0; const real = IO.claude; IO.claude = { ...real, client: async () => ({ api: null, why: "the SDK is not installed (x)" }) };
    ok(await go({ code: "c9" }) === 0 && told.join() === "summary ai:shots" && fs.readFileSync(path.join(state, "state.json"), "utf8") === before, "a key but no SDK: skipped, and ai:shots (summary)");
    IO.claude = real; told.length = 0; }

  // API errors: the shots wait (every night, however often), ai:shots once enough failed, ai:key when the key did; an answer that is no
  // answer (cut, not the JSON) twice for the same picture stops asking
  { told.length = 0; fake.calls = []; fake.fail = /./; await go({ code: "c5" }); await go({ code: "c5" });
    ok(rep().counts.errors === 3 && Object.values(st().shots).every(e => e.code !== "c5") && told.join() === "summary ai:shots,summary ai:shots", "a server error, twice: nothing recorded as judged, the shots wait, ai:shots (summary)");
    fake.fail = null; fake.garble = /./; told.length = 0; await go({ code: "c5" });
    ok(Object.values(st().shots).every(e => e.code !== "c5") && rep().counts.errors === 3, "an answer that is not the JSON: the shot waits once");
    await go({ code: "c5" }); fake.calls = []; await go({ code: "c5" });
    ok(Object.values(st().shots).every(e => e.code === "c5" && e.first.failed) && fake.calls.length === 0, "the same picture without an answer twice is recorded, not asked every night");
    fake.garble = null;
    fake.fail = /./; fake.key = true; fake.why = "401 key"; told.length = 0; fake.calls = []; await go({ code: "c6" });
    ok(told.join() === "day ai:key" && fake.calls.length <= POOL, "the key refused: ai:key (day), and the run stops asking");
    fake.fail = null; fake.key = false; fake.why = null; }
  { fake.refuse = /tour-cars/; fake.calls = []; await go({ code: "c7" });
    const e = st().shots["api35/320-f130__dark__cars__tour-cars"]; ok(e.first.refused && e.code === "c7", "a refusal is recorded, so it is not asked again for the same picture");
    fake.calls = []; await go({ code: "c7" }); ok(fake.calls.length === 0, "next run: the refused shot is not sent again"); fake.refuse = null; }
  // a shot the guardian stopped taking: kept 14 days, then dropped with its picture; the workflow hears that the state was written
  { const s0 = st(), entry = seen => ({ code: "c7", at: "2026-10-01T02:40:00Z", seen, first: { issues: [] }, second: null });
    s0.shots["api35/old__gone"] = entry("2026-10-01"); s0.shots["api35/old__recent"] = entry(new Date(clock - 3 * 864e5).toISOString().slice(0, 10));
    fs.writeFileSync(path.join(state, "state.json"), JSON.stringify(s0)); fs.writeFileSync(path.join(state, "reviewed", "api35/old__gone.png"), writePng(W));
    const out = path.join(tmp, "gh-output"); IO.env = { ANTHROPIC_API_KEY: "test", GITHUB_OUTPUT: out }; fake.calls = []; await go({ code: "c7" });
    ok(!st().shots["api35/old__gone"] && st().shots["api35/old__recent"] && !fs.existsSync(path.join(state, "reviewed", "api35/old__gone.png")) && fake.calls.length === 0,
      "a shot not taken for 14 days leaves the state with its picture, one taken 3 days ago stays");
    ok(fs.readFileSync(out, "utf8") === "wrote=1\n", "the workflow hears that the state was written"); IO.env = { ANTHROPIC_API_KEY: "test" }; }

  // a Batch, and the second look rejecting a point
  { const ui = path.join(tmp, "shots-ui"), us = path.join(tmp, "state-ui");
    tree(ui, { "open-recall-recalls-390-dark.png": pic(39, 210, (x, y) => [20, 20, (x + y) & 255]), "screen-home-390-light.png": pic(39, 90, () => [250, 250, 250]) });
    fake.calls = []; fake.batches = 0;
    await run({ source: "ui", shots: ui, state: us, code: "u1", mode: "batch" });
    const r = J(fs.readFileSync(path.join(us, "report.json"), "utf8"));
    ok(fake.batches === 2 && r.counts.first === 2 && r.counts.second === 1 && r.counts.findings === 0 && r.counts.rejected === 1, "Batch: two first looks, one second look that rejected the point");
    ok(r.dropped.length === 1 && r.dropped[0].why === "the digit is whole" && r.dropped[0].claim === "the last digit is cut" && /second look rejected[\s\S]*the digit is whole/.test(fs.readFileSync(path.join(us, "report.md"), "utf8")),
      "a rejected point is kept with the second look's reason, in the report too");
    const p = fake.calls.find(x => /open-recall/.test(x.messages[0].content.at(-1).text));
    ok(p.messages[0].content.filter(b => b.type === "image").length === 1 && readPng(Buffer.from(p.messages[0].content[0].source.data, "base64")).w === 78, "a page goes as its parts, at twice the size");
    fs.writeFileSync(path.join(ui, "screen-bulk-320-dark.png"), Buffer.concat([SIG, Buffer.from("broken")])); fake.calls = [];
    await run({ source: "ui", shots: ui, state: us, code: "u1", mode: "batch" });
    ok(fake.calls.length === 0 && J(fs.readFileSync(path.join(us, "report.json"), "utf8")).errors[0] === UNREADABLE.why, "a broken screenshot is not sent, and the report says so");
    fs.rmSync(path.join(ui, "screen-bulk-320-dark.png"));
    fake.batchFail = true; told.length = 0; await run({ source: "ui", shots: ui, state: us, code: "u2", mode: "batch" });
    ok(told.join() === "day ai:key" && J(fs.readFileSync(path.join(us, "report.json"), "utf8")).counts.errors === 2, "Batch refused for the key: ai:key, the shots wait"); fake.batchFail = false; }

  fs.rmSync(tmp, { recursive: true, force: true });
  IO.out = print;
  print(bad ? `selftest: ${bad} failed` : "selftest: all passed");
  return bad ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("visual-review.mjs")) {
  const a = process.argv.slice(2);
  let code = 0;
  try { code = a[0] === "selftest" ? await selftest() : await run(args(a)); }
  catch (e) { IO.out(`::error title=Visual review::it stopped on its own error (${String(e && e.message || e).replace(/\d[\d,.\-]{3,}\d/g, "#").slice(0, 160)}), not on a finding`); code = 1; }
  process.exit(code);
}
