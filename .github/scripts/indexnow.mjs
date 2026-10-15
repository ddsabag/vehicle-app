// IndexNow (Bing, Yandex, Seznam, Naver): tells them which pages changed, right after GitHub Pages deploys them.
// Google does not use IndexNow; for Google the sitemap lastmod and internal links do the work.
// Usage: node indexnow.mjs <before-sha> <after-sha>  (changed .html files between the two commits), or ALL=1 for the whole sitemap.
import fs from "node:fs";
import {execSync} from "node:child_process";
const SITE = "https://luchit.app/", HOST = "luchit.app";
const keyFile = fs.readdirSync(".").find(f => /^[0-9a-f]{32}\.txt$/.test(f));
if (!keyFile) { console.log("no IndexNow key file"); process.exit(0); }
const key = keyFile.slice(0, -4);
let urls;
if (process.env.ALL === "1" || !process.argv[2] || /^0+$/.test(process.argv[2])) {
  urls = [...fs.readFileSync("sitemap.xml", "utf8").matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
} else {
  const files = execSync(`git diff --name-only --diff-filter=AM ${process.argv[2]} ${process.argv[3]}`).toString().split("\n").filter(f => /\.html$/.test(f) && f !== "404.html");
  urls = files.map(f => f === "index.html" ? SITE : SITE + f.replace(/index\.html$/, ""));
}
urls = [...new Set(urls)].slice(0, 10000);
if (!urls.length) { console.log("nothing changed"); process.exit(0); }
// wait until the deployed key file answers, so the engines can verify ownership
for (let i = 0; i < 20; i++) { try { const r = await fetch(SITE + keyFile, {cache: "no-store"}); if (r.ok && (await r.text()).trim() === key) break; } catch {} await new Promise(r => setTimeout(r, 15000)); }
const r = await fetch("https://api.indexnow.org/indexnow", {method: "POST", headers: {"content-type": "application/json; charset=utf-8"},
  body: JSON.stringify({host: HOST, key, keyLocation: SITE + keyFile, urlList: urls})});
console.log("IndexNow", r.status, urls.length, "urls");
if (r.status >= 400 && r.status !== 429) process.exit(1);
