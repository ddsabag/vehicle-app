// Fetches this month's regulated 95-octane price and writes fuel.json for the app.
// Official source: the Ministry of Energy's monthly PDF on gov.il. Fallback: Delek's public price list.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

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
      if (!r.ok) continue;
      writeFileSync("/tmp/fuel.pdf", Buffer.from(await r.arrayBuffer()));
      const text = execFileSync("pdftotext", ["-raw", "/tmp/fuel.pdf", "-"]).toString();
      const hit = text.match(/לא\s*יעלה\s*על\s*([\d.]+)\s*ש"?ח/) || text.match(/([\d.]+)\s*ש"?ח\s*לליטר/);
      const p = hit && parseFloat(hit[1]);
      if (p > 4 && p < 15) return {petrol95: p, source: url};
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

const gov = await fromGov(), delek = await fromDelek();
const res = gov || delek;
if (!res) { console.log("no price found, keeping the current file"); process.exit(0); }
if (gov && delek && delek.diesel) res.diesel = delek.diesel;
const out = {month, petrol95: res.petrol95, ...(res.diesel ? {diesel: res.diesel} : {}), source: res.source, checked: now.toISOString().slice(0, 10)};
const prev = existsSync("fuel.json") ? JSON.parse(readFileSync("fuel.json", "utf8")) : {};
if (prev.petrol95 === out.petrol95 && prev.diesel === out.diesel && prev.month === out.month) { console.log("unchanged", out); process.exit(0); }
writeFileSync("fuel.json", JSON.stringify(out, null, 1) + "\n");
console.log("updated", out);
