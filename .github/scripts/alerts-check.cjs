// One-off (5.11.2026, CEO thread: only 5 alerts in 26.10-4.11): does a real notification reach the phone from the saved-car check?
// The app (qa build of main) gets a saved car with an insurance document that expires in 5 days and a service due in 3 days (both checked
// on the phone, no registry needed), the background check is forced to run, and the phone's notification list is read. Then the phone is
// restarted and the check must still be scheduled and run. Example plate only (the app's own, 38548003). Usage: node alerts-check.cjs app.apk out.json
const { _android: android } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
const [APK, OUT] = process.argv.slice(2);
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`, PLATE = "38548003";
const adb = (a, t = 120000) => execFileSync("adb", a, { encoding: "utf8", timeout: t, stdio: ["ignore", "pipe", "pipe"] });
const sh = (c) => { try { return adb(["shell", c]).trim(); } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let device;
async function page(timeout = 60000) {
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
const jobs = () => sh(`dumpsys jobscheduler | grep -E "JOB #.*${PKG}"`);
const jobId = () => { const m = jobs().match(/JOB #\S+\/(\d+): \S+ \S*SystemJobService/) || jobs().match(/\/(\d+):/); return m && m[1]; };
const notes = () => sh(`dumpsys notification --noredact | grep -A40 "pkg=${PKG}" | grep -E "android.title=|android.text=" `);
async function force(res, tag) {
  const id = jobId(); res[tag + "_job"] = id || "none";
  if (!id) return;
  sh(`cmd jobscheduler run -f ${PKG} ${id}`); await sleep(45000);
  res[tag + "_worker_log"] = sh(`logcat -d -s WM-WorkerWrapper:I WM-Processor:I | grep -i SavedCheck | tail -3`);
}
(async () => {
  const res = {};
  try {
    sh("setprop persist.sys.timezone Asia/Jerusalem"); await sleep(1000);
    res.phoneTime = sh("date");
    try { adb(["uninstall", PKG]); } catch {}
    adb(["install", APK]);
    const sdk = +sh("getprop ro.build.version.sdk"); res.sdk = sdk;
    if (sdk >= 33) sh(`pm grant ${PKG} android.permission.POST_NOTIFICATIONS`);
    sh(`am start -W -n ${ACT}`); let p = await page();
    res.seed = await p.evaluate((plate) => {
      const d = (n) => { const x = new Date(); x.setDate(x.getDate() + n); return x.toISOString().slice(0, 10); };
      localStorage.setItem("savedVehicles", JSON.stringify([{ plate, title: "רכב לדוגמה", sub: "", at: Date.now(), reg: "active", active: true, events: [] }]));
      localStorage.setItem("docExp", JSON.stringify([{ id: 1, plate, cat: "ביטוח", exp: d(5) }]));
      try { syncSaved(JSON.parse(localStorage.getItem("savedVehicles"))); } catch (e) { return "syncSaved failed: " + e.message; }
      return { kinds: (typeof ALERT_KINDS !== "undefined" ? ALERT_KINDS.map((k) => k[0] + (alertPrefs()[k[0]] === false ? ":off" : ":on")) : "?"), plan: typeof plan === "function" ? plan() : "?", alerts: typeof alertSet === "function" ? alertSet() : "?", insuranceExp: d(5) };
    }, PLATE);
    await sleep(15000);   // localStorage and the app's own list reach the disk
    res.jobsAfterSave = jobs() || "none";
    res.notificationsEnabled = sh(`cmd notification allowed_listeners >/dev/null; dumpsys notification | grep -c "${PKG}"`);
    await force(res, "run1");
    res.notesAfterRun1 = notes() || "none";
    // a restart of the phone: WorkManager must schedule the check again on its own
    sh("cmd notification cancel_all 2>/dev/null; true");
    adb(["reboot"]); await sleep(15000); adb(["wait-for-device"], 300000);
    for (let i = 0; i < 60 && sh("getprop sys.boot_completed") !== "1"; i++) await sleep(3000);
    await sleep(20000);
    res.jobsAfterReboot = jobs() || "none";
    await force(res, "run2");
    res.notesAfterRun2 = notes() || "none";
    res.prefsFile = sh(`run-as ${PKG} sh -c 'cat shared_prefs/saved_alerts.xml' 2>&1 | grep -v '"saved"' | head -30`);
    res.verdict = /ביטוח/.test(res.notesAfterRun1) ? "ALERT_SHOWN" : "NO_ALERT";
  } catch (e) { res.verdict = "ERROR"; res.error = String(e && e.stack || e).slice(0, 600); }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
  if (device) await device.close().catch(() => {});
  process.exit(0);
})();
