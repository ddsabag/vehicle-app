// The trim-cut completions in two parts. The register keeps 12 characters of a trim, so a name can end in a cut word ("COMFORT HYBR").
//   TRIM_FIX in index.html   the list the app ships with (changes only with a release); always wins and is the fallback offline
//   trim-fix.json (site root) what the catalogue bot added since (catalog-rules.mjs); the app reads it from luchit.app, no release needed
// The app (trimFixUse in index.html) applies the same check as valid() below to every entry of the file, so a bad entry is dropped on its own.
//   node trim-fix.mjs --selftest
import fs from "node:fs";

export const FILE = "trim-fix.json";
// a completion of a cut word: capitals only, the cut word is its start (spaces aside), longer than it, and a 12-character name can end in it
export const valid = (k, v) => /^[A-Z]{2,11}$/.test(k) && typeof v === "string" && /^[A-Z][A-Z ]{1,28}[A-Z]$/.test(v) && !/  /.test(v)
  && v.replace(/ /g, "").length > k.length && v.replace(/ /g, "").startsWith(k);

export function appFix(page = "index.html") {   // TRIM_FIX from the page source
  const src = fs.readFileSync(page, "utf8").match(/const TRIM_FIX = (\{[\s\S]*?\});/);
  if (!src) throw new Error("TRIM_FIX not found in " + page);
  return new Function("return " + src[1])();
}
export function readFile(file = FILE) {   // {u, fix}; a missing or broken file is an empty one
  try { const j = JSON.parse(fs.readFileSync(file, "utf8")); return {u: String(j.u || ""), fix: Object.fromEntries(Object.entries(j.fix || {}).filter(([k, v]) => valid(k, v)))}; }
  catch { return {u: "", fix: {}}; }
}
// what the app applies: the file's entries under the page's own (the page wins on a clash)
export const effective = (app, file) => ({...file.fix, ...app});
export function write(file, fix, day) {
  const sorted = Object.fromEntries(Object.entries(fix).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(file, JSON.stringify({u: day, about: "Completions of trim names the register cut at 12 characters, added by the catalogue bot (catalog-rules.mjs). The app reads this file from the site; TRIM_FIX in index.html is the fallback and wins on a clash.", fix: sorted}, null, 1) + "\n");
}
// A completion the bot may add on its own. `whole` counts in how many names under 12 characters (once per maker and name) a word stands,
// with every known completion counted as at least 2. Confident when:
//   1. exactly one known completion (the page's or the file's) starts with the cut word, and any other whole word that does is a shorter
//      form of it (AUTOBIO, AUTOBIOG) or stands in 2 names at most (the odd typo AUTOBIOGRPH): AUTOBI -> AUTOBIOGRAPHY, but not
//      SPOR -> SPORTLINE while SPORT stands in 9; or
//   2. one whole word starting with it stands in 3+ names, and every other such word in at most a third as many: SUPERI -> SUPERIOR (19, the next 1).
// Anything else (a tie, abbreviations of the same word, a word seen twice) stays for a person.
export function confident(last, whole, known) {
  const kn = [...new Set(Object.values(known))].filter(v => !v.includes(" ") && v.length > last.length && v.startsWith(last));
  if (kn.length > 1) return "";
  const c = [...whole].filter(([x, n]) => n >= 2 && x.length > last.length && x.startsWith(last)).sort((a, b) => b[1] - a[1]);
  if (kn.length === 1) return c.every(([x, n]) => kn[0].startsWith(x) || n <= 2) ? kn[0] : "";
  if (!c.length || c[0][1] < 3 || (c[1] && c[1][1] * 3 > c[0][1])) return "";
  return valid(last, c[0][0]) ? c[0][0] : "";
}

if (process.argv[1] && process.argv[1].endsWith("trim-fix.mjs") && process.argv.includes("--selftest")) {
  const fail = m => { console.log("selftest FAILED " + m); process.exit(1); };
  for (const [k, v, want] of [["SUPERI", "SUPERIOR", true], ["LONGRANG", "LONG RANGE", true], ["HYBR", "HYBRID", true], ["UTOBIOGRAPHY", "AUTOBIOGRAPHY", false], ["HYB", "HYB", false],
    ["hybr", "HYBRID", false], ["HYBR", "HYBRID<B>", false], ["HYBR", "SPORT", false], ["HYBR", "HYBRID ", false], ["ABCDEFGHIJKL", "ABCDEFGHIJKLM", false], ["HYBR", 7, false]])
    if (valid(k, v) !== want) fail(`valid(${k}, ${v}) is ${!want}`);
  const known = {HYBR: "HYBRID", AUTOBIOGRAPH: "AUTOBIOGRAPHY", LONGRANG: "LONG RANGE", SPORTLI: "SPORTLINE"};
  const whole = new Map([["SUPERIOR", 19], ["SUPERIUR", 1], ["AUTOBIO", 2], ["AUTOBIOG", 2], ["AUTOBIOGRPH", 2], ["AUTOBIOGRAPHY", 2], ["SPORT", 9], ["SPORTLINE", 4], ["SPORTY", 3], ["LUXE", 3], ["LUXURY", 2], ["DYNAMIC", 2]]);
  for (const [w, want] of [["SUPERI", "SUPERIOR"], ["AUTOBI", "AUTOBIOGRAPHY"], ["SPOR", ""], ["LUX", ""], ["DYNAM", ""], ["HYB", "HYBRID"], ["LONG", ""], ["QQQ", ""]])
    if (confident(w, whole, known) !== want) fail(`confident(${w}) is "${confident(w, whole, known)}", want "${want}"`);
  const tmp = fs.mkdtempSync("/tmp/tf-") + "/t.json";
  write(tmp, {SUPERI: "SUPERIOR", AUTOBI: "AUTOBIOGRAPHY"}, "2026-11-01");
  fs.writeFileSync(tmp, fs.readFileSync(tmp, "utf8").replace('"SUPERI"', '"BAD": "X", "SUPERI"'));
  const r = readFile(tmp);
  if (JSON.stringify(r.fix) !== JSON.stringify({AUTOBI: "AUTOBIOGRAPHY", SUPERI: "SUPERIOR"}) || r.u !== "2026-11-01") fail("readFile keeps the valid entries: " + JSON.stringify(r));
  if (effective({SUPERI: "SUPERB"}, r).SUPERI !== "SUPERB") fail("the page wins on a clash");
  if (Object.keys(readFile("/nonexistent.json").fix).length) fail("a missing file is empty");
  const app = appFix(new URL("../../index.html", import.meta.url).pathname);
  if (app.HYBR !== "HYBRID") fail("TRIM_FIX read from index.html");
  const site = readFile(new URL("../../" + FILE, import.meta.url).pathname), raw = JSON.parse(fs.readFileSync(new URL("../../" + FILE, import.meta.url), "utf8"));
  if (Object.keys(site.fix).length !== Object.keys(raw.fix).length) fail(FILE + " has an entry the app would drop");
  // the app's own check (trimFixUse in index.html) must stay the same rule as valid() here
  const page = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  if (!page.includes(`const trimFixOk = ${valid.toString()};`)) fail("index.html trimFixOk differs from valid() in trim-fix.mjs");
  console.log("selftest ok");
}
