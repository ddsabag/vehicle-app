// Nightly in the App guardian (since 7.11.2026; first a one-off of 5.11 for the CEO thread): does a real notification reach the phone from the saved-car check?
// The app (qa build of main) gets a saved car with an insurance document that expires in 5 days and a service due in 3 days (both checked
// on the phone, no registry needed), the background check is forced to run, and the phone's notification list is read. Then the phone is
// restarted and the check must still be scheduled and run. Example plate only (the app's own, 38548003). Usage: node alerts-check.cjs app.apk out.json (exit 1 unless ALERT_SHOWN)
const { _android: android } = require("playwright");
const { execFileSync } = require("child_process");
const fs = require("fs");
// the device clock for a forced run: n days ahead, moved to a weekday the worker sends on (Sunday to Thursday; Friday after 14 and Saturday are quiet)
const sendDay = (n) => { const x = new Date(); x.setUTCDate(x.getUTCDate() + n); let days = n; while ([5, 6].includes(x.getUTCDay())) { x.setUTCDate(x.getUTCDate() + 1); days++; }
  const p = (v) => String(v).padStart(2, "0"); return { days, clock: `${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}1030${x.getUTCFullYear()}.00` }; };
const [APK, OUT] = process.argv.slice(2);
const PKG = "com.ddsabag.pratirechev", ACT = `${PKG}/.MainActivity`, PLATE = "38548003";
const adb = (a, t = 120000) => execFileSync("adb", a, { encoding: "utf8", timeout: t, stdio: ["ignore", "pipe", "pipe"] });
const sh = (c) => { try { return adb(["shell", c]).trim(); } catch (e) { return String(e.stdout || "") + String(e.stderr || ""); } };
const lastRun = () => (sh(`run-as ${PKG} sh -c 'cat shared_prefs/saved_alerts.xml' 2>/dev/null`).match(/name="last_run">([^<]*)</) || [])[1] || "";
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
// Android 14+ files WorkManager's jobs under a namespace ("JOB #u0a209/androidx.work.systemjobscheduler/0"), and `run` needs it (-n)
const jobs = () => sh(`dumpsys jobscheduler | grep -E "^ *JOB .*${PKG}"`);
const jobsRaw = () => sh(`dumpsys jobscheduler | grep -E "JOB |namespace" | grep -i -E "pratirechev|androidx.work" | head -20`);
const jobId = () => { const m = jobs().match(/JOB (?:#|([\w.]+):)u[0-9a-z]+\/(\d+):/); return m ? { ns: m[1] || "", id: m[2] } : null; };
const notes = () => sh(`dumpsys notification --noredact | grep -A40 "pkg=${PKG}" | grep -E "android.title=|android.text=" `);
// the check's first run is set for 10:00 the next morning (UTC on this emulator) and every 8 hours after; WorkManager will not run a periodic
// job before its time even when JobScheduler is forced, so the phone's clock is moved to the day and hour first (root on a google_apis image)
async function force(res, tag, when) {
  sh(`date -u ${when}`); await sleep(3000); res[tag + "_clock"] = sh("date -u");
  const j = jobId(); res[tag + "_job"] = j ? (j.ns ? j.ns + "/" : "") + j.id : "none";
  sh("logcat -c");
  if (j) { res[tag + "_run"] = sh(`cmd jobscheduler run -f ${j.ns ? "-n " + j.ns + " " : ""}${PKG} ${j.id}`); await sleep(60000); }
  res[tag + "_log"] = sh(`logcat -d | grep -E "WM-|SavedCheck|pratirechev" | tail -8`);
  res[tag + "_prefs"] = sh(`run-as ${PKG} cat shared_prefs/saved_alerts.xml`).replace(/<string name="saved">[\s\S]*?<\/string>/, "<saved list kept>").slice(0, 800);
}
(async () => {
  const res = {};
  try {
    try { adb(["root"]); await sleep(4000); adb(["wait-for-device"]); } catch {}
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
    res.jobsRaw = jobsRaw();
    res.wmDb = sh(`run-as ${PKG} ls -la databases no_backup files 2>&1 | head -20`);
    res.appLog = sh(`logcat -d --pid=$(pidof ${PKG}) | grep -v -E "chromium|cr_|Choreographer|OpenGL|EGL|gralloc|HWUI|ViewRootImpl|InputMethod|ImeTracker|InsetsController" | tail -40`);
    res.jobCount = sh(`dumpsys jobscheduler | grep -c ${PKG}`);
    res.jobLines = sh(`dumpsys jobscheduler | grep ${PKG} | grep -v -E "::|Package|uid" | head -12`);
    res.notificationsEnabled = sh(`cmd notification allowed_listeners >/dev/null; dumpsys notification | grep -c "${PKG}"`);
    const t1 = sendDay(1), t2 = sendDay(t1.days + 3);   // the next sending weekday at 10:30 UTC (12:30 or 13:30 Israel), then one at least 3 days later
    await force(res, "run1", t1.clock);
    res.notesAfterRun1 = notes() || "none";
    // a restart of the phone: WorkManager must schedule the check again on its own
    sh("cmd notification cancel_all 2>/dev/null; true");
    adb(["reboot"]); await sleep(15000); adb(["wait-for-device"], 300000);
    for (let i = 0; i < 60 && sh("getprop sys.boot_completed") !== "1"; i++) await sleep(3000);
    await sleep(20000);
    try { adb(["root"]); await sleep(4000); adb(["wait-for-device"]); } catch {}
    res.jobsAfterReboot = jobs() || "none";
    const before = lastRun();
    await force(res, "run2", t2.clock);   // after the restart the check must run again on its own schedule (last_run moves)
    // one more forced run, 30 s later and with the job looked up again: on Android 12 (10.11.2026, one night in several) the forced run
    // right after a cold boot did not reach the app while the job was there; a check that is really gone fails both tries
    if (lastRun() === before) { await sleep(30000); res.jobsAfterReboot2 = jobs() || "none"; await force(res, "run2b", t2.clock); res.run2Retried = true; }
    res.ranAfterReboot = lastRun() !== before && lastRun() !== "";
    res.notesAfterRun2 = notes() || "none";
    res.prefsFile = sh(`run-as ${PKG} sh -c 'cat shared_prefs/saved_alerts.xml' 2>&1 | grep -v '"saved"' | head -30`);
    res.verdict = !/ביטוח/.test(res.notesAfterRun1) ? "NO_ALERT" : !res.ranAfterReboot ? "NO_RUN_AFTER_REBOOT" : "ALERT_SHOWN";
  } catch (e) { res.verdict = "ERROR"; res.error = String(e && e.stack || e).slice(0, 600); }
  fs.writeFileSync(OUT, JSON.stringify(res, null, 1)); console.log(JSON.stringify(res, null, 1));
  if (device) await device.close().catch(() => {});
  process.exit(res.verdict === "ALERT_SHOWN" ? 0 : 1);
})();
