// Fetches the 95-octane price drivers pay this month and writes fuel.json for the app (the app reads month/petrol95/diesel).
// Source: Delek's public price list (full service minus the 26-agorot self-service discount), which follows every change of the
// regulated price, including mid-month ones (on 2026-10-05 an excise cut took the October price from 8.27 to 7.77, while the
// Ministry of Energy's October PDF still says 8.27). Fallback: that monthly PDF on gov.il, only when Delek cannot be read.
// A reading more than 1 ₪ away from the published price is taken for a misread: the file stays and the run leaves a note. When the
// file still has no price for this month on the 3rd, the run fails so Failure alert pages once instead of a month going by unnoticed.
// Notes go to the live dashboard as silent lines (flash, needs GITHUB_TOKEN).
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

const MAX_JUMP = 1;   // ₪ per litre from the published price: the biggest real move so far was 0.52 (2026-10-01)
const delek = await fromDelek(), gov = delek ? null : await fromGov();
const prev = existsSync("fuel.json") ? JSON.parse(readFileSync("fuel.json", "utf8")) : {};
const note = async text => { console.log(text); await flash("data", "info", "מחיר הדלק: " + text); };
const giveUp = async text => {
  await note(text);
  if (prev.month !== month && now.getUTCDate() >= 3) { console.log(`::error::fuel.json still has no price for ${month}: check the price and update fuel.json by hand`); process.exit(1); }
  process.exit(0);
};
const res = delek || gov;
if (!res) await giveUp(`המחירון של חברת דלק וההודעה של משרד האנרגיה (gov.il) לא נקראו, נשאר המחיר ${prev.petrol95 || "הקודם"} ₪`);
if (!res.diesel && prev.diesel) res.diesel = prev.diesel;   // the PDF has no diesel price (not regulated): keep the last one
const gap = prev.petrol95 > 0 ? Math.round(Math.abs(res.petrol95 - prev.petrol95) * 100) / 100 : 0;
if (gap > MAX_JUMP) await giveUp(`נקרא מחיר של ${res.petrol95} ₪ לבנזין 95 (${delek ? "מחירון חברת דלק" : "gov.il"}), הפרש של ${gap} ₪ מהמחיר בקובץ (${prev.petrol95} ₪ לחודש ${prev.month || "-"}). הקובץ לא עודכן, כדאי לבדוק ידנית`);
if (gap) await note(`בנזין 95 עודכן מ-${prev.petrol95} ל-${res.petrol95} ₪ (${delek ? "מחירון חברת דלק" : "gov.il"})`);
const out = {month, petrol95: res.petrol95, ...(res.diesel ? {diesel: res.diesel} : {}), source: res.source, checked: now.toISOString().slice(0, 10)};
if (prev.petrol95 === out.petrol95 && prev.diesel === out.diesel && prev.month === out.month) { console.log("unchanged", out); process.exit(0); }
writeFileSync("fuel.json", JSON.stringify(out, null, 1) + "\n");
console.log("updated", out);
