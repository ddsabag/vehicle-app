// Exploratory walk (QA thread; Dudu 1.11.2026 21:16 UTC, monthly API credit, package B): once a week Claude Sonnet uses the page on next
// the way a curious person would, off the scripted paths the guardians walk: odd inputs, back and forth, a half-done check left and come
// back to, long names, dark mode, a narrow phone, the website on a desktop. It looks at the screen, taps, types and scrolls through a few
// tools, and writes down what looks broken, wrong or confusing, with the screen as it was.
// Safe by construction: the page is served from this checkout, every request off the machine is aborted (the registry answers from
// ui-flows.cjs's mock with the example plates only, nothing else leaves: no form, feedback, share or analytics can send), window.open,
// the clipboard and share are stubbed, and the app runs with ui-flows.cjs's fake bridge. Only the example plates are in the data.
// Report only: a note never fails a run. Report and the notes' screenshots: branch explore-out (latest.md, <date>/). A high note tells
// the router (walk:<date>, summary) so the QA thread reads it; ai:walk (summary) when the API failed, ai:key (day) when the key or the
// credit is why; a good walk closes both. No key or EXPLORE=off: it skips. Tokens and dollars only in usage/*.enc.json (sealed with
// .github/seo-data.pub.pem). Caps: STEPS tool calls a walk, WALKS a month.
// Node 20, Playwright (installed by the workflow), node: builtins and ./claude.mjs. Commands:
//   node explore.cjs --out DIR [--walks a,b,c] [--run URL]     (from the root of a checkout)
//   node explore.cjs selftest                                  offline: a fake page and a fake API
const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), crypto = require("node:crypto");

const MODEL = "claude-sonnet-5-5";
const STEPS = 45, WALKS = 30, MAX_TOKENS = 4000;
const PRICE = [2, 10];   // $ per million tokens (cache write 1.25x, read 0.1x), for the sealed usage only
// three walks a week, each a person with a purpose; the page and the state are ui-flows.cjs's (states: empty, one, many, owner)
const WALKS_DEF = {
  buyer: { dev: { w: 390, h: 844, ua: "phone" }, theme: "light", state: "one",
    who: "Someone about to buy a used car, on an iPhone, in a hurry. They check 1234567, read every tab of the car, compare it with 7654321, and try what a person really types: a plate with dashes or spaces, letters, too few digits, a plate that does not exist (for example 1111111), and then go back and forth between screens." },
  owner: { dev: { w: 360, h: 780, ua: "app" }, theme: "dark", state: "many",
    who: "A car owner with many saved cars and long names, in the Android app, dark mode, on a small phone. They give a car a nickname, open its file, add a service, look at the alerts, change settings (look, text size if offered, alerts), remove a car and add it back, and use Back a lot." },
  visitor: { dev: { w: 1280, h: 800, ua: "desk" }, theme: "light", state: "empty",
    who: "A first visitor to the website on a desktop. They read the home page, check 7654321, open the footer pages (privacy, terms, about, FAQ if there are), the tools and compare, and look for how to get the app." },
};

const IO = { env: process.env, out: (s) => process.stdout.write(s + "\n"), now: () => Date.now(), claude: () => import("./claude.mjs"), router: () => import("./alert.mjs"),
  tg: () => import("./tg-text.mjs"), pub: () => fs.readFileSync(path.join(__dirname, "../seo-data.pub.pem"), "utf8"), browser: null };
const J = (s) => { try { return JSON.parse(s); } catch { return null; } };
const clip = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

const SYSTEM = `You test לוחית (luchit.app), an Israeli car-check app in Hebrew (right to left): a person types a licence plate and sees the Ministry of Transport's open data about the car (registration, yearly test, owners, recalls, prices). The same page is the website and, inside an Android WebView, the app.

You use the page through tools, like a person: look (a screenshot and a numbered list of what can be pressed or typed into), tap, type, key, scroll. Act as the person described, and also wander off the obvious path: that is your job, the scripted tests already walk the obvious one. The data is a test mock: only the example plates 1234567 and 7654321 (and the saved cars' plates) have a car; any other plate answers "not found", which is right. Nothing you do leaves the machine.

Write a note (the note tool) for each thing a person would see as wrong: something broken (a control that does nothing, a crash, an endless spinner, a wrong screen), text cut off or overlapping, right-to-left mistakes (an English car name cut at its start, digits in the wrong order), a Hebrew typo or a confusing sentence, unreadable contrast (dark mode most of all), a layout that breaks, data shown in a way that says more than it knows, or a step that is hard to understand. Do not note: the test data itself, a plate that is "not found" when it should be, the cookie of the mock, things you are not fairly sure of. One note per problem, at the screen where you see it, right after you see it. Then go on.

Be efficient: look when you need to see, not after every tap (a tap answers with what changed). Use at most ${STEPS} tool calls, then call finish with a two-sentence summary.`;

const TOOLS = [
  { name: "look", description: "A screenshot of the screen now, and a numbered list of the visible things that can be pressed or typed into (ref, kind, text).", input_schema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "tap", description: "Tap the thing with this ref (from the last look).", input_schema: { type: "object", properties: { ref: { type: "integer" } }, required: ["ref"], additionalProperties: false } },
  { name: "type", description: "Type text into the field with this ref (it is cleared first). Add enter: true to press Enter after.", input_schema: { type: "object", properties: { ref: { type: "integer" }, text: { type: "string" }, enter: { type: "boolean" } }, required: ["ref", "text"], additionalProperties: false } },
  { name: "key", description: "Press a key: Back (the browser's or the phone's Back), Escape, Enter or Tab.", input_schema: { type: "object", properties: { key: { type: "string", enum: ["Back", "Escape", "Enter", "Tab"] } }, required: ["key"], additionalProperties: false } },
  { name: "scroll", description: "Scroll the page by this many pixels (negative = up).", input_schema: { type: "object", properties: { dy: { type: "integer" } }, required: ["dy"], additionalProperties: false } },
  { name: "note", description: "Write down one problem a person would see, on the screen as it is now (its screenshot is kept with the note).", input_schema: { type: "object", properties: {
    severity: { type: "string", enum: ["high", "medium", "low"], description: "high: broken or wrong for people; medium: hurts in some cases; low: worth a look" },
    kind: { type: "string", enum: ["broken", "cut_text", "overlap", "rtl", "typo", "contrast", "layout", "data", "confusing", "other"] },
    where: { type: "string", description: "the screen and the element" }, what: { type: "string", description: "what is wrong, in one or two sentences, and how you got there" } },
    required: ["severity", "kind", "where", "what"], additionalProperties: false } },
  { name: "finish", description: "End the walk.", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false } },
];

// ---- the real page (Playwright), with ui-flows.cjs's mock and fake bridge
async function openPage(def) {
  const uf = require("./ui-flows.cjs"), { chromium } = require("playwright"), ROOT = process.cwd();
  const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  const browser = await chromium.launch(), d = def.dev, mobile = d.w < 900;
  const ctx = await browser.newContext({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile, colorScheme: def.theme, locale: "he-IL", userAgent: uf.UA[d.ua] });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());   // nothing leaves the machine
  // the site's own absolute links (a page's logo is https://luchit.app/icon-192.png) answer from this checkout, as the live site would:
  // aborted, the walk of 2.11 read them as broken images
  await ctx.route(/^https:\/\/(www\.)?luchit\.app\//, (r) => {
    let p = decodeURIComponent(new URL(r.request().url()).pathname); if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return r.fulfill({ status: 404, body: "" });
    return r.fulfill({ status: 200, contentType: MIME[path.extname(f)] || "application/octet-stream", body: fs.readFileSync(f) });
  });
  await ctx.route(/data\.gov\.il/, (r) => uf.govRoute(r));
  await ctx.addInitScript(({ ls, app, bridge }) => {
    try { if (!/(?:^|; )ex_seeded=1/.test(document.cookie)) { localStorage.setItem("analyticsOff", "1"); for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); document.cookie = "ex_seeded=1; path=/"; } } catch {}
    window.__toasts = [];
    document.addEventListener("DOMContentLoaded", () => { const t = document.getElementById("toast"); if (t) new MutationObserver(() => { const s = t.textContent.trim(); if (s && window.__toasts[window.__toasts.length - 1] !== s) window.__toasts.push(s); }).observe(t, { childList: true, characterData: true, subtree: true }); });
    if (app) window.AndroidApp = Object.fromEntries(bridge.map((n) => [n, () => (n === "alertsState" ? "on" : n === "readClipboard" ? "" : n === "systemDark" ? matchMedia("(prefers-color-scheme: dark)").matches : undefined)]));
    try { window.open = () => null; window.print = () => {}; } catch {}
    try { if (navigator.clipboard) navigator.clipboard.writeText = async () => {}; } catch {}
    try { if (navigator.share) navigator.share = async () => {}; } catch {}
  }, { ls: { theme: def.theme, homeSheet: "1", ...uf.STATES[def.state] }, app: d.ua === "app", bridge: uf.BRIDGE });
  const page = await ctx.newPage(), errors = [];
  page.on("pageerror", (e) => errors.push("page error: " + clip(e.message, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/net::ERR_FAILED|Failed to load resource/.test(m.text())) errors.push("console: " + clip(m.text(), 160)); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  const settle = () => page.waitForTimeout(700);
  const state = async () => { const s = await page.evaluate(() => { const t = window.__toasts.splice(0); return { hash: location.hash, toasts: t, wide: document.documentElement.scrollWidth > innerWidth + 1 }; }).catch(() => ({ hash: "?", toasts: [], wide: false }));
    const e = errors.splice(0); return `screen ${s.hash || "#"}` + (s.toasts.length ? `; message shown: ${s.toasts.map((x) => clip(x, 80)).join(" / ")}` : "") + (s.wide ? "; the page scrolls sideways" : "") + (e.length ? `; ${e.join("; ")}` : ""); };
  const el = (ref) => page.locator(`[data-xref="${ref}"]`).first();
  return {
    async look() {
      const items = await page.evaluate(() => {
        document.querySelectorAll("[data-xref]").forEach((e) => e.removeAttribute("data-xref"));
        const sel = "a[href],button,input,select,textarea,summary,[role=button],[role=tab],[role=link],[onclick],label[for],[tabindex]:not([tabindex='-1'])", out = [];
        for (const e of document.querySelectorAll(sel)) {
          const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
          if (r.width < 4 || r.height < 4 || cs.visibility === "hidden" || cs.display === "none" || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
          const at = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
          if (at && at !== e && !e.contains(at) && !at.contains(e)) continue;   // covered by something else
          const n = out.length + 1; e.setAttribute("data-xref", String(n));
          const text = (e.getAttribute("aria-label") || e.innerText || e.value || e.placeholder || e.title || "").replace(/\s+/g, " ").trim().slice(0, 50);
          out.push(`${n} ${e.tagName.toLowerCase()}${e.type && e.tagName === "INPUT" ? "[" + e.type + "]" : ""} "${text}"`);
          if (out.length >= 70) break;
        }
        return out;
      });
      const png = await page.screenshot({ type: "png" });
      return { png, text: (await state()) + "\n" + (items.length ? items.join("\n") : "(nothing to press on this screen)") };
    },
    async tap(ref) { await el(ref).click({ timeout: 4000 }); await settle(); return state(); },
    async type(ref, text, enter) { const e = el(ref); await e.fill("", { timeout: 4000 }); await e.type(String(text).slice(0, 60), { delay: 20 }); if (enter) await e.press("Enter"); await settle(); return state(); },
    async key(k) { if (k === "Back") await page.goBack({ timeout: 4000 }).catch(() => page.evaluate(() => history.back())); else await page.keyboard.press(k); await settle(); return state(); },
    // the wheel turns where the pointer is: in the middle of the screen, so an open sheet or dialog scrolls, not the page behind it
    // (from the corner, the walk of 2.11 read two sheets as "can't scroll")
    async scroll(dy) { await page.mouse.move(Math.round(d.w / 2), Math.round(d.h / 2)); await page.mouse.wheel(0, Math.max(-3000, Math.min(3000, dy))); await settle(); return state(); },
    async shot() { return page.screenshot({ type: "png" }); },
    async close() { await browser.close().catch(() => {}); server.close(); },
  };
}

// ---- one walk: the tool loop. Every request carries the whole walk so far; the newest turn is marked for the cache, so each request
// pays full price only for what is new since the last one
async function walk(name, def, api, cl, tally) {
  const page = await (IO.browser || openPage)(def), notes = [], msgs = [{ role: "user", content: [{ type: "text", text: `You are: ${def.who}\nThe screen is ${def.dev.w}x${def.dev.h}, ${def.theme} theme. Start with look.` }] }];
  let steps = 0, summary = "", why = "", key = false;
  try {
    for (let turn = 0; turn < STEPS + 5 && !summary; turn++) {
      // move the cache mark to the newest user turn
      for (const m of msgs) if (m.role === "user") for (const b of m.content) delete b.cache_control;
      const last = msgs[msgs.length - 1].content; last[last.length - 1].cache_control = { type: "ephemeral" };
      const r = await cl.ask(api, { model: MODEL, max_tokens: MAX_TOKENS, system: [{ type: "text", text: SYSTEM }], tools: TOOLS, output_config: { effort: "medium" }, messages: msgs });
      if (r.error) { why = r.error.why; key = r.error.key; break; }
      const u = cl.usage(r.msg); for (const k in u) tally.tokens[k] = (tally.tokens[k] || 0) + u[k]; tally.requests++;
      tally.usd += (u.input * PRICE[0] + u.cacheWrite * PRICE[0] * 1.25 + u.cacheRead * PRICE[0] * 0.1 + u.output * PRICE[1]) / 1e6;
      msgs.push({ role: "assistant", content: r.msg.content });
      const uses = (r.msg.content || []).filter((b) => b.type === "tool_use");
      if (!uses.length) { summary = clip(cl.answer(r.msg).text, 400) || "(ended without a summary)"; break; }
      const results = [];
      for (const t of uses) {
        steps++;
        const res = (content, err) => results.push({ type: "tool_result", tool_use_id: t.id, content, ...(err ? { is_error: true } : {}) });
        if (steps > STEPS && t.name !== "finish" && t.name !== "note") { res("No more steps: call finish now.", true); continue; }
        const a = t.input || {};
        try {
          if (t.name === "look") { const l = await page.look(); res([{ type: "image", source: { type: "base64", media_type: "image/png", data: l.png.toString("base64") } }, { type: "text", text: l.text }]); }
          else if (t.name === "tap") res(await page.tap(a.ref));
          else if (t.name === "type") res(await page.type(a.ref, a.text, a.enter));
          else if (t.name === "key") res(await page.key(a.key));
          else if (t.name === "scroll") res(await page.scroll(a.dy));
          else if (t.name === "note") { const n = { walk: name, i: notes.length + 1, severity: a.severity, kind: a.kind, where: clip(a.where, 160), what: clip(a.what, 600), png: await page.shot() }; notes.push(n); res("Noted."); }
          else if (t.name === "finish") { summary = clip(a.summary, 400) || "(no summary)"; res("Done."); }
          else res("No such tool.", true);
        } catch (e) { res("That did not work: " + clip(String(e.message).split("\n")[0], 200) + ". Look again: the refs change after every look.", true); }
      }
      msgs.push({ role: "user", content: results });
    }
  } finally { await page.close(); }
  return { name, notes, steps, summary, why, key };
}

function seal(obj) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv);
  const data = Buffer.concat([ci.update(JSON.stringify(obj)), ci.final()]);
  const ek = crypto.publicEncrypt({ key: IO.pub(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  return JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") });
}

function reportMd(date, results, run) {
  const all = results.flatMap((r) => r.notes), rank = { high: 0, medium: 1, low: 2 }, cell = (s) => clip(s, 500).replace(/\|/g, "/");
  return [`### Exploratory walk ${date}: ${all.length} notes, ${all.filter((n) => n.severity === "high").length} high`, "",
    `${run ? `[run](${run}). ` : ""}Report only: Claude Sonnet used the page on next like a person, with the example plates and nothing leaving the machine. Notes are its own judgement, not checked yet.`, "",
    ...results.flatMap((r) => [`#### ${r.name}: ${r.steps} steps, ${r.notes.length} notes${r.why ? ` (stopped: ${r.why})` : ""}`, "", r.summary ? `> ${r.summary}\n` : "",
      ...(r.notes.length ? ["| severity | kind | where | what | screen |", "|---|---|---|---|---|",
        ...[...r.notes].sort((a, b) => rank[a.severity] - rank[b.severity]).map((n) => `| ${n.severity} | ${n.kind} | ${cell(n.where)} | ${cell(n.what)} | [shot](${r.name}-${n.i}.png) |`), ""] : ["No notes.", ""])]),
  ].join("\n");
}

async function tell(kind, extra = {}) {
  let router, tg; try { router = await IO.router(); tg = await IO.tg(); } catch { return; }
  try {
    if (kind === "key") await router.alert("day", "ai:key", tg.msg({ kind: "today", area: "bots", title: "מפתח ה-Claude API לא עובד או שהקרדיט נגמר",
      text: "הסיור השבועי באפליקציה לא רץ. סביר שגם שאר הבוטים שנעזרים ב-Claude ממשיכים בלעדיו.",
      what: "להיכנס לקונסולה של Anthropic ולבדוק את המפתח ואת תקרת ההוצאה של luchit-bots. אם צריך, להדביק את המפתח מחדש בסוד ANTHROPIC_API_KEY." }), extra.link || "", { today: "loud", legacy: () => false });
    else if (kind === "api") await router.alert("summary", "ai:walk", tg.msg({ kind: "info", area: "bots", title: "הסיור השבועי באפליקציה לא הצליח לפנות ל-Claude",
      text: "הסיור ידלג השבוע. אפשר להריץ אותו שוב ידנית.", raw: extra.why }), extra.link || "", { today: "silent", legacy: () => false });
    else if (kind === "notes") await router.alert("summary", `walk:${extra.date}`, tg.msg({ kind: "info", area: "app", title: "הסיור השבועי באפליקציה מצא דברים לבדוק",
      text: `${extra.high} הערות חשובות מתוך ${extra.all}. זו התרשמות של Claude, ושרשור הבדיקות בודק אותן לפני שמשהו משתנה.`, what: "שרשור הבדיקות עובר על הדוח." }), extra.link || "", { today: "silent", legacy: () => false });
    else await router.resolve(["ai:walk", "ai:key"]);
  } catch { /* the report still says it */ }
}

async function run(o) {
  const env = IO.env, say = IO.out, stop = (t) => { say(`::notice title=Exploratory walk::skipped: ${t}`); return 0; };
  if (String(env.EXPLORE || "").toLowerCase() === "off") return stop("EXPLORE=off");
  if (!env.ANTHROPIC_API_KEY) return stop("no ANTHROPIC_API_KEY");
  const names = (o.walks || Object.keys(WALKS_DEF).join(",")).split(",").filter((n) => WALKS_DEF[n]);
  if (!names.length) return stop("no known walk named");
  const statePath = path.join(o.out, "state.json"), now = new Date(IO.now()), month = now.toISOString().slice(0, 7), date = now.toISOString().slice(0, 10);
  const st = J(fs.existsSync(statePath) ? fs.readFileSync(statePath, "utf8") : "") || {};
  if (st.month !== month) Object.assign(st, { month, walks: 0 });
  if (st.walks + names.length > WALKS) return stop(`this month's ${WALKS} walks are used`);
  const cl = await IO.claude(), { api, why } = await cl.client(env, { timeout: 5 * 60000 });
  if (!api) { await tell("api", { why, link: o.run }); return stop(why); }
  const tally = { requests: 0, tokens: {}, usd: 0 }, results = [];
  for (const n of names) { const r = await walk(n, WALKS_DEF[n], api, cl, tally); results.push(r); if (r.key) break; }
  const done = results.filter((r) => r.steps > 0 && !(r.why && !r.notes.length && r.steps < 3));
  if (results.some((r) => r.key)) await tell("key", { link: o.run });
  else if (!done.length) await tell("api", { why: results.map((r) => r.why).filter(Boolean)[0] || "no walk ran", link: o.run });
  if (!done.length) return stop("no walk got far enough: " + (results.map((r) => r.why).filter(Boolean)[0] || "unknown"));
  const dir = path.join(o.out, date); fs.mkdirSync(dir, { recursive: true }); fs.mkdirSync(path.join(o.out, "usage"), { recursive: true });
  for (const r of results) for (const n of r.notes) fs.writeFileSync(path.join(dir, `${r.name}-${n.i}.png`), n.png);
  const md = reportMd(date, results, o.run);
  fs.writeFileSync(path.join(dir, "report.md"), md);
  fs.writeFileSync(path.join(o.out, "latest.md"), md.replace(/\]\(([a-z]+-\d+\.png)\)/g, `](${date}/$1)`));
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify(results.map((r) => ({ ...r, notes: r.notes.map(({ png, ...n }) => n) })), null, 1));
  fs.writeFileSync(path.join(o.out, "usage", `${now.toISOString().replace(/[:.]/g, "-")}.enc.json`), seal({ at: now.toISOString(), model: MODEL, requests: tally.requests, tokens: tally.tokens, usd: +tally.usd.toFixed(4) }));
  st.walks += done.length; fs.writeFileSync(statePath, JSON.stringify(st, null, 1));
  try { if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, md + "\n"); } catch {}
  const all = results.flatMap((r) => r.notes), high = all.filter((n) => n.severity === "high").length;
  say(`exploratory walk ${date}: ${results.map((r) => `${r.name} ${r.steps} steps ${r.notes.length} notes`).join(", ")}`);
  for (const n of all.slice(0, 15)) say(`::notice title=Walk ${n.walk}: ${n.kind} (${n.severity})::${clip(n.where, 80)}: ${clip(n.what, 240)}`);
  const link = `https://github.com/${env.GITHUB_REPOSITORY || "ddsabag/vehicle-app"}/blob/explore-out/latest.md`;
  if (high) await tell("notes", { date, high, all: all.length, link });
  if (!results.some((r) => r.key)) await tell("clean");
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, "wrote=1\n");
  return 0;
}

// ---- self-test: a fake page and a fake API, no browser and nothing leaving the machine
async function selftest() {
  let bad = 0; const print = IO.out, ok = (c, m) => { print((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  const os = require("node:os"), tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ex-")), keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pub = keys.publicKey.export({ type: "spki", format: "pem" });
  const open = (f) => { const e = J(fs.readFileSync(f, "utf8"));
    const k = crypto.privateDecrypt({ key: keys.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
    const d = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64")); return J(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()]).toString()); };
  const did = [], PNG = Buffer.from("89504e470d0a1a0a", "hex");
  IO.browser = async (def) => ({ look: async () => ({ png: PNG, text: "screen #\n1 input[text] \"מספר רכב\"\n2 button \"בדיקה\"" }),
    tap: async (r) => { did.push("tap " + r); if (r === 9) throw new Error("locator timeout\nmore"); return "screen #car"; }, type: async (r, t) => { did.push(`type ${r} ${t}`); return "screen #"; },
    key: async (k) => { did.push("key " + k); return "screen #"; }, scroll: async () => "screen #", shot: async () => PNG, close: async () => { did.push("close " + def.dev.w); } });
  let script = [], calls = [];
  const use = (name, input) => ({ type: "tool_use", id: "t" + Math.random().toString(36).slice(2, 8), name, input });
  const fakeCl = { client: async (env) => (env.ANTHROPIC_API_KEY ? { api: {}, why: "" } : { api: null, why: "no ANTHROPIC_API_KEY" }),
    ask: async (api, p) => { calls.push(JSON.parse(JSON.stringify(p))); const s = script.shift(); if (!s) return { msg: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: {} } };
      if (s.error) return { error: s.error }; return { msg: { stop_reason: "tool_use", content: [{ type: "thinking", thinking: "" }, ...s], usage: { input_tokens: 500, output_tokens: 100, cache_read_input_tokens: 3000 } } }; },
    usage: (m) => { const u = (m && m.usage) || {}; return { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheRead: u.cache_read_input_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0 }; },
    answer: (m) => ({ text: ((m && m.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("") }) };
  const told = [], logs = [];
  Object.assign(IO, { env: { ANTHROPIC_API_KEY: "test", GITHUB_REPOSITORY: "o/r" }, out: (s) => logs.push(s), pub: () => pub, claude: async () => fakeCl, now: () => Date.parse("2026-11-02T03:30:00Z"),
    router: async () => ({ alert: async (lv, k) => { told.push(`${lv} ${k}`); }, resolve: async (p) => { told.push("resolve " + p.join("+")); } }), tg: async () => ({ msg: (o) => o.title }) });
  const out = path.join(tmp, "out");
  // a walk: look, type a plate, tap, a failing tap, a note, finish
  script = [[use("look", {})], [use("type", { ref: 1, text: "12-345-67", enter: true }), use("tap", { ref: 2 })], [use("tap", { ref: 9 })],
    [use("note", { severity: "high", kind: "cut_text", where: "car screen, title", what: "the model name is cut at its start" })], [use("finish", { summary: "one cut name" })]];
  ok(await run({ out, walks: "buyer", run: "https://example.invalid/r/1" }) === 0, "a walk runs");
  ok(did.join() === "type 1 12-345-67,tap 2,tap 9,close 390", "the tools act on the page, and the page closes");
  const toolMsgs = calls.at(-1).messages.filter((m) => m.role === "user").slice(1);
  ok(toolMsgs[0].content[0].content[0].type === "image" && toolMsgs[1].content.length === 2 && toolMsgs[2].content[0].is_error && /refs change/.test(toolMsgs[2].content[0].content), "a look returns the screenshot, two tools in one turn answer together, a failed tap says so");
  ok(calls.every((p) => p.model === MODEL && p.output_config.effort === "medium" && !("tool_choice" in p) && !("temperature" in p)) && calls.every((p) => p.messages.flatMap((m) => m.role === "user" ? m.content : []).filter((b) => b.cache_control).length === 1),
    "requests: Sonnet, effort medium, no forced tool, one cache mark on the newest turn");
  ok(calls[1].messages[1].content[0].type === "thinking", "the assistant's turns go back whole (thinking included)");
  const md = fs.readFileSync(path.join(out, "2026-11-02", "report.md"), "utf8"), latest = fs.readFileSync(path.join(out, "latest.md"), "utf8");
  ok(/1 notes, 1 high/.test(md) && /\(buyer-1\.png\)/.test(md) && /\(2026-11-02\/buyer-1\.png\)/.test(latest) && fs.existsSync(path.join(out, "2026-11-02", "buyer-1.png")), "the report, its screenshot, latest.md pointing into the day");
  ok(told.join() === "summary walk:2026-11-02,resolve ai:walk+ai:key", "a high note tells the router; a good walk closes ai:walk and ai:key");
  ok(!/usd|\$|input_tokens|cacheRead/i.test(md + fs.readFileSync(path.join(out, "state.json"), "utf8")), "public files: no dollars and no tokens");
  { const u = fs.readdirSync(path.join(out, "usage")); const s = open(path.join(out, "usage", u[0])); ok(s.requests === 5 && s.tokens.cacheRead === 15000 && s.usd > 0, "the usage is sealed"); }
  // the step cap: a model that never finishes is told to, and stops
  script = Array.from({ length: STEPS + 10 }, () => [use("scroll", { dy: 300 })]); calls = []; told.length = 0;
  await run({ out, walks: "owner" });
  const lastUser = calls.at(-1).messages.at(-1).content[0];
  ok(calls.length <= STEPS + 5 && lastUser.is_error && /No more steps/.test(lastUser.content), "the step cap: told to finish, and the loop ends");
  // API trouble
  script = [{ error: { why: "529 server", key: false } }]; told.length = 0; logs.length = 0;
  ok(await run({ out, walks: "visitor" }) === 0 && told.join() === "summary ai:walk" && /no walk got far/.test(logs.at(-1)), "an API error before any step: ai:walk (summary), nothing written");
  script = [{ error: { why: "401 key", key: true } }]; told.length = 0;
  ok(await run({ out, walks: "visitor,buyer" }) === 0 && told.join() === "day ai:key", "the key: ai:key (day), the other walks not tried");
  for (const [env, re] of [[{ EXPLORE: "off", ANTHROPIC_API_KEY: "x" }, /EXPLORE=off/], [{}, /no ANTHROPIC_API_KEY/]]) { IO.env = env; logs.length = 0; ok(await run({ out }) === 0 && re.test(logs.at(-1)), "skipped: " + re.source); }
  IO.env = { ANTHROPIC_API_KEY: "test" };
  { const s = J(fs.readFileSync(path.join(out, "state.json"), "utf8")); s.walks = WALKS; fs.writeFileSync(path.join(out, "state.json"), JSON.stringify(s)); }
  logs.length = 0; calls = []; ok(await run({ out, walks: "buyer" }) === 0 && !calls.length && /walks are used/.test(logs.at(-1)), "the month's cap");
  ok(Object.values(WALKS_DEF).every((d) => ["empty", "one", "many", "owner"].includes(d.state)) && TOOLS.map((t) => t.name).join() === "look,tap,type,key,scroll,note,finish", "walks use ui-flows' states; the tools");
  ok(!/\b\d{7,8}\b/.test(Object.values(WALKS_DEF).map((d) => d.who).join(" ").replace(/1234567|7654321|1111111/g, "")), "the walks name only the example plates");
  fs.rmSync(tmp, { recursive: true, force: true });
  print(bad ? `selftest: ${bad} failed` : "selftest: all passed");
  return bad ? 1 : 0;
}

if (require.main === module) {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) { const k = a[i].replace(/^--/, ""); if (["out", "walks", "run"].includes(k)) o[k] = a[++i]; }
  (a[0] === "selftest" ? selftest() : run(o)).then((c) => process.exit(c), (e) => { IO.out(`::error title=Exploratory walk::it stopped on its own error (${clip(String(e && e.message || e).replace(/\d[\d,.\-]{3,}\d/g, "#"), 160)}), not on a note`); process.exit(1); });
}
module.exports = { WALKS_DEF, TOOLS, SYSTEM, MODEL };
