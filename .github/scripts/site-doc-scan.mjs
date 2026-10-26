// One-off live check of 1.38.1 on the deployed site, in a fresh phone browser: the version and the service-worker shell, then the expiry
// read from two synthetic documents (a PDF with its own text through pdf.js, a photo through the on-device reader) with the reader files
// coming from the real CDN under their pinned hashes. The Ministry API is answered with a synthetic car (12345678); nothing leaves the
// browser: events go to a fake app bridge, and every other host and every non-GET request is blocked. Prints JSON lines; writes out/report.txt.
import fs from "node:fs";
const SITE = (process.env.SITE || "https://luchit.app/").replace(/\/?$/, "/");
const WANT = process.env.WANT || "1.38.1";
const { chromium } = await import("playwright");
const lines = [], say = o => { const t = JSON.stringify(o); console.log(t); lines.push(t); };
let fails = 0; const ok = (c, check, more) => { say({ ok: !!c, check, ...(more || {}) }); if (!c) fails++; };
const day = n => { const t = new Date(); t.setHours(12, 0, 0, 0); t.setDate(t.getDate() + n); return t; };
const p2 = n => String(n).padStart(2, "0");
const dmy = t => `${p2(t.getDate())}/${p2(t.getMonth() + 1)}/${t.getFullYear()}`, ymd = t => `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`;
const CAR = { _id: 1, mispar_rechev: 12345678, tozeret_nm: "טויוטה יפן", kinuy_mishari: "COROLLA", degem_nm: "ZRE172", shnat_yitzur: 2021, tzeva_rechev: "לבן", sug_delek_nm: "בנזין", tokef_dt: ymd(day(400)) + "T00:00:00", moed_aliya_lakvish: "2021-5", tozeret_cd: 1, degem_cd: 1, nefach_manoa: 1798, baalut: "פרטי" };
const UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
// a one-page PDF with real text (Helvetica), offsets computed so pdf.js reads it without repairing it
function pdf(rows) {
  const esc = s => s.replace(/[\\()]/g, m => "\\" + m);
  const text = "BT /F1 18 Tf 72 720 Td " + rows.map((r, i) => (i ? "0 -30 Td " : "") + `(${esc(r)}) Tj`).join(" ") + " ET";
  const objs = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let out = "%PDF-1.4\n"; const at = [];
  objs.forEach((o, i) => { at.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const x = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + at.map(n => String(n).padStart(10, "0") + " 00000 n \n").join("") +
    `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
const b = await chromium.launch();
try {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "he-IL", userAgent: UA });
  const net = [], site = new URL(SITE).hostname;
  await ctx.route("**/*", async r => {
    const q = r.request(), u = new URL(q.url());
    if (u.hostname.endsWith("data.gov.il")) { const recs = u.href.includes("053cea08") ? [CAR] : []; return r.fulfill({ status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify({ success: true, result: { records: recs, total: recs.length } }) }); }
    if (q.method() === "GET" && (u.hostname === "cdn.jsdelivr.net" || (u.hostname === site && !u.pathname.startsWith("/api/")))) return r.continue();
    return r.abort();
  });
  ctx.on("requestfinished", async q => { if (/jsdelivr/.test(q.url())) { const s = await q.response().catch(() => null); net.push({ u: q.url().replace("https://cdn.jsdelivr.net/npm/", ""), s: s && s.status() }); } });
  ctx.on("requestfailed", q => { if (/jsdelivr/.test(q.url())) net.push({ u: q.url().replace("https://cdn.jsdelivr.net/npm/", ""), failed: q.failure() && q.failure().errorText }); });
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    try { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("savedVehicles", JSON.stringify([{ plate: "12345678", title: "טויוטה COROLLA", at: Date.now(), reg: "active" }])); localStorage.setItem("mine", '{"12345678":1}'); localStorage.setItem("fold:מסמכים", "0"); localStorage.setItem("reviewAsked", "1"); sessionStorage.setItem("seeded", "1"); } } catch {}
    window.__ev = []; window.__err = [];
    window.addEventListener("error", e => window.__err.push({ m: String(e.message).slice(0, 120), f: String(e.filename || "").slice(0, 60), l: e.lineno, blocked: e.defaultPrevented }));
    window.AndroidApp = { logEvent: (n, p) => window.__ev.push([n, JSON.parse(p)]), setAlerts() {}, alertsState() { return "on"; }, setAnalytics() {}, checkUpdate() {}, setLandscape() {}, askReview() {}, syncSaved() {} };
  });
  const page = await ctx.newPage(), pageErrors = [];
  page.on("pageerror", e => pageErrors.push(String(e.message).slice(0, 160)));
  const sw = await (await fetch(SITE + "sw.js", { cache: "no-store" })).text();
  await page.goto(SITE + "?plate=12345678", { waitUntil: "domcontentloaded", timeout: 60000 });
  const app = await page.evaluate(() => typeof APP_VERSION === "string" ? APP_VERSION : null);
  ok(app === WANT, "the site runs " + WANT, { app, shell: (sw.match(/luchit-shell-[0-9.]+/) || [])[0] });
  ok(sw.includes("luchit-shell-" + WANT), "sw.js shell is " + WANT);
  await page.waitForSelector('.tabs [data-tab="file"]', { timeout: 30000 }); await page.click('.tabs [data-tab="file"]'); await page.waitForSelector("#docCat");
  const add = async (cat, name, mimeType, buffer) => {
    const n0 = await page.evaluate(() => window.__ev.filter(e => e[0] === "doc_scan").length);
    await page.selectOption("#docCat", cat); await page.setInputFiles("#docFile", { name, mimeType, buffer });
    const t0 = Date.now();
    await page.waitForFunction(n0 => window.__ev.filter(e => e[0] === "doc_scan").length > n0, n0, { timeout: 170000 }).catch(() => null);
    const sec = Math.round((Date.now() - t0) / 1000);
    const row = await page.evaluate(() => { const i = document.querySelector("#docList li.doc [data-docexp]");   // the newest document is listed first
    const p = i && i.closest(".doc-exp"); return i ? { value: i.value, hint: p.querySelector("small").textContent, save: !!p.querySelector("[data-docsave]") } : null; });
    const scan = await page.evaluate(() => window.__ev.filter(e => e[0] === "doc_scan").pop() || null);
    return { sec, row, scan: scan && scan[1] };
  };
  // 1 a PDF with its own text: insurance from in 5 days to in 370 days, printed today; the end of the policy must be offered
  const end1 = day(370), r1 = await add("ביטוח", "policy.pdf", "application/pdf", pdf(["Compulsory insurance certificate", `From ${dmy(day(5))} to ${dmy(end1)}`, `Printed ${dmy(day(0))}`]));
  ok(r1.scan && r1.scan.kind === "pdf_text" && r1.row && r1.row.value === ymd(end1) && r1.row.save, "PDF text: the end of the policy is offered with שמירה", { want: ymd(end1), ...r1 });
  // 2 a photo of a document (drawn here, the way a phone camera picture arrives): valid until in 200 days, issued 165 days ago
  const end2 = day(200);
  const jpg = await page.evaluate(async rows => {
    const c = document.createElement("canvas"); c.width = 1400; c.height = 900; const g = c.getContext("2d");
    g.fillStyle = "#fbfbf8"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#1a1a1a"; g.font = "bold 52px sans-serif";
    rows.forEach((r, i) => g.fillText(r, 90, 200 + i * 140));
    const bl = await new Promise(res => c.toBlob(res, "image/jpeg", 0.88)), a = new Uint8Array(await bl.arrayBuffer());
    let s = ""; for (let i = 0; i < a.length; i += 8192) s += String.fromCharCode(...a.subarray(i, i + 8192)); return btoa(s);
  }, ["VEHICLE LICENCE", `Valid until ${dmy(end2)}`, `Issued ${dmy(day(-165))}`]);
  const r2 = await add("רישיון רכב", "licence.jpg", "image/jpeg", Buffer.from(jpg, "base64"));
  ok(r2.scan && r2.scan.kind === "photo" && r2.row && r2.row.value === ymd(end2) && r2.row.save, "photo: the expiry is read on the phone and offered", { want: ymd(end2), ...r2 });
  // 3 the owner keeps the offered date
  const before = await page.evaluate(() => JSON.parse(localStorage.getItem("docExp") || "[]").length);
  await page.click("#docList [data-docsave]"); await page.waitForTimeout(800);
  const after = await page.evaluate(() => JSON.parse(localStorage.getItem("docExp") || "[]").length);
  const exp = await page.evaluate(() => window.__ev.filter(e => e[0] === "doc_exp").map(e => e[1]));
  ok(after === before + 1 && exp.some(e => e.from === "scan"), "שמירה keeps the date (doc_exp from scan)", { before, after, doc_exp: exp });
  const err = await page.evaluate(() => window.__err);
  ok(!err.some(e => !e.blocked && !/^blob:/.test(e.f)), "no page error counted", { windowErrors: err, pageErrors });
  say({ cdn: net });
  say({ events: await page.evaluate(() => window.__ev.map(e => e[0]).filter((n, i, a) => a.indexOf(n) === i)) });
} catch (e) { fails++; say({ ok: false, check: "run", error: String(e && e.message || e).slice(0, 300) }); }
finally { await b.close(); }
say({ result: fails ? "FAIL " + fails : "all passed" });
try { if (fs.existsSync("out")) fs.writeFileSync("out/report.txt", lines.join("\n") + "\n"); } catch {}
process.exitCode = fails ? 1 : 0;
