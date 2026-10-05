// Release builds only: minifies the inline script of index.html (local names shortened, comments dropped).
// Global names are kept on purpose: the Android layer calls window functions by name. The source stays readable.
import fs from "node:fs";
import {minify} from "terser";

const src = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const parts = src.split(/(<script>[\s\S]*?<\/script>)/g);
let before = 0, after = 0;
const out = [];
for (const p of parts) {
  const m = p.match(/^<script>([\s\S]*)<\/script>$/);
  if (!m) { out.push(p); continue; }
  const r = await minify(m[1], {
    compress: {passes: 1, drop_console: false},
    mangle: {toplevel: false},
    format: {comments: /^!/},
  });
  if (r.error || !r.code) throw new Error("minify failed");
  before += m[1].length; after += r.code.length;
  out.push(`<script>${r.code}</script>`);
}
fs.mkdirSync(new URL("../../android/build-web/", import.meta.url), {recursive: true});
fs.writeFileSync(new URL("../../android/build-web/index.html", import.meta.url), out.join(""));
console.log(`script ${before} -> ${after} bytes`);
