// ASO check: the Google Play texts in .github/store-listing/ (title, short and full description) against Play's limits and metadata rules,
// the search phrases people actually use (Search Console, 10.2026: "בדיקת רכב לפי מספר רישוי", "מספר רכב", value and recall queries),
// and the home page title and description of luchit.app, so the store and the site say the same thing.
// Errors (exit 1): a text over Play's limit, or a promotional word or emoji in the title (Play metadata policy). Everything else is a warning.
// Offline, node: builtins only. aso-check.yml runs it when those files change.
//   node .github/scripts/aso-check.mjs            report (job summary in Actions)
//   node .github/scripts/aso-check.mjs selftest   offline checks of the rules
import fs from "node:fs";

export const LIMITS = { title: 30, short: 80, full: 4000 };
export const BRAND = "לוחית";
export const CORE = ["בדיקת רכב", "מספר רישוי"];
export const PLATE = /מספר רישוי|מספר רכב|לוחית רישוי/;
// what a check shows, in the words people search for; each entry is one feature and its spellings
export const FEATURES = { owners: /ידיים|בעלויות|בעלים/, recall: /ריקול/, test: /טסט/, km: /ק״מ|ק"מ|קילומטר/, value: /שווי|מחירון|כמה שווה|מחיר/ };
// whole words only (Hebrew letters are not \w, so \b does not work for them): מבצע is a word, מבצעים in a sentence is not flagged by accident
export const PROMO = /(?<!\p{L})(?:ב?חינם|חינמי(?:ת)?|ללא תשלום|הכי טוב(?:ה)?|ה?טוב(?:ה)? ביותר|מבצע|הנחה|free|best|top|sale)(?!\p{L})|מספר 1(?!\d)|#1(?!\d)/iu;
// emoji: pictographs, flags (regional indicators) and keycaps; © ® ™ are plain symbols here, not emoji
export const EMOJI = /[\p{Regional_Indicator}\u20E3]|(?![\u00A9\u00AE\u2122])\p{Extended_Pictographic}/u;
export const BETA = /בטא|\bbeta\b/i;
export const OPENING = 250, STUFF = 6;
export const chars = s => [...String(s)].length;   // code points, as Play counts (play-alpha.mjs)
const count = (s, phrase) => s.split(phrase).length - 1;
const feats = s => Object.keys(FEATURES).filter(k => FEATURES[k].test(s));

export function check({ title, short, full, webTitle, webDesc }) {
  const errors = [], warnings = [], info = [];
  if (title == null && short == null && full == null) { info.push("no store texts in .github/store-listing"); return { errors, warnings, info }; }
  for (const [k, s] of [["title", title], ["short", short], ["full", full]]) {
    if (s == null) { info.push(`${k}: no file, not checked`); continue; }
    const n = chars(s);
    if (!n) errors.push(`${k}: empty`);
    else if (n > LIMITS[k]) errors.push(`${k}: ${n} characters, Play allows ${LIMITS[k]}`);
    else info.push(`${k}: ${n}/${LIMITS[k]} characters`);
  }
  title ??= ""; short ??= ""; full ??= "";
  const promo = title.match(PROMO);
  if (promo) errors.push(`title: "${promo[0]}" is a promotional word, which Play's metadata policy does not allow in the title`);
  if (EMOJI.test(title)) errors.push("title: has an emoji, which Play's metadata policy does not allow");
  if (!title.includes(BRAND)) warnings.push(`title: the brand "${BRAND}" is missing`);
  if (!title.includes(CORE[0]) || !PLATE.test(title)) warnings.push(`title: should hold both "${CORE[0]}" and a plate phrase (${PLATE.source.replace(/\|/g, " / ")})`);
  if (!PLATE.test(short)) warnings.push("short: no plate phrase (מספר רישוי / מספר רכב)");
  const sf = feats(short);
  if (sf.length < 3) warnings.push(`short: names ${sf.length} of the checked features (${Object.keys(FEATURES).join(", ")}), 3 or more say what the app does`);
  const open = [...full].slice(0, OPENING).join("");
  for (const p of CORE) if (!open.includes(p)) warnings.push(`full: "${p}" is not in the first ${OPENING} characters (the part Play shows before "more")`);
  for (const p of CORE) { const c = count(full, p); if (c > STUFF) warnings.push(`full: "${p}" appears ${c} times; more than ${STUFF} reads as keyword stuffing`); else info.push(`full: "${p}" ${c} times`); }
  const ff = feats(full), miss = Object.keys(FEATURES).filter(k => !ff.includes(k));
  if (miss.length) warnings.push(`full: does not mention ${miss.join(", ")}`);
  for (const [k, s] of [["title", title], ["short", short], ["full", full]]) if (BETA.test(s)) warnings.push(`${k}: still says beta`);
  if (webTitle == null) warnings.push("web: no <title> in index.html");
  else {
    for (const p of [BRAND, CORE[0]]) if (!webTitle.includes(p)) warnings.push(`web title: "${p}" is missing ("${webTitle}")`);
    if (!PLATE.test(webTitle)) warnings.push(`web title: no plate phrase ("${webTitle}")`);
  }
  if (webDesc == null) warnings.push("web: no meta description in index.html");
  else {
    const wf = feats(webDesc), onlyStore = sf.filter(k => !wf.includes(k)), onlyWeb = wf.filter(k => !sf.includes(k));
    if (onlyStore.length) warnings.push(`consistency: the store short description names ${onlyStore.join(", ")}, the site description does not`);
    if (onlyWeb.length) info.push(`consistency: the site description also names ${onlyWeb.join(", ")}`);
    if (BETA.test(webDesc) || BETA.test(webTitle || "")) warnings.push("web: title or description still says beta");
  }
  return { errors, warnings, info };
}

export function readAll(root = ".") {
  // the same normalisation as play-listing.mjs (norm): BOM, line ends, spaces at line ends; a missing file is null (not managed here)
  const rd = f => { try { return fs.readFileSync(`${root}/${f}`, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim(); } catch { return null; } };
  const html = rd("index.html") || "";
  const dec = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
  const t = html.match(/<title>([^<]*)<\/title>/i), d = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  return { title: rd(".github/store-listing/title.txt"), short: rd(".github/store-listing/short-description.txt"), full: rd(".github/store-listing/full-description.txt"),
    webTitle: t ? dec(t[1]) : null, webDesc: d ? dec(d[1]) : null };
}

if (process.argv[1] && process.argv[1].endsWith("aso-check.mjs")) {
  if (process.argv[2] === "selftest") {
    let bad = 0; const ok = (c, m) => { if (!c) { bad++; console.log("FAIL", m); } };
    const good = { title: "לוחית: בדיקת רכב ומספר רישוי", short: "בדיקת רכב לפי מספר רישוי: בעלויות, ריקולים, טסט, ק״מ ושווי",
      full: "בדיקת רכב לפי מספר רישוי. כמה ידיים, ריקול, טסט, ק״מ ושווי.", webTitle: "בדיקת רכב לפי מספר רישוי | לוחית",
      webDesc: "בדיקת רכב לפי מספר רישוי: כמה ידיים, ריקולים, טסט, ק״מ ושווי משוער." };
    let r = check(good);
    ok(!r.errors.length && !r.warnings.length, "good texts pass: " + JSON.stringify(r));
    ok(check({ ...good, title: "x".repeat(31) }).errors.some(e => e.startsWith("title: 31")), "title over 30");
    ok(check({ ...good, title: "לוחית: בדיקת רכב בחינם" }).errors.some(e => e.includes("בחינם")), "promo word in the title");
    ok(check({ ...good, title: "לוחית 🚗 בדיקת רכב" }).errors.some(e => e.includes("emoji")), "emoji in the title");
    ok(!check({ ...good, title: "לוחית: מספר רישוי 12" }).errors.length, "a plain number is not #1");
    ok(check({ ...good, short: "בדיקת רכב לפי מספר רישוי" }).warnings.some(w => w.startsWith("short: names 0")), "short with no features");
    ok(check({ ...good, full: "אפליקציה טובה. " + good.full }).warnings.length === 0, "phrases still in the opening");
    ok(check({ ...good, full: "א".repeat(300) + good.full }).warnings.some(w => w.includes("first 250")), "phrases pushed out of the opening");
    ok(check({ ...good, full: good.full + " בדיקת רכב".repeat(7) }).warnings.some(w => w.includes("stuffing")), "stuffing");
    ok(check({ ...good, short: good.short + " בבטא" }).warnings.some(w => w.includes("beta")), "beta wording");
    ok(check({ ...good, webDesc: "בדיקת רכב לפי מספר רישוי." }).warnings.some(w => w.startsWith("consistency")), "site description misses features");
    ok(check({ ...good, webTitle: null }).warnings.some(w => w.includes("<title>")), "no web title");
    ok(chars("לוחית") === 5, "Hebrew letters count once");
    ok(check({ ...good, title: "לוחית 🇮🇱 בדיקת רכב" }).errors.some(e => e.includes("emoji")), "a flag is an emoji");
    ok(check({ ...good, title: "לוחית 1️⃣ בדיקת רכב" }).errors.some(e => e.includes("emoji")), "a keycap is an emoji");
    ok(!check({ ...good, title: "לוחית® בדיקת רכב ומספר רישוי" }).errors.length, "® is not an emoji");
    ok(!check({ ...good, title: "לוחית: מבצעים ומספר רישוי" }).errors.length, "מבצעים is not the word מבצע");
    ok(check({ ...good, title: "לוחית: מבצע בדיקת רכב" }).errors.some(e => e.includes("מבצע")), "the word מבצע");
    ok(!check({ ...good, title: "לוחית #10 בדיקת רכב" }).errors.length && check({ ...good, title: "לוחית #1 בדיקת רכב" }).errors.length, "#1 but not #10");
    ok(check({ ...good, title: "לוחית: הטובה ביותר" }).errors.length && check({ ...good, title: "לוחית: ללא תשלום" }).errors.length, "more promo phrases");
    ok(!check({ ...good, title: "לוחית: Topaz בדיקת רכב" }).errors.length, "top inside a word is fine");
    const tmp = fs.mkdtempSync("/tmp/aso-"); fs.mkdirSync(tmp + "/.github/store-listing", { recursive: true });
    fs.writeFileSync(tmp + "/.github/store-listing/title.txt", "\uFEFFלוחית: בדיקת רכב ומספר רישוי  \r\n");
    const ra = readAll(tmp);
    ok(ra.title === "לוחית: בדיקת רכב ומספר רישוי" && ra.short === null && ra.webTitle === null, "read: BOM, CRLF and trailing spaces; missing files are null");
    r = check(ra); ok(!r.errors.length && r.info.some(i => i.startsWith("short: no file")), "missing store files are not errors");
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(bad ? `${bad} failed` : "selftest ok");
    process.exit(bad ? 1 : 0);
  }
  const r = check(readAll());
  const out = [...r.errors.map(e => "::error::ASO " + e), ...r.warnings.map(w => "::warning::ASO " + w), ...r.info.map(i => "ASO " + i)];
  console.log(out.join("\n"));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, ["### ASO check", "",
    ...(r.errors.length ? r.errors.map(e => "- ❌ " + e) : []), ...r.warnings.map(w => "- ⚠️ " + w), ...r.info.map(i => "- " + i),
    !r.errors.length && !r.warnings.length ? "- ✅ no errors or warnings" : ""].join("\n") + "\n");
  console.log(`${r.errors.length} errors, ${r.warnings.length} warnings`);
  process.exit(r.errors.length ? 1 : 0);
}
