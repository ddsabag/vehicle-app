// Fetches this month's regulated 95-octane price and writes fuel.json for the app.
// Official source: the Ministry of Energy's monthly PDF on gov.il. Fallback: Delek's public price list.
// The regulated price changes on the 1st. fuel.json keeps the last price read from gov.il under "official" (the app reads only
// month/petrol95/diesel). Without the official source: a month whose official price is known keeps it; otherwise the fallback is
// used only near the last official price (on 2026-10-05 Delek's list moved 95 from the regulated 8.27 to 7.77), else the file stays.
// Every run that misses the official source leaves a silent line on the live dashboard (flash, needs GITHUB_TOKEN).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { flash } from "./flash.mjs";

const FULL = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
const now = new Date(), y = now.getUTCFullYear(), m = now.getUTCMonth();
const month = `${y}-${String(m + 1).padStart(2, "0")}`;
const UA = {"user-agent": "Mozilla/5.0 (CheckCar fuel price updater; github.com/ddsabag/vehicle-app)"};

async function fromGov(){
  const names = [...new Set([FULL[m], SHORT[m]])].flatMap(n => [`fuel-${n}-${y}`, `fuel_${n}_${y}`]);
  for (const n of names) {
    const url = `https://www.gov.il/BlobFolder/news/${n}/he/${n}.pdf`;
    try {
      const r = await fetch(url, {headers: UA});
      if (!r.ok) { console.log("gov", url, "HTTP", r.status); continue; }
      writeFileSync("/tmp/fuel.pdf", Buffer.from(await r.arrayBuffer()));
      const text = execFileSync("pdftotext", ["-raw", "/tmp/fuel.pdf", "-"]).toString();
      const hit = text.match(/לא\s*יעלה\s*על\s*([\d.]+)\s*ש"?ח/) || text.match(/([\d.]+)\s*ש"?ח\s*לליטר/);
      const p = hit && parseFloat(hit[1]);
      if (p > 4 && p < 15) return {petrol95: p, source: url};
      console.log("gov", url, "no price found in the PDF");
    } catch (e) { console.log("gov", url, e.message); }
  }
  return null;
}
async function fromDelek(){
  try {
    const url = "https://delek.co.il/" + encodeURIComponent("מחירון") + "/";
    const r = await fetch(url, {headers: UA}); if (!r.ok) return null;
    const t = (await r.text()).replace(/<[^>]+>/g, " ").replace(/&#8362;|&#x20aa;/gi, "₪").replace(/\s+/g, " ");
    const b = t.match(/בנזין\s*95[^₪\d]{0,40}₪?\s*([\d.]+)/), d = t.match(/סולר[^₪\d]{0,40}₪?\s*([\d.]+)/);
    const full = b && parseFloat(b[1]);
    if (!(full > 4 && full < 15)) return null;
    // Delek lists full-service prices; self-service is 26 agorot less
    const out = {petrol95: Math.round((full - 0.26) * 100) / 100, source: url};
    const dz = d && parseFloat(d[1]); if (dz > 4 && dz < 20) out.diesel = dz;
    return out;
  } catch (e) { console.log("delek", e.message); return null; }
}

// before fuel.json had "official": the October 2026 PDF price, read by hand on 2026-10-02 (b74c72ff, matched by Delek on 10-03)
const OCT26 = {month: "2026-10", petrol95: 8.27, source: "https://www.gov.il/BlobFolder/news/fuel-october-2026/he/fuel-october-2026.pdf"};
const STEP = 0.4;     // ₪ per litre per month since the last official price: the fallback's misread of 2026-10-05 was 0.50 (a bigger real change waits for gov.il or a hand edit, with a note)
const MAX_JUMP = 1;   // ₪ per litre, however old the official price: no monthly change of the regulated price came close
const gov = await fromGov(), delek = await fromDelek();
const prev = existsSync("fuel.json") ? JSON.parse(readFileSync("fuel.json", "utf8")) : {};
const official = gov ? {month, petrol95: gov.petrol95, source: gov.source}
  : prev.official || (/gov\.il/.test(prev.source || "") && prev.petrol95 > 0 ? {month: prev.month, petrol95: prev.petrol95, source: prev.source} : OCT26);
const note = async text => { console.log(text); await flash("data", "info", "מחיר הדלק: " + text); };
const res = gov || delek;
if (!res) { await note(`המקור הרשמי (gov.il) והמחירון של חברת דלק לא נקראו, נשאר המחיר ${prev.petrol95 || "הקודם"} ₪`); process.exit(0); }
if (gov && delek && delek.diesel) res.diesel = delek.diesel;
if (!gov) {
  const fb = res.petrol95, gap = Math.round(Math.abs(fb - official.petrol95) * 100) / 100;
  if (official.month === month) {
    // this month's official price is known and does not change before the 1st (diesel is not regulated and follows Delek)
    res.petrol95 = official.petrol95; res.source = official.source;
    await note(gap ? `המקור הרשמי (gov.il) לא נקרא. במחירון של חברת דלק בנזין 95 עולה ${fb} ₪, ונשאר המחיר הרשמי לחודש הזה: ${official.petrol95} ₪` : `המקור הרשמי (gov.il) לא נקרא, המחיר הרשמי ${official.petrol95} ₪ נשאר (זהה למחירון של חברת דלק)`);
  } else {
    const [oy, om] = official.month.split("-").map(Number), age = Math.max(1, (y - oy) * 12 + m + 1 - om), tol = Math.min(STEP * age, MAX_JUMP);
    if (gap > tol) {
      await note(`המקור הרשמי (gov.il) לא נקרא, ובמחירון של חברת דלק בנזין 95 עולה ${fb} ₪, הפרש של ${gap} ₪ מהמחיר הרשמי האחרון (${official.petrol95} ₪ לחודש ${official.month}). הקובץ לא עודכן (${prev.petrol95 || "-"} ₪ לחודש ${prev.month || "-"}), כדאי לבדוק ידנית`);
      process.exit(0);
    }
    await note(`המקור הרשמי (gov.il) לא נקרא. בנזין 95 לחודש ${month} נלקח מהמחירון של חברת דלק: ${fb} ₪ (המחיר הרשמי האחרון ${official.petrol95} ₪ לחודש ${official.month}). כדאי לוודא מול ההודעה הרשמית`);
  }
}
const out = {month, petrol95: res.petrol95, ...(res.diesel ? {diesel: res.diesel} : {}), source: res.source, official, checked: now.toISOString().slice(0, 10)};
const same = (a, b) => !!a && !!b && a.month === b.month && a.petrol95 === b.petrol95;
if (prev.petrol95 === out.petrol95 && prev.diesel === out.diesel && prev.month === out.month && same(prev.official, official)) { console.log("unchanged", out); process.exit(0); }
writeFileSync("fuel.json", JSON.stringify(out, null, 1) + "\n");
console.log("updated", out);
