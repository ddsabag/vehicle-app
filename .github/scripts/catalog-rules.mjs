// The catalogue watchdog: after every catalogue build it looks at what is NEW in the register (models, years, trims) and runs the
// picker's own rules on it (12-character cuts completed by TRIM_FIX in index.html, typo twins one slip apart, same-importer names
// with an identical registered spec and price, official importer by cars on the road). What the rules handle is listed for the record;
// what they cannot (a cut word that TRIM_FIX does not know, a name that looks like a code) is flagged, and a Telegram line is written
// so the rule table can be extended. State (what was already seen) lives next to the catalogue on the catalog-data branch.
//   OUT   catalogue directory written by catalog-build.mjs (default out)
//   PREV  previous rules-state.json (default: fetched from the catalog-data branch; missing = first run, no alert)
import fs from "node:fs";
import { msg as tgMsg } from "./tg-text.mjs";
const OUT = process.env.OUT || "out", PREV = process.env.PREV || "";
const RAW = "https://raw.githubusercontent.com/ddsabag/vehicle-app/catalog-data/rules-state.json";
const page = fs.readFileSync("index.html", "utf8");
const fixSrc = page.match(/const TRIM_FIX = (\{[\s\S]*?\});/); if (!fixSrc) throw new Error("TRIM_FIX not found in index.html");
const TRIM_FIX = new Function("return " + fixSrc[1])();
const norm = t => String(t || "").toUpperCase().replace(/[^A-Z0-9א-ת]/g, "");
function lev(a, b, max){   // edit distance with a swap of two neighbouring letters counting as one slip; stops early above max
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let p2 = null, p1 = Array.from({length: b.length + 1}, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]; let lo = i;
    for (let j = 1; j <= b.length; j++) {
      let v = Math.min(p1[j] + 1, cur[j - 1] + 1, p1[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (p2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, p2[j - 2] + 1);
      cur[j] = v; if (v < lo) lo = v;
    }
    if (lo > max) return max + 1;
    p2 = p1; p1 = cur;
  }
  return p1[b.length];
}
const SPEC = ["nefah_manoa", "koah_sus", "technologiat_hanaa_nm", "delek_nm", "automatic_ind", "hanaa_nm", "merkav", "mispar_dlatot", "mispar_moshavim", "mishkal_kolel", "mispar_kariot_avir", "ramat_eivzur_betihuty", "mehir", "kosher_grira_im_blamim", "kosher_grira_bli_blamim", "CO2_WLTP", "kamut_CO2", "kvutzat_zihum", "kvuzat_agra_cd", "mazgan_ind", "halon_bagg_ind", "galgaley_sagsoget_kala_ind", "hege_koah_ind", "mispar_halonot_hashmal", "abs_ind", "bakarat_yatzivut_ind", "maarechet_ezer_labalam_ind", "bakarat_stiya_menativ_ind", "bakarat_stiya_activ_s", "nitur_merhak_milfanim_ind", "zihuy_beshetah_nistar_ind", "bakarat_shyut_adaptivit_ind", "zihuy_holchey_regel_ind", "blimat_hirum_lifnei_holhei_regel_ofanaim", "zihuy_rechev_do_galgali", "matzlemat_reverse_ind", "blima_otomatit_nesia_leahor", "hayshaney_lahatz_avir_batzmigim_ind", "hayshaney_hagorot_ind", "shlita_automatit_beorot_gvohim_ind", "teura_automatit_benesiya_kadima_ind", "zihuy_tamrurey_tnua_ind", "zihuy_matzav_hitkarvut_mesukenet_ind", "bakarat_mehirut_isa", "hitnagshut_cad_shetah_met"];
const impName = x => String(x || "").replace(/\s*בע['"׳״]{0,2}מ\.?\s*$|\s*בעמ\s*$/, "").replace(/\s+/g, " ").trim();

// previous state
let prev = null;
if (PREV && fs.existsSync(PREV)) prev = JSON.parse(fs.readFileSync(PREV, "utf8"));
else if (!PREV) { try { const r = await fetch(RAW, {signal: AbortSignal.timeout(30000)}); if (r.ok) prev = await r.json(); } catch {} }
const seen = new Set(prev ? prev.seen : []);
const first = !prev;

const meta = JSON.parse(fs.readFileSync(`${OUT}/meta.json`, "utf8"));
const state = {u: meta.u, seen: []}, found = {newModels: [], newVariants: 0, cutsKnown: [], cutsUnknown: [], typoTwins: [], specTwins: [], codeYears: [], parallelOnly: []};
for (const cd of Object.keys(meta.makers)) {
  const idx = JSON.parse(fs.readFileSync(`${OUT}/c/${cd}.json`, "utf8")), cols = idx.cols, mk = idx.n;
  for (const [model, [f]] of Object.entries(idx.models)) {
    const rows = JSON.parse(fs.readFileSync(`${OUT}/c/${cd}/${f}.json`, "utf8")).rows.map(a => Object.fromEntries(cols.map((c, i) => [c, a[i]])));
    const mkey = `${cd}|${model}`; state.seen.push(mkey);
    const modelNew = !seen.has(mkey); if (modelNew && !first) found.newModels.push(`${mk} ${model}`);
    const byYear = new Map();
    for (const r of rows) { const y = String(r.shnat_yitzur); if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(r); }
    for (const [y, rs] of byYear) {
      const trims = new Map();   // trim -> {rows, importers}
      for (const r of rs) { const t = String(r.ramat_gimur || "").trim().toUpperCase().replace(/\s+/g, " "); if (!trims.has(t)) trims.set(t, []); trims.get(t).push(r); }
      const fresh = [];
      for (const [t, list] of trims) { const k = `${mkey}|${y}|${t}`; state.seen.push(k); if (!seen.has(k)) fresh.push(t); }
      if (!fresh.length || first) continue;
      found.newVariants += fresh.length;
      const label = `${mk} ${model} ${y}`;
      // 1. 12-character cuts: known completion or not
      for (const t of fresh) if (t.length === 12) { const w = t.split(" "), last = w[w.length - 1]; if (TRIM_FIX[last]) found.cutsKnown.push(`${label}: ${t} → ${TRIM_FIX[last]}`); else if (/^[A-Z]{3,}$/.test(last)) found.cutsUnknown.push(`${label}: "${t}" (המילה האחרונה "${last}")`); }
      // 2. a new name one slip away from an existing one of the same year
      for (const t of fresh) for (const o of trims.keys()) if (o !== t && !fresh.includes(o) && norm(t).length >= 5 && lev(norm(t), norm(o), 1) <= 1) found.typoTwins.push(`${label}: ${t} ~ ${o}`);
      // 3. same importer, identical spec and price, different name (the app shows them as one row)
      for (const t of fresh) for (const r of trims.get(t)) { const sk = SPEC.map(k => String(r[k] ?? "")).join("|"), imp = impName(r.shem_yevuan); for (const [o, ol] of trims) if (o !== t && ol.some(x => impName(x.shem_yevuan) === imp && SPEC.map(k => String(x[k] ?? "")).join("|") === sk)) { found.specTwins.push(`${label} (${imp}): ${t || "ריק"} = ${o || "ריק"}`); break; } }
      // 4. a year whose names look like codes (the app lists it by engine)
      const codey = [...trims.keys()].filter(t => /\d/.test(norm(t)) && norm(t).length >= 6).length; if (trims.size > 12 && codey > trims.size / 2) found.codeYears.push(`${label}: ${trims.size} גרסאות, ${codey} נראות כקוד`);
      // 5. official importer: none with 20+ cars and half the fleet (every version is parallel import or too new to count)
      // a code's count of cars sits on each of its rows (catalog-build.mjs): counted once per code, as the picker does
      const onRoad = new Map(), counted = new Set();
      for (const r of rs) { const n = impName(r.shem_yevuan), c = Number(r.mispar_rechavim_pailim) || 0; if (!n) continue; onRoad.set(n, onRoad.get(n) || 0); if (c > 0 && !counted.has(String(r.degem_cd))) { counted.add(String(r.degem_cd)); onRoad.set(n, onRoad.get(n) + c); } }
      const tot = [...onRoad.values()].reduce((a, b) => a + b, 0), top = [...onRoad.entries()].sort((a, b) => b[1] - a[1])[0];
      if (onRoad.size > 1 && !(top && top[1] >= 20 && top[1] >= tot / 2) && Number(y) >= new Date().getFullYear() - 1) found.parallelOnly.push(`${label}: ${onRoad.size} יבואנים, הגדול ${top ? top[0] + " " + top[1] : "-"} רכבים`);
    }
  }
}
fs.writeFileSync(`${OUT}/rules-state.json`, JSON.stringify(state));
const uniq = a => [...new Set(a)];
for (const k of Object.keys(found)) if (Array.isArray(found[k])) found[k] = uniq(found[k]);
const lines = [`# דוח כללי הקטלוג ${meta.u}`, first ? "ריצה ראשונה: המצב נשמר, אין השוואה." : `דגמים חדשים: ${found.newModels.length} · גרסאות חדשות (דגם+שנה+גימור): ${found.newVariants}`];
const sec = (t, a, max = 40) => { if (a.length) lines.push("", `## ${t} (${a.length})`, ...a.slice(0, max).map(x => "- " + x), ...(a.length > max ? [`- … ועוד ${a.length - max}`] : [])); };
sec("דגמים חדשים", found.newModels);
sec("קיצוצים ל-12 תווים שהטבלה לא מכירה (להוסיף ל-TRIM_FIX)", found.cutsUnknown);
sec("קיצוצים שהושלמו אוטומטית", found.cutsKnown);
sec("שמות שנראים כשגיאת כתיב של שם קיים (מאוחדים אוטומטית)", found.typoTwins);
sec("שמות שונים עם מפרט ומחיר זהים אצל אותו יבואן (שורה אחת עם שני השמות)", found.specTwins);
sec("שנים שמוצגות לפי מנוע כי השמות הם קודים", found.codeYears);
sec("שנים חדשות בלי יבואן רשמי מזוהה (הכול יבוא מקביל או מעט מדי רכבים)", found.parallelOnly);
fs.writeFileSync(`${OUT}/rules-report.md`, lines.join("\n") + "\n");
console.log(lines.join("\n"));
// a Telegram line only for what needs a human: unknown cuts (rule table) and new model names to eyeball
if (!first && (found.cutsUnknown.length || found.newModels.length)) {
  // the Telegram standard (tg-text.mjs, HTML): the counts in words, the English model names folded
  const n = found.newModels.length, c = found.cutsUnknown.length, known = found.cutsKnown.length + found.typoTwins.length + found.specTwins.length;
  const msg = tgMsg({ kind: c ? "today" : "info", area: "data", title: c ? `נמצאו ${c} שמות דגם קצוצים שהכללים לא מכירים` : `נמצאו ${n} דגמים חדשים במאגר`,
    text: [n && c ? `בנוסף נמצאו ${n} דגמים חדשים במאגר.` : "", c ? "הבוחר יציג אותם בשם קצוץ עד שיתווסף להם כלל." : "הבוחר כבר מציג אותם.", `הכללים הקיימים טיפלו ב-${known} מקרים נוספים (${meta.u}).`].filter(Boolean).join(" "),
    what: c ? "כלום. זה עובר לבד לטיפול בשרשור \"נתונים ואמינות\", ועדכון יגיע כשזה מטופל." : "",
    raw: [n ? `new models: ${found.newModels.slice(0, 8).join(", ")}${n > 8 ? "…" : ""}` : "", c ? `unknown cuts: ${found.cutsUnknown.slice(0, 6).join(" | ")}` : ""].filter(Boolean).join("; ") }) + "\n🔗 https://github.com/ddsabag/vehicle-app/blob/catalog-data/rules-report.md";
  fs.writeFileSync(`${OUT}/rules-alert.txt`, msg);
}
