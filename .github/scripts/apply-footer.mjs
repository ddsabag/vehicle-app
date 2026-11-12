// One-off (8.11.2026): writes the shared site footer (site-footer.mjs) into the pages already in the repo, the same markup the
// generators now write, so the site changes at once instead of page by page as they are rebuilt. Run from the repo root.
// Generated pages: their old footer line (the data-source sentence and its links) becomes siteFooter() with that same sentence.
import fs from "node:fs"; import path from "node:path";
import {siteFooter} from "./site-footer.mjs";
const SITE = "https://luchit.app/";
const OLD = /<p class="muted" style="margin-top:\d+px">([^<]*?) <a href=[^\n]*?<\/p><script src="\/lib\/cfb.js" defer><\/script><\/main>((?:<script type="application\/ld\+json">[^\n]*?<\/script>)?)<\/body><\/html>/;
const walk = d => fs.readdirSync(d, {withFileTypes: true}).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".html") ? [path.join(d, e.name)] : []);
// a page that already has the footer gets it again, with its own data-source sentence (after a change to site-footer.mjs)
const CUR = /<style>\.ft\{[\s\S]*?<\/footer>/;
const refresh = (f, s, base) => { const d = (s.match(/<span class="ft-l">([\s\S]*?)<\/span><span>©/) || [])[1]; fs.writeFileSync(f, s.replace(CUR, () => siteFooter({base, ...(d ? {disclaimer: d} : {})}))); n++; };
let n = 0;
for (const f of ["404.html", ...["model", "brand", "check", "guide", "magazine"].filter(d => fs.existsSync(d)).flatMap(walk)]) {
  const s = fs.readFileSync(f, "utf8"), m = s.match(OLD);
  if (!m) { if (CUR.test(s)) { refresh(f, s, SITE); continue; } console.log("no footer line:", f); continue; }
  fs.writeFileSync(f, s.replace(OLD, () => `<script src="/lib/cfb.js" defer></script></main>${siteFooter({base: SITE, disclaimer: m[1]})}${m[2]}</body></html>`)); n++;
}
// the pages kept by hand: index.html links relatively, the others from the root
for (const [f, base] of [["index.html", ""], ["business/index.html", "/"], ["privacy.html", "/"], ["accessibility/index.html", "/"], ["terms/index.html", "/"]]) {
  const s = fs.readFileSync(f, "utf8"); if (CUR.test(s)) refresh(f, s, base); else console.log("no shared footer yet:", f);
}
console.log("pages:", n);
