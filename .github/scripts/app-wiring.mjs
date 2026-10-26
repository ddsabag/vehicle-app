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
//   9. one look: the colours the app draws before the page has (its window, its bars, its splash: MainActivity's PAGE/TOP/BOTTOM and
//      styles.xml's page_light/page_dark) differ from the page's tokens (--bg, --band-tint, the bottom bar), or the accent of Android's
//      own pickers (styles.xml accent_light/accent_dark) from the page's --accent
//  10. the WebViews and browsers people still have: :has() in a selector list with other selectors, color-mix() with a token outside
//      @supports, and JavaScript an older engine lacks (each one breaks the page there without an error)
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

// ---- one look: the colours the app draws before the page has (its window, its bars, its splash) are the page's own tokens
const block_ = (sel) => { const i = html.indexOf(sel + "{"); return i < 0 ? "" : html.slice(i, html.indexOf("}", i)); };
const tok = (blk, name) => ((blk.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\b`)) || [])[1] || "").toUpperCase();
const LIGHT = block_(":root"), DARK = block_(':root[data-theme="dark"]');
const mixHex = (a, b, p) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * p + parseInt(b.slice(i, i + 2), 16) * (1 - p)).toString(16).padStart(2, "0")).join("").toUpperCase();
const barMix = +((html.match(/\.bnav\{[^}]*background:color-mix\(in srgb,var\(--card\) (\d+)%,transparent\)/) || [])[1] || 100) / 100;   // the bottom bar: --card at this share over the page
const javaHex = (n) => ((main.match(new RegExp(`\\b${n} = 0xFF([0-9A-Fa-f]{6})\\b`)) || [])[1] || "").toUpperCase();
for (const [side, blk] of [["LIGHT", LIGHT], ["DARK", DARK]]) {
  const bg = tok(blk, "bg"), tint = tok(blk, "band-tint"), card = tok(blk, "card");
  if (!bg || !tint || !card) { block(`index.html: --bg, --band-tint or --card not found in the ${side.toLowerCase()} tokens`); continue; }
  const want = { PAGE: bg, TOP: tint, BOTTOM: mixHex(card, bg, barMix) };
  for (const [k, v] of Object.entries(want)) {
    const got = javaHex(`${k}_${side}`);
    if (got && "#" + got !== v) block(`MainActivity ${k}_${side} is #${got}; the page's ${k === "PAGE" ? "--bg" : k === "TOP" ? "--band-tint (the top of home)" : "bottom bar (--card over --bg)"} is ${v}: the first frame and the bars would differ from the page`);
    else if (!got) block(`MainActivity: ${k}_${side} (the ${side.toLowerCase()} launch colour) not found`);
  }
  const res = read("android/app/src/main/res/values/styles.xml"), color = (n) => ((res.match(new RegExp(`name="${n}">(#[0-9A-Fa-f]{6})<`)) || [])[1] || "").toUpperCase();
  const xml = color(`page_${side.toLowerCase()}`);
  if (xml !== bg) block(`styles.xml page_${side.toLowerCase()} is ${xml || "missing"}; the page's --bg is ${bg}: the splash and the window would show another colour first`);
  // Android's own pickers that the page opens (a date, a <select>) mark the choice and their buttons in the theme's colorAccent
  const accent = tok(blk, "accent"), acc = color(`accent_${side.toLowerCase()}`);
  if (accent && acc !== accent) block(`styles.xml accent_${side.toLowerCase()} is ${acc || "missing"}; the page's --accent is ${accent}: Android's date picker and lists the page opens would mark the choice in another colour`);
}

// ---- the WebViews and browsers people still have: a WebView updates through Google Play, but not on every phone (and the website
//      meets old iPhones). What an older engine drops whole is blocking here, since the page would break there without an error:
//   - :has() in a selector list with other selectors: the engine drops the whole rule (WebView before 105, Safari before 15.4)
//   - color-mix() with a var() inside, outside @supports (color:color-mix(...)): the declaration fails when computed and the property
//     falls to its initial value (transparent), not to the plain colour declared before it (WebView before 111, Safari before 16.2)
//   - a JavaScript call an older engine does not have, unguarded (AbortSignal.timeout: WebView before 103, Safari before 16)
const MIX_MSG = (d, l) => `index.html:${l}: "${d.slice(0, 80)}" mixes a token with color-mix() outside @supports (color:color-mix(in srgb,red,blue)); without color-mix() the property falls to transparent, not to the colour before it`;
const unguardedMix = (d, stack) => /color-mix\([^;]*var\(/.test(d) && !stack.some((s) => /^@supports[^{]*color-mix/.test(s));
for (const sm of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
  const css = sm[1], stack = [];
  let pre = "", line = lineOf(sm.index + sm[0].indexOf(css));
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") { const e = css.indexOf("*/", i + 2); line += (css.slice(i, e).match(/\n/g) || []).length; i = e + 1; continue; }
    if (ch === "\n") line++;
    if (ch === "{") {
      const sel = pre.trim();
      if (!sel.startsWith("@") && sel.includes(":has(")) {
        const parts = []; let d = 0, cur = "";
        for (const c of sel) { if (c === "(") d++; else if (c === ")") d--; if (c === "," && d === 0) { parts.push(cur); cur = ""; } else cur += c; }
        parts.push(cur);
        if (parts.length > 1 && parts.some((x) => !x.includes(":has("))) block(`index.html:${line}: "${sel.slice(0, 90)}" puts :has() in a list with other selectors; an engine without :has() drops the whole rule (give :has() a rule of its own)`);
      }
      stack.push(sel); pre = ""; continue;
    }
    if (ch === "}") { if (unguardedMix(pre, stack)) block(MIX_MSG(pre.trim(), line)); stack.pop(); pre = ""; continue; }
    if (ch === ";") { if (unguardedMix(pre, stack)) block(MIX_MSG(pre.trim(), line)); pre = ""; continue; }
    pre += ch;
  }
}
const js = [...html.matchAll(/<script(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
const NEW_JS = [
  [/AbortSignal\.timeout\(/g, "AbortSignal.timeout() (WebView 103, Safari 16): use timeoutSignal()", (l) => /^const timeoutSignal = /.test(l.trim())],
  [/AbortSignal\.any\(/g, "AbortSignal.any() (WebView 116, Safari 17.4)"],
  [/\bstructuredClone\(/g, "structuredClone() (WebView 98, Safari 15.4)"],
  [/\bObject\.hasOwn\(/g, "Object.hasOwn() (WebView 93, Safari 15.4)"],
  [/\.(?:findLast|findLastIndex)\(/g, "findLast() (WebView 97, Safari 15.4)"],
  [/\.(?:toSorted|toReversed|toSpliced)\(/g, "toSorted()/toReversed()/toSpliced() (WebView 110, Safari 16)"],
  [/\b(?:Object|Map)\.groupBy\(/g, "groupBy() (WebView 117, Safari 17.4)"],
  [/\bPromise\.withResolvers\(/g, "Promise.withResolvers() (WebView 119, Safari 17.4)"],
  [/[\w\])]\.at\(-?\d/g, "Array.at() (WebView 92, Safari 15.4)"],
];
for (const [re, what, ok] of NEW_JS) for (const m of js.matchAll(re)) {
  const l = js.slice(js.lastIndexOf("\n", m.index) + 1, js.indexOf("\n", m.index));
  if (!ok || !ok(l)) block(`index.html: ${what} is missing in older engines and throws there: "${l.trim().slice(0, 90)}"`);
}

for (const m of out.block) console.log(`::error::[app wiring] ${m}`);
for (const m of out.warn) console.log(`::warning::[app wiring] ${m}`);
console.log(`app wiring: ${Object.keys(bridge).length} bridge methods, ${uses.length} uses in the page, ${called.size} page functions the app calls, ${out.block.length} broken, ${out.warn.length} warnings`);
process.exit(out.block.length ? 1 : 0);
