// Documents in Safari's private browsing (website). A private window in WebKit keeps no file (Blob) in IndexedDB, so until 27.10.2026 a
// document added to a car's file failed there ("לא הצלחנו לשמור את המסמך"); DocDB now keeps the document's bytes instead and reads them back
// as a file. Here, in a WebKit context that keeps nothing on disk (as a private window), through the page's own code: a PDF and a photo go
// into a car's file, come back whole, the PDF takes an expiry date, the photo opens in the viewer, and both are deleted. The registry is
// mocked as in ui-flows.cjs (example plates only). Usage: node .github/scripts/docs-private.cjs [--engine webkit|chromium]
// Exit 1 on a failure: the UI guardian runs it in warning mode, as its Safari pass.
const fs = require("node:fs"), http = require("node:http"), path = require("node:path");
const { govRoute, UA } = require("./ui-flows.cjs");

const ROOT = process.cwd(), ENGINE = (process.argv.includes("--engine") && process.argv[process.argv.indexOf("--engine") + 1]) || "webkit";
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".webmanifest": "application/manifest+json" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p.endsWith("/")) p += "index.html";
  const f = path.join(ROOT, p);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" }); fs.createReadStream(f).pipe(res);
});
const fails = [], ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) fails.push(m); };

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await require("playwright")[ENGINE].launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 760 }, locale: "he-IL", userAgent: UA.phone, serviceWorkers: "block", hasTouch: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => r.abort());
  await ctx.route(/data\.gov\.il/, (r) => govRoute(r, null));
  await ctx.addInitScript(() => { try { localStorage.setItem("analyticsOff", "1"); localStorage.setItem("homeSheet", "1"); } catch {} });
  const page = await ctx.newPage(), errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/`); await page.waitForSelector("#homeMark", { state: "attached", timeout: 20000 });
  await page.fill("#plate", "1234567"); await page.press("#plate", "Enter"); await page.waitForSelector("#chead .mini-plate", { timeout: 20000 });

  // does this context refuse a file in IndexedDB, as a private window does? (if not, the fallback below is not what is being tested)
  const refuses = await page.evaluate(() => new Promise((done) => { const r = indexedDB.open("blobProbe", 1); r.onupgradeneeded = () => r.result.createObjectStore("s", { autoIncrement: true });
    r.onerror = () => done("open: " + (r.error && r.error.name)); r.onsuccess = () => { const db = r.result; try { const t = db.transaction("s", "readwrite"); t.objectStore("s").add({ b: new Blob(["x"]) }); t.oncomplete = () => done("no"); t.onerror = t.onabort = () => done("yes, " + (t.error && t.error.name)); } catch (e) { done("yes, " + e.name); } }; }));
  console.log(`${ENGINE}, a context that keeps nothing on disk: refuses a file in IndexedDB: ${refuses}`);

  const pdf = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
  const r = await page.evaluate(async (b64) => {
    const out = {}, toasts = [], t = document.getElementById("toast"), mo = new MutationObserver(() => toasts.push(t.textContent.trim()));
    mo.observe(t, { childList: true, characterData: true, subtree: true });
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await docsAdd([new File([bytes], "רישיון.pdf", { type: "application/pdf" })], current.plate, "אחר");
    const c = document.createElement("canvas"); c.width = 40; c.height = 30; c.getContext("2d").fillRect(0, 0, 40, 30);
    await docsAdd([new File([await new Promise((ok) => c.toBlob(ok, "image/png"))], "חשבונית.png", { type: "image/png" })], current.plate, "חשבונית טיפול או תיקון");
    await new Promise((ok) => setTimeout(ok, 300)); mo.disconnect(); out.toasts = [...new Set(toasts)].filter(Boolean);
    const list = await DocDB.byPlate(current.plate), p = list.find((x) => x.type === "application/pdf"), im = list.find((x) => x.type === "image/jpeg");
    out.n = list.length;
    if (p) { const b = new Uint8Array(await p.blob.arrayBuffer()); out.pdf = { size: b.length, head: String.fromCharCode(...b.slice(0, 5)), asBytes: !!p.buf };
      p.exp = "2027-01-31"; try { await DocDB.upd(p); const again = await DocDB.get(p.id); out.dated = again.exp === "2027-01-31" && again.blob.size === b.length; } catch (e) { out.dated = e.name; } }
    if (im) { openDoc(im); await new Promise((ok) => setTimeout(ok, 600)); const v = document.querySelector(".doc-view img, .doc-view canvas"); out.viewer = !!(v && (v.naturalWidth || v.width)); }
    for (const x of list) await DocDB.del(x.id);
    out.left = (await DocDB.byPlate(current.plate)).length;
    return out;
  }, pdf.toString("base64"));
  ok(r.n === 2 && r.toasts.some((s) => /נשמר/.test(s)) && !r.toasts.some((s) => /לא הצלחנו/.test(s)), `a PDF and a photo saved (${r.n} in the car's file; the toasts said: ${r.toasts.join(" | ")})`);
  ok(r.pdf && r.pdf.size === pdf.length && r.pdf.head === "%PDF-", `the PDF came back whole (${JSON.stringify(r.pdf)})`);
  ok(r.dated === true, `the PDF kept its expiry date (${r.dated})`);
  ok(r.viewer === true, "the photo opened in the viewer");
  ok(r.left === 0, "both deleted");
  ok(!errs.length, "no page errors " + errs.join(" | "));
  await browser.close(); server.close();
  if (fails.length) { for (const f of fails) console.log(`::warning::(Safari's private browsing) documents: ${f}`); process.exit(1); }
  console.log("documents in a private window: saved, read back whole, dated, opened and deleted");
})().catch((e) => { console.log(`::warning::(Safari's private browsing) documents: the check crashed: ${String(e && e.message || e).slice(0, 300)}`); process.exit(1); });
