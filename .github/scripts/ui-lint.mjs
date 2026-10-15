// UI guardian, phase A (warning mode): static checks on index.html against ui-contract.json and a ratchet baseline.
// Never fails the build; prints ::warning annotations and a summary. `--update-baseline` rewrites ui-lint-baseline.json.
import fs from "node:fs";

const html = fs.readFileSync("index.html", "utf8");
const contract = JSON.parse(fs.readFileSync("ui-contract.json", "utf8"));
const baselineFile = "ui-lint-baseline.json";
const warns = [];
const warn = (msg) => { warns.push(msg); console.log(`::warning file=index.html::${msg}`); };

// --- 1. tabs: ids, labels and order match the contract
const tabsSrc = html.match(/const TABS = (\[\[.*?\]\]);/s);
if (!tabsSrc) warn("TABS array not found; the contract check could not run");
else {
  const tabs = JSON.parse(tabsSrc[1].replace(/'/g, '"'));
  const want = contract.tabs.map((t) => `${t.id}:${t.label}`), got = tabs.map(([id, label]) => `${id}:${label}`);
  if (want.join("|") !== got.join("|")) warn(`Tabs differ from ui-contract.json. Code: ${got.join(" , ")} | Contract: ${want.join(" , ")}`);
}

// --- 2. every card with a literal title is registered in the contract
const known = new Set([...Object.values(contract.cards).flat(), ...contract.dynamicCards]);
const titles = new Set();
for (const m of html.matchAll(/\bcard\(\s*(?:"([^"\n]+)"|`([^`$\n]+)`)\s*,/g)) titles.add(m[1] || m[2]);
for (const t of titles) if (!known.has(t)) warn(`Card "${t}" is not registered in ui-contract.json (add it under its tab, in the intended position)`);
for (const t of known) if (!titles.has(t) && !contract.dynamicCards.includes(t) && !/^(מסמכים וספר הרכב|תיק הרכב|בדיקות לפני|הצי שלי)/.test(t) && !html.includes(`"${t}"`)) warn(`Contract lists "${t}" but no card with that title exists in index.html (stale entry?)`);

// --- 3. style metrics, compared with the ratchet baseline (only increases warn)
const styles = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
const css = styles.sort((a, b) => b.length - a.length)[0] || "";
const rules = css.split("\n").filter((l) => !/^\s*--[\w-]+\s*:/.test(l) && !/[{;]\s*--[\w-]+\s*:/.test(l.split("{")[0] || ""));
const body = css.split("*{box-sizing")[1] || css;
const bodyNoTokens = body.replace(/--[\w-]+\s*:[^;}]+[;}]?/g, "");
const metric = {
  hexOutsideTokens: (bodyNoTokens.match(/#[0-9a-fA-F]{3,8}\b/g) || []).length,
  physicalDirection: (body.match(/(?:margin|padding)-(?:left|right)\s*:|border-(?:left|right)(?:-\w+)?\s*:|text-align\s*:\s*(?:left|right)|float\s*:\s*(?:left|right)/g) || []).length,
  importantCount: (body.match(/!important/g) || []).length,
  fontSizesOffScale: [...body.matchAll(/font-size\s*:\s*([\d.]+)rem/g)].filter((m) => !contract.scales.fontRem.includes(parseFloat(m[1]))).length,
  fontSizesPx: (body.match(/font-size\s*:\s*[\d.]+px/g) || []).length,
  inlineStyleColors: (html.match(/style="[^"]*(?:#[0-9a-fA-F]{3,8}|rgb\()/g) || []).length,
  unregisteredCards: [...titles].filter((t) => !known.has(t)).length,
};
if (process.argv.includes("--update-baseline")) {
  fs.writeFileSync(baselineFile, JSON.stringify(metric, null, 2) + "\n");
  console.log("baseline updated", metric);
  process.exit(0);
}
let base = {};
try { base = JSON.parse(fs.readFileSync(baselineFile, "utf8")); } catch { warn("ui-lint-baseline.json missing; run with --update-baseline"); }
const hint = {
  hexOutsideTokens: "a hard-coded colour was added outside the tokens (use a --token so dark mode keeps working)",
  physicalDirection: "a left/right property was added (use logical properties for RTL: margin-inline-*, padding-inline-*, text-align:start/end)",
  importantCount: "!important was added",
  fontSizesOffScale: "a font size outside the type scale was added",
  fontSizesPx: "a pixel font size was added (use rem from the scale)",
  inlineStyleColors: "an inline colour was added in a template (use a class and a token)",
  unregisteredCards: "a card is not in ui-contract.json",
};
for (const [k, v] of Object.entries(metric)) if (k in base && v > base[k]) warn(`${k}: ${v} (baseline ${base[k]}): ${hint[k]}`);

// --- summary
const lines = ["### UI guardian (warning mode)", "", "| metric | now | baseline |", "|---|---|---|", ...Object.entries(metric).map(([k, v]) => `| ${k} | ${v} | ${base[k] ?? "-"} |`), "", warns.length ? `**${warns.length} warning(s)**` : "No warnings."];
console.log(lines.join("\n"));
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n") + "\n");
