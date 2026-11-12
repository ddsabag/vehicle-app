// One-off probe (12.11.2026, Dudu: saved cars and documents gone after a long time without opening the app, Android).
// Seeds a saved car (localStorage + the app's native copy) and a document (IndexedDB), then puts the phone through what Android does to an
// app nobody opens: a cold restart, cache trimming under storage pressure, app hibernation, months on the clock, a reboot, and a nearly full disk.
// After each step the app is opened again and every store is counted. Example plate only. Usage: node storage-wipe-check.cjs app.apk out.json
const { _android: android } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const [APK, OUT] = process.argv.slice(2);
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`, PLATE = "38548003";
const adb = (a, t = 180000) => execFileSync("adb", a, { encoding: "utf8", timeout: t, stdio: ["ignore", "pipe", "pipe"] });
const sh = (c, t) => { try { return adb(["shell", c], t).trim(); } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let device;
async function page(timeout = 90000) {
  const t0 = Date.now();
  for (;;) {
    if (device) await device.close().catch(() => {});
    [device] = await android.devices({ omitDriverInstall: true });
    const pid = sh(`pidof ${PKG}`).split(/\s+/)[0];
    const wv = pid && device.webViews().find((w) => w.pkg() === PKG && String(w.pid()) === pid);
    if (wv) { const p = await wv.page(); await p.waitForFunction(() => document.readyState === "complete", null, { timeout: 20000 }); await sleep(3000); return p; }
    if (Date.now() - t0 > timeout) throw new Error("no WebView of the app");
    await sleep(1500);
  }
}
const nativeSaved = () => { const x = sh(`run-as ${PKG} cat shared_prefs/saved_alerts.xml`); const m = x.match(/name="saved">([^<]*)</); return m ? (m[1].match(/plate/g) || []).length : -1; };
const files = () => sh(`run-as ${PKG} sh -c 'du -sk app_webview/Default/* cache/* 2>/dev/null | sort -k2 | head -30'`);
async function open(tag, res) {
  sh(`am force-stop ${PKG}`); await sleep(1500);
  sh(`am start -W -n ${ACT}`); const p = await page();
  const s = await p.evaluate(async () => {
    let saved = -1, docs = -1, keys = -1, persisted = "?";
    try { saved = JSON.parse(localStorage.getItem("savedVehicles") || "[]").length; keys = localStorage.length; } catch (e) { saved = "err " + e.message; }
    try { docs = (await DocDB.tx("readonly", (st) => st.getAll())).length; } catch (e) { docs = "err " + e.message; }
    try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : "n/a"; } catch (e) { persisted = "err"; }
    let est = null; try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch {}
    return { saved, docs, keys, persisted, usage: est && est.usage, quota: est && est.quota };
  });
  res.steps.push({ tag, ...s, native: nativeSaved(), clock: sh("date -u"), free: sh("df -h /data | tail -1") });
  console.log(tag, JSON.stringify(res.steps.at(-1)));
  return p;
}
(async () => {
  const res = { steps: [] };
  try {
    try { adb(["root"]); await sleep(4000); adb(["wait-for-device"]); } catch {}
    res.sdk = sh("getprop ro.build.version.sdk");
    try { adb(["uninstall", PKG]); } catch {}
    for (let i = 0; ; i++) { try { adb(["wait-for-device"], 120000); adb(["install", APK]); break; } catch (e) { if (i === 2) throw e; await sleep(10000); } }
    sh(`am start -W -n ${ACT}`); let p = await page();
    res.seed = await p.evaluate(async (plate) => {
      localStorage.setItem("savedVehicles", JSON.stringify([{ plate, title: "רכב לדוגמה", sub: "", at: Date.now(), reg: "active", active: true, events: [] }]));
      try { syncSaved(JSON.parse(localStorage.getItem("savedVehicles"))); } catch {}
      const blob = new Blob([new Uint8Array(200000)], { type: "application/pdf" });
      const id = await DocDB.put({ plate, cat: "ביטוח", name: "insurance.pdf", type: blob.type, size: blob.size, at: Date.now(), exp: "", blob });
      return { id };
    }, PLATE);
    await sleep(15000);   // let both stores reach the disk
    res.filesAfterSeed = files();
    await open("cold-restart", res);
    // storage pressure: the system frees every app's cache (what a "clean up" or a low disk does)
    res.trim = sh("pm trim-caches 999G"); await open("trim-caches", res);
    // app hibernation (Android 12+): the system hibernates an app unused for months
    if (+res.sdk >= 31) { res.hib = sh(`cmd app_hibernation set-state ${PKG} true; cmd app_hibernation set-state --global ${PKG} true; cmd app_hibernation get-state ${PKG}`); await open("hibernated", res); }
    // months on the clock, then a reboot
    sh(`date -u ${(() => { const x = new Date(Date.now() + 200 * 864e5), q = (v) => String(v).padStart(2, "0"); return `${q(x.getUTCMonth() + 1)}${q(x.getUTCDate())}1030${x.getUTCFullYear()}.00`; })()}`);
    await open("200-days-later", res);
    adb(["reboot"]); await sleep(15000); adb(["wait-for-device"], 300000);
    for (let i = 0; i < 60 && sh("getprop sys.boot_completed") !== "1"; i++) await sleep(3000);
    await sleep(20000); try { adb(["root"]); await sleep(4000); adb(["wait-for-device"]); } catch {}
    await open("after-reboot", res);
    // a nearly full disk: fill /data until about 150 MB are left, then open the app and let it write
    const kb = +sh("df -k /data | tail -1 | awk '{print $4}'"); res.fillMb = Math.max(0, Math.floor(kb / 1024) - 150);
    res.fill = sh(`fallocate -l ${res.fillMb}M /data/local/tmp/fill.bin 2>&1 || dd if=/dev/zero of=/data/local/tmp/fill.bin bs=1048576 count=${res.fillMb} 2>&1 | tail -1`, 600000);
    p = await open("disk-almost-full", res);
    await p.evaluate(() => { try { localStorage.setItem("probe", "x".repeat(1000)); } catch {} });
    res.trim2 = sh("pm trim-caches 999G"); await sleep(5000);
    await open("disk-full-after-trim", res);
    sh("rm -f /data/local/tmp/fill.bin");
    await open("disk-freed", res);
    res.filesAtEnd = files();
    const last = res.steps.at(-1), lostAt = res.steps.find((s) => s.saved !== 1 || s.docs !== 1);
    res.verdict = lostAt ? "LOST_AT:" + lostAt.tag : "ALL_KEPT";
  } catch (e) { res.verdict = "ERROR"; res.error = String(e && e.stack || e).slice(0, 800); }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
  if (device) await device.close().catch(() => {});
  process.exit(0);
})();
