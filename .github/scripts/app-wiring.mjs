// App wiring: the contract between the Android app (android/) and the page (index.html), read from the source. Offline, under a second.
// A broken wire fails silently on a phone (the page wraps bridge calls in try/catch, the app guards its calls with `window.X &&`), so
// nothing but this check notices it. Blocking (exit 1):
//   1. a bridge call the page makes that the app's AndroidApp object does not have, or with another number of arguments (the WebView
//      answers "Method not found", the try/catch swallows it, and the share / alert / calendar button does nothing)
//   2. a page function the app calls (runJs, pageJs, evaluateJavascript, BillingManager) that the page does not define
//   3. an alert kind SavedCheckWorker sends that does not open the tab KIND_TAB below says (a recall alert must open the recalls tab)
//   4. a launcher shortcut (shortcuts.xml) that neither the app nor the page's appAction handles
//   5. a shared car or comparison link the App Link filter does not open in the app, or without the parameters the app reads
//   6. a Play link without what the app's first launch reads from the install referrer (plate=, utm_source=share, utm_medium=)
//   7. the shrinker free to rename the bridge (proguard-rules.pro must keep @JavascriptInterface methods)
//   8. the page's openExternal letting through a scheme the app's openUrl refuses
// Warning: an AndroidApp method the page never calls.
// Usage: node .github/scripts/app-wiring.mjs [repo root]
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const JAVA_DIR = "android/app/src/main/java/com/ddsabag/pratirechev";
const html = read("index.html");
const main = read(`${JAVA_DIR}/MainActivity.java`);
const java = fs.readdirSync(path.join(ROOT, JAVA_DIR)).filter((f) => f.endsWith(".java")).map((f) => read(`${JAVA_DIR}/${f}`)).join("\n");
const out = { block: [], warn: [] };
const block = (m) => out.block.push(m), warn = (m) => out.warn.push(m);

// which tab a tapped alert opens, by the kind SavedCheckWorker gives it (null = the overview, where its card is)
const KIND_TAB = { recall: "recalls", stl: "recalls", test: "file", svc: "file", doc: "file", owner: null, status: null, mods: null };

// ---- the bridge as the app defines it: name -> number of parameters
const iface = main.slice(main.indexOf("addJavascriptInterface(new Object()"), main.indexOf('}, "AndroidApp")'));
if (!iface) block('MainActivity has no addJavascriptInterface(new Object() { ... }, "AndroidApp") block to read');
const bridge = {};
for (const m of iface.matchAll(/@JavascriptInterface\s+public\s+[\w<>[\]]+\s+(\w+)\s*\(([^)]*)\)/g)) bridge[m[1]] = m[2].trim() ? m[2].split(",").length : 0;

// ---- the calls the page makes: AndroidApp.x(...), bridge().x(...), and through a variable that holds one of them
const argsAt = (s, i) => {   // s[i] is "(": the number of top-level arguments up to the matching ")"
  let d = 0, n = 0, any = false, q = null;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if (q) { if (ch === "\\") j++; else if (ch === q) q = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; any = true; continue; }
    if (ch === "(" || ch === "[" || ch === "{") { d++; if (d > 1) any = true; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { d--; if (d === 0) return any ? n + 1 : 0; continue; }
    if (d === 1 && ch === ",") n++;
    else if (d === 1 && !/\s/.test(ch)) any = true;
  }
  return -1;
};
const lineOf = (i) => html.slice(0, i).split("\n").length;
const uses = [];   // {name, args (or null for a reference), line}
const take = (name, after, line) => { const k = after.match(/^\s*\(/); uses.push({ name, args: k ? argsAt(after, k[0].length - 1) : null, line }); };
for (const m of html.matchAll(/(?:(?<![\w$])window\.AndroidApp|(?<![\w.$])AndroidApp|\bbridge\(\))\s*\??\.\s*(\w+)/g)) take(m[1], html.slice(m.index + m[0].length, m.index + m[0].length + 400), lineOf(m.index));
for (const m of html.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*(?:window\.AndroidApp|AndroidApp|bridge\(\))(?!\s*\??\.)/g)) {
  // the rest of the block the variable lives in: up to the brace that closes it
  const v = m[1], start = m.index + m[0].length;
  let d = 0, end = start;
  for (; end < html.length && end - start < 4000; end++) { const ch = html[end]; if (ch === "{") d++; else if (ch === "}") { if (--d < 0) break; } }
  const body = html.slice(start, end);
  for (const u of body.matchAll(new RegExp(`(?<![\\w.$])${v}\\s*\\??\\.\\s*(\\w+)`, "g"))) take(u[1], body.slice(u.index + u[0].length, u.index + u[0].length + 400), lineOf(start + u.index));
}
for (const u of uses) {
  if (!(u.name in bridge)) block(`index.html:${u.line} uses AndroidApp.${u.name}, which the app does not have (MainActivity's AndroidApp object)`);
  else if (u.args !== null && u.args >= 0 && u.args !== bridge[u.name]) block(`index.html:${u.line} calls AndroidApp.${u.name} with ${u.args} argument(s); the app takes ${bridge[u.name]}, so the call fails with "Method not found"`);
}
for (const name of Object.keys(bridge)) if (!uses.some((u) => u.name === name)) warn(`AndroidApp.${name} is never used by the page`);

// ---- the page functions the app calls, from the JavaScript inside the app's strings
const jsInJava = [...java.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).filter((s) => /window\.|typeof \w+\s*===?\s*'function'|&&\s*\w+\(/.test(s));
const called = new Set();
for (const s of jsInJava) {
  for (const m of s.matchAll(/window\.(\w+)/g)) called.add(m[1]);
  for (const m of s.matchAll(/typeof (\w+)\s*===?\s*'function'/g)) called.add(m[1]);
  for (const m of s.matchAll(/(?:&&|\?|:)\s*(\w+)\s*\(/g)) called.add(m[1]);
}
const defined = (n) => new RegExp(`(?:\\bfunction\\s+${n}\\s*\\(|window\\.${n}\\s*=[^=]|(?:^|[\\n;{}])\\s*(?:const|let|var)\\s+${n}\\s*=)`).test(html);
for (const n of [...called].sort()) if (!defined(n)) block(`the app calls ${n}() in the page, which the page does not define (the call is guarded, so it fails silently)`);

// ---- tapped alerts: the tab each kind opens
const at = html.match(/const alertTab = (k => [^;\n]+);/);
if (!at) block("index.html: alertTab (the tab a tapped alert opens) not found");
else {
  const alertTab = new Function(`return (${at[1]})`)();
  const kinds = [...new Set([...java.matchAll(/notify\(c, plate, "(\w+)"/g)].map((m) => m[1]))];
  if (!kinds.length) block("SavedCheckWorker: no notify(c, plate, \"kind\", ...) calls found");
  for (const k of kinds) {
    if (!(k in KIND_TAB)) block(`alert kind "${k}" (SavedCheckWorker) is new: add it to KIND_TAB in app-wiring.mjs with the tab it should open`);
    else if (alertTab(k) !== KIND_TAB[k]) block(`a tapped "${k}" alert opens ${alertTab(k) || "the overview"}, it should open ${KIND_TAB[k] || "the overview"}`);
  }
  for (const k of Object.keys(KIND_TAB)) if (!kinds.includes(k)) warn(`KIND_TAB lists "${k}", which SavedCheckWorker no longer sends`);
}

// ---- launcher shortcuts
const sc = read("android/app/src/main/res/xml/shortcuts.xml");
const aa = html.match(/window\.appAction = what => \{([\s\S]*?)\n\};/);
for (const m of sc.matchAll(/android:data="luchit:\/\/(\w+)"/g)) {
  const what = m[1], native = new RegExp(`"${what}"\\.equals\\(what\\)`).test(main), page = aa && new RegExp(`what === "${what}"`).test(aa[1]);
  if (!native && !page) block(`the launcher shortcut luchit://${what} is handled neither by the app nor by the page's appAction`);
}

// ---- shared links open the app, and carry what it reads
const site = (html.match(/const SITE = "([^"]+)"/) || [])[1] || "";
const manifest = read("android/app/src/main/AndroidManifest.xml");
const filt = manifest.match(/android:scheme="https" android:host="([^"]+)" android:path="([^"]+)"/);
if (!filt) block("AndroidManifest.xml: no https App Link filter found");
else {
  const u = site ? new URL(site) : null;
  if (!u || u.host !== filt[1] || u.pathname !== filt[2]) block(`shared links point to ${site || "(no SITE)"}, the App Link filter opens https://${filt[1]}${filt[2]}: a shared car would open in the browser, not in the app`);
}
const sl = html.match(/const shareLink = \(plate, via\) => \{([\s\S]*?)\n\};/);
if (!sl || !/\?plate=\$\{plate\}&s=\$\{via\}/.test(sl[1])) block("shareLink no longer builds ?plate=<plate>&s=<via>, the parameters the app reads from a shared link");
for (const p of ["plate", "s", "cmp", "compare", "utm_source", "utm_campaign"]) if (!new RegExp(`getQueryParameter\\("${p}"\\)`).test(main)) block(`the app does not read ?${p}= from a luchit.app link`);
if (!/\?cmp=/.test(html) && !/\?compare=/.test(html)) block("the page shares no ?cmp= or ?compare= comparison link the app could open");

// ---- the install referrer
const cl = html.match(/const carLink = [^\n]+/);
if (!cl || !/plate=\$\{plate\}/.test(cl[0]) || !/utm_source=share/.test(cl[0]) || !/utm_medium=/.test(cl[0])) block("carLink: the Play link of a shared car must carry plate=, utm_source=share and utm_medium= in its referrer (the app's first launch reads them)");
for (const p of ["plate=", "utm_medium=", "utm_source="]) if (!main.includes(`startsWith("${p}")`)) block(`the app no longer reads ${p} from the install referrer`);

// ---- the shrinker keeps the bridge
const pg = read("android/app/proguard-rules.pro");
if (!/-keepclassmembers class \* \{\s*@android\.webkit\.JavascriptInterface <methods>;\s*\}/.test(pg)) block("proguard-rules.pro does not keep @JavascriptInterface methods: the release build would rename the bridge and break every call");

// ---- outside links
const ox = html.match(/function openExternal\(url\)\{\s*if \(!\/\^\(([^)]+)\)\/i/);
const allowed = (main.match(/"https"\.equals\(sch\) \|\| "http"\.equals\(sch\)[^;]*/) || [""])[0];
if (ox) for (const s of ox[1].split("|").map((x) => x.replace(/[^a-z]/g, "")).flatMap((x) => (x === "https" ? ["http", "https"] : [x]))) if (!allowed.includes(`"${s}"`)) block(`openExternal lets ${s}: links through, which the app's openUrl refuses (the button would do nothing)`);

for (const m of out.block) console.log(`::error::[app wiring] ${m}`);
for (const m of out.warn) console.log(`::warning::[app wiring] ${m}`);
console.log(`app wiring: ${Object.keys(bridge).length} bridge methods, ${uses.length} uses in the page, ${called.size} page functions the app calls, ${out.block.length} broken, ${out.warn.length} warnings`);
process.exit(out.block.length ? 1 : 0);
