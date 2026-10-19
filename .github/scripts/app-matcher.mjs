// The app's model recall matcher, taken from index.html so the scripts that check it (recall-probe, recall-health) run the app's own code:
// the block "which rows of the maker's recall list are this model's" with brandModels before it, plus the helpers they read
// (num, empty, and the maker-name helpers COUNTRIES … canonMake that brandModels uses to group a brand's register codes).
import fs from "node:fs";
export function appMatcher(file = "index.html") {
  const html = fs.readFileSync(file, "utf8");
  const at = (k, from = 0) => { const i = html.indexOf(k, from); if (i < 0) throw new Error("not in index.html: " + k); return i; };
  const line = k => { const i = at(k); return html.slice(i, html.indexOf("\n", i)); };
  const makers = html.slice(at("const COUNTRIES = ["), at("const rowMake ="));
  const block = html.slice(at("const norm = s =>"), at("/* ---------- static model catalogue"));
  const src = [line("const empty = v =>"), line("const num = v =>"), makers, block].join("\n");
  return new Function(src + "\nreturn {matchModelRecalls, brandModels, recallParse, recallCar};")();
}
