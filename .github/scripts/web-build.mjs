// Builds the website for publishing (the GitHub Pages workflow runs this): the page's big inline script moves out to a minified,
// content-hashed app.<hash>.js that loads with defer, so the browser can paint the page before it downloads and compiles ~350 KB of JS.
// The source stays as it is (index.html keeps its inline script: the Android app, the checks and the other scripts read it that way).
// Usage: node .github/scripts/web-build.mjs [outDir=site]   (needs terser: npm i terser@5 next to this script or in a parent folder)
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
import {minify} from "terser";

const OUT = path.resolve(process.argv[2] || "site");
const SKIP = new Set([".git", ".github", "android", "worker", "analytics", "node_modules", "site", "ui-contract.json", "ui-guardian-baseline.json", "ui-lint-baseline.json", "README.md", "LICENSE", "service.json"]);
fs.rmSync(OUT, {recursive: true, force: true});
(function copy(src, dst) {
  fs.mkdirSync(dst, {recursive: true});
  for (const e of fs.readdirSync(src, {withFileTypes: true})) {
    if (src === "." && SKIP.has(e.name)) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
})(".", OUT);

const file = path.join(OUT, "index.html");
const html = fs.readFileSync(file, "utf8");
// the page's own code is the biggest plain <script> block
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
const big = blocks.sort((a, b) => b[1].length - a[1].length)[0];
if (!big || big[1].length < 100000) throw new Error("app script not found");
if (/<\/script/i.test(big[1])) throw new Error("script text contains a closing script tag");
const r = await minify(big[1], {compress: {passes: 1}, mangle: {toplevel: false}, format: {comments: /^!/}});
if (r.error || !r.code) throw new Error("minify failed");
const hash = crypto.createHash("sha256").update(r.code).digest("hex").slice(0, 10);
const name = `app.${hash}.js`;
fs.writeFileSync(path.join(OUT, name), r.code);
fs.writeFileSync(file, html.replace(big[0], `<script src="/${name}" defer></script>`));
console.log(`index.html ${html.length} -> ${fs.statSync(file).size} bytes; ${name} ${big[1].length} -> ${r.code.length} bytes`);
