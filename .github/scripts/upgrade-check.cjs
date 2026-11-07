// One-off (5.11.2026, Dudu: insurance seemed gone after updating 1.38.3 -> 1.38.4): install the OLD app, put a saved car, "this is my car"
// and an insurance document with an expiry in it, then install the NEW app over it the way Play updates (adb install -r keeps the data)
// and read everything back from the new app's WebView. Synthetic plate only. Usage: node upgrade-check.cjs old.apk new.apk out.json
const { _android: android } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const [OLD, NEW, OUT] = process.argv.slice(2);
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`, PLATE = "7654321";
const adb = (a) => execFileSync("adb", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sh = (c) => adb(["shell", c]).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let device;
async function page(timeout = 60000) {
  const t0 = Date.now();
  for (;;) {
    if (device) await device.close().catch(() => {});
    [device] = await android.devices({ omitDriverInstall: true });
    const pid = sh(`pidof ${PKG}`).split(/\s+/)[0];
    const wv = pid && device.webViews().find((w) => w.pkg() === PKG && String(w.pid()) === pid);
    if (wv) { const p = await wv.page(); await p.waitForFunction(() => document.readyState === "complete", null, { timeout: 20000 }); await sleep(2500); return p; }
    if (Date.now() - t0 > timeout) throw new Error("no WebView of the app");
    await sleep(1500);
  }
}
const start = () => { sh(`am force-stop ${PKG}`); sh(`am start -W -n ${ACT}`); };
const readAll = (p) => p.evaluate(async () => {
  const db = await new Promise((ok, no) => { const r = indexedDB.open("luchitDocs"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
  const docs = db.objectStoreNames.contains("docs") ? await new Promise((ok) => { const r = db.transaction("docs").objectStore("docs").getAll(); r.onsuccess = () => ok(r.result.map(({ blob, buf, ...x }) => ({ ...x, hasFile: !!(blob || buf), fileSize: blob ? blob.size : buf ? buf.byteLength : 0 }))); }) : [];
  db.close();
  return { version: typeof APP_VERSION !== "undefined" ? APP_VERSION : "?", url: location.href.split("?")[0], savedVehicles: JSON.parse(localStorage.getItem("savedVehicles") || "[]").map((s) => s.plate), mine: localStorage.getItem("mine"), docExp: localStorage.getItem("docExp"), svcLog: Object.keys(localStorage).filter((k) => /svc|service|maint/i.test(k)), keys: Object.keys(localStorage).length, docs };
});
(async () => {
  const res = { steps: [] };
  try {
    try { adb(["uninstall", PKG]); } catch {}
    adb(["install", OLD]); res.steps.push("old installed: " + sh(`dumpsys package ${PKG} | grep versionName`).trim());
    start(); let p = await page();
    await p.evaluate(async (plate) => {
      localStorage.setItem("savedVehicles", JSON.stringify([{ plate, title: "קיה SPORTAGE", sub: "2017 · LX · לבן", at: Date.now(), reg: "active", active: true, events: [] }]));
      localStorage.setItem("mine", JSON.stringify({ [plate]: 1 }));
      const db = await new Promise((ok, no) => { const r = indexedDB.open("luchitDocs", 1); r.onupgradeneeded = () => r.result.createObjectStore("docs", { keyPath: "id", autoIncrement: true }).createIndex("plate", "plate"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      const blob = new Blob([new Uint8Array(20000).fill(37)], { type: "application/pdf" });
      const id = await new Promise((ok, no) => { const t = db.transaction("docs", "readwrite"), rq = t.objectStore("docs").add({ plate, cat: "ביטוח", name: "polisa.pdf", type: "application/pdf", size: blob.size, at: Date.now(), exp: "2027-03-01", blob }); t.oncomplete = () => ok(rq.result); t.onerror = () => no(t.error); });
      db.close();
      localStorage.setItem("docExp", JSON.stringify([{ id, plate, cat: "ביטוח", exp: "2027-03-01" }]));
    }, PLATE);
    // the first run (5.11) closed the app right after these writes and lost the localStorage part only (IndexedDB stayed): Chromium writes
    // localStorage to disk a few seconds later. So: wait as a person would, then close and open the old app once
    await sleep(15000);
    start(); p = await page();
    // and measure the gap itself: a key written just before the app is stopped (as Play stops it to update)
    await p.evaluate(() => localStorage.setItem("probeQuick", String(Date.now())));
    await sleep(500); start(); p = await page();
    res.quickKillKept = await p.evaluate(() => !!localStorage.getItem("probeQuick"));
    await p.evaluate(() => localStorage.setItem("probeSlow", String(Date.now())));
    await sleep(15000); start(); p = await page();
    res.slowKillKept = await p.evaluate(() => !!localStorage.getItem("probeSlow"));
    res.before = await readAll(p);
    // the update: Play installs the new version over the old one while the app may be in the background
    sh(`input keyevent KEYCODE_HOME`); await sleep(1500);
    adb(["install", "-r", NEW]); res.steps.push("new installed over it: " + sh(`dumpsys package ${PKG} | grep versionName`).trim());
    start(); p = await page();
    res.after = await readAll(p);
    // the heal (1.38.5): the car file's dates live in localStorage (docExp) and are lost when Play stops the app right after a write;
    // the new app rebuilds them from the documents (IndexedDB) at every start
    await p.evaluate(() => localStorage.removeItem("docExp"));
    sh(`am force-stop ${PKG}`); await sleep(2000); start(); p = await page(); await sleep(4000);
    res.healed = await p.evaluate(() => (localStorage.getItem("docExp") || "").includes("2027-03-01"));
    // the car file's tiles in the new app, after its page has drawn the file (mock registry not needed: read the stored list only)
    const same = JSON.stringify({ s: res.before.savedVehicles, m: res.before.mine, e: res.before.docExp, d: res.before.docs }) === JSON.stringify({ s: res.after.savedVehicles, m: res.after.mine, e: res.after.docExp, d: res.after.docs });
    res.verdict = res.before.docs.length && res.before.version !== res.after.version ? (!same ? "LOST_OR_CHANGED" : res.healed ? "KEPT" : "KEPT_NOT_HEALED") : "NOT_TESTED";
  } catch (e) { res.verdict = "ERROR"; res.error = String(e && e.stack || e).slice(0, 600); }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
  console.log(JSON.stringify(res, null, 1));
  if (device) await device.close().catch(() => {});
  process.exit(res.verdict === "KEPT" ? 0 : 1);
})();
