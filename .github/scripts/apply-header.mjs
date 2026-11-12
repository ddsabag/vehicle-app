// One-off (12.11.2026, review F5 and F9), as apply-footer.mjs: writes the shared site header (site-footer.mjs) into the pages kept by hand,
// which had none (privacy, terms, accessibility) or a smaller one (business), and the yellow plate field into every page with a plate form.
// The generators write both from the same source. Run from the repo root; running it again refreshes what it wrote.
import fs from "node:fs"; import path from "node:path";
import {siteHeader, PF_INPUT} from "./site-footer.mjs";
const CUR = /<style>header\.top\{[\s\S]*?<\/header>/;
let h = 0, p = 0;
for (const f of ["privacy.html", "terms/index.html", "accessibility/index.html", "business/index.html"]) {
  let s = fs.readFileSync(f, "utf8");
  if (CUR.test(s)) s = s.replace(CUR, () => siteHeader({base: "/"}));
  else {
    s = s.replace(/\n\s*<a class="brand" href="https:\/\/luchit\.app\/">[\s\S]*?<\/a>(?=\n)/, "");   // business/: its own small logo gives way to the header
    const at = s.match(/<body[^>]*>\n?(<a class="skip"[^\n]*\n)?/);
    if (!at) { console.log("no <body>:", f); continue; }
    s = s.slice(0, at.index + at[0].length) + siteHeader({base: "/"}) + "\n" + s.slice(at.index + at[0].length);
  }
  fs.writeFileSync(f, s); h++;
}
const OLD = /form\.pf input\{flex:1;min-width:0;font:inherit;font-size:1\.1rem;[^}]*\}|form\.pf input\{flex:1;min-width:0;box-sizing:border-box;min-height:54px;[^}]*\}form\.pf input::placeholder\{[^}]*\}form\.pf input:focus-visible\{[^}]*\}/;
const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(path.join(d, e.name))) : e.name.endsWith(".html") ? [path.join(d, e.name)] : []);
for (const f of walk(".")) { const s = fs.readFileSync(f, "utf8"); if (OLD.test(s)) { fs.writeFileSync(f, s.replace(OLD, () => PF_INPUT)); p++; } }
console.log("headers:", h, "plate fields:", p);
