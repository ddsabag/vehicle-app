// Builds static model pages (model/<slug>/index.html), model/index.html and sitemap.xml from modelstats.json + models.json.
// Only data already in the repo is used; run: node .github/scripts/pages.mjs [count]
import fs from "node:fs";
import {brandLabel, BRAND_ALT} from "./brands.mjs";
const N = Number(process.argv[2]) || 200, SITE = "https://luchit.app/";
const ms = JSON.parse(fs.readFileSync("modelstats.json", "utf8")), cat = JSON.parse(fs.readFileSync("models.json", "utf8"));
const COUNTRY = /\s+(יפן|בריטניה|אנגליה|צרפת|גרמניה|קוריאה|ד\. קוריאה|ספרד|צ'כיה|צכיה|טורקיה|סין|ארה"ב|ארהב|איטליה|תאילנד|הודו|מקסיקו|הונגריה|סלובקיה|פולין|רומניה|בלגיה|שבדיה|אוסטריה|פורטוגל|דרום אפריקה|ברזיל|קנדה|הולנד|סלובניה|רוסיה|מרוקו|אינדונזיה|מלזיה|טייוואן|ישראל|אפרי)\.?$/;
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const fmt = n => Math.round(n).toLocaleString("he-IL");
// maker names in the data are cut at 14 letters and carry the production country; keep the first word(s) before any country fragment
const CFRAG = /^(גרמנ|ד\.|קוריא|תאילנ|פורטוג|מקסי|ספרד|ארה|סלוב|צ'כ|צכ|טורק|יפן|סין|הודו|אנגל|בריט|צרפת|איטל|הונג|פולי|רומנ|בלג|שבד|אוסטר|ברזיל|קנדה|הולנד|רוסי|מרוק|אינדונ|מלזי|טייוו|ישראל|אפרי|דרום)/;
const cleanMake = n => { const t = n.replace(/-/g, " ").split(/\s+/); return [t[0], ...t.slice(1).filter(x => !CFRAG.test(x))].join(" "); };
// body-style and drive words split one model into several entries (COROLLA, COROLLA HSD SDN); merge them
const NOISE = new Set(["HSD", "HEV", "HYBRID", "SDN", "SEDAN", "TS", "FL", "HB", "HATCHBACK", "SW"]);
const normModel = m => { const t = m.replace(/^\.+/, "").replace(/\s+-\s+/g, "-").toUpperCase().replace(/\s+/g, " ").split(" ").filter(x => !NOISE.has(x)); return (t.length ? t : [m]).join(" ").replace(/([A-Z]) (\d)/g, "$1$2").replace(/([A-Z])-(\d)/g, "$1$2"); };
const hebKey = m => m.replace(/\s+/g, "");
const HEB = {"COROLLA": "קורולה", "PICANTO": "פיקנטו", "MAZDA 3": "מאזדה 3", "MAZDA 2": "מאזדה 2", "MAZDA 6": "מאזדה 6", "SPORTAGE": "ספורטאז׳", "OCTAVIA": "אוקטביה", "OUTLANDER": "אאוטלנדר", "TUCSON": "טוסון", "IBIZA": "איביזה", "FOCUS": "פוקוס", "QASHQAI": "קשקאי", "CIVIC": "סיוויק", "YARIS": "יאריס", "ATTO 3": "אטו 3", "SWIFT": "סוויפט", "MICRA": "מיקרה", "BERLINGO": "ברלינגו", "STONIC": "סטוניק", "GOLF": "גולף", "ARONA": "ארונה", "FABIA": "פביה", "NIRO": "נירו", "FORESTER": "פורסטר", "RIO": "ריו", "HILUX": "היילקס", "VITARA": "ויטרה", "KODIAQ": "קודיאק", "ACCENT": "אקסנט", "FORTE": "פורטה", "SELTOS": "סלטוס", "MEGANE": "מגאן", "MODEL 3": "מודל 3", "MODEL Y": "מודל Y", "CEED": "סיד", "JUKE": "ג׳וק", "X-TRAIL": "אקס-טרייל", "CLIO": "קליאו", "POLO": "פולו", "LANCER": "לנסר", "JAZZ": "ג׳אז", "ELANTRA": "אלנטרה", "SANTA FE": "סנטה פה", "KONA": "קונה", "LEON": "לאון", "ATECA": "אטקה", "SUPERB": "סופרב", "KAROQ": "קארוק", "KAMIQ": "קאמיק", "SORENTO": "סורנטו", "CORSA": "קורסה", "DUSTER": "דאסטר", "SENTRA": "סנטרה", "LAND CRUISER": "לנד קרוזר", "SPACE STAR": "ספייס סטאר", "ATTRAGE": "אטראז׳", "IONIQ": "איוניק", "SPARK": "ספארק", "TRAX": "טראקס", "PRIUS": "פריוס", "IGNIS": "איגניס", "GETZ": "גטס", "SONATA": "סונטה", "ECLIPSE CROSS": "אקליפס קרוס", "S-CROSS": "אס-קרוס", "COROLLA CROSS": "קורולה קרוס", "YARIS CROSS": "יאריס קרוס"};
const HEBN = Object.fromEntries(Object.entries(HEB).map(([k, v]) => [hebKey(normModel(k)), v]));
// class-action settlements live in index.html (SETTLEMENTS); pages list the ones that may apply to the model
const num = x => { const n = parseFloat(x); return isNaN(n) ? 0 : n; };
const normS = t => String(t || "").toUpperCase().replace(/[^A-Z0-9א-ת]/g, "");
const SETTLEMENTS = new Function("num", fs.readFileSync("index.html", "utf8").match(/const SETTLEMENTS = \[[\s\S]*?\n\];/)[0] + "\nreturn SETTLEMENTS;")(num);
const VARIANTS = [{}, {tzeva_rechev: "לבן"}, {sug_delek_nm: "בנזין", nefach_manoa: 1500}, {sug_delek_nm: "דיזל", nefach_manoa: 2000}, {sug_delek_nm: "היברידי", ramat_gimur: "HYBRID", nefach_manoa: 1500}, {sug_delek_nm: "חשמל"}];
const stlFor = (make, model, years) => {
  const x = {mk: normS(make), md: normS(model)}, now = new Date();
  return SETTLEMENTS.filter(s => !(new Date(s.until + "T23:59:59") < now) && s.mk.test(x.mk) && (s.md ? s.md.test(x.md) : s.y) && years.some(y => (!s.y || y >= s.y[0] && y <= s.y[1]) && (!s.ok || VARIANTS.some(v => { try { return s.ok(v, y, x); } catch { return false; } }))));
};
const g = new Map();
for (const [key, v] of Object.entries(ms.m)) {
  const [cd, raw] = key.split("|"), model = normModel(raw);
  const make = cleanMake(v.name.replace(COUNTRY, "").replace(COUNTRY, "").trim());
  const k = make + "|" + model, e = g.get(k) || {make, model, cd, big: 0, total: 0, y: {}};
  if (v.total > e.big) { e.big = v.total; e.cd = cd; e.disp = raw.toUpperCase().replace(/\s+/g, " ").split(" ").filter(x => !NOISE.has(x)).join(" ") || raw; }
  e.total += v.total;
  for (const [yr, a] of Object.entries(v.y)) {
    const t = e.y[yr] || (e.y[yr] = {act: 0, off: 0, kmw: 0, kmn: 0, ow: 0, own: 0, rc: 0});
    t.act += a[0]; t.off += a[1];
    if (a[2]) { t.kmw += a[2] * a[0]; t.kmn += a[0]; }
    if (a[3]) { t.ow += a[3] * a[0]; t.own += a[0]; }
    if (a[4]) t.rc += a[4] * a[0] / 1000;
  }
  g.set(k, e);
}
const models = [...g.values()].sort((a, b) => b.total - a.total).slice(0, N);
for (const m of models) m.label = brandLabel(m.make);   // display name; m.make stays the registry spelling for matching
// national yardsticks per vintage from every model (not only the pages built): off-road share, typical km, ownership records
const NAT = {};
for (const e of g.values()) for (const [yr, t] of Object.entries(e.y)) {
  const n = NAT[yr] || (NAT[yr] = {act: 0, off: 0, kmw: 0, kmn: 0, ow: 0, own: 0});
  n.act += t.act; n.off += t.off; n.kmw += t.kmw; n.kmn += t.kmn; n.ow += t.ow; n.own += t.own;
}
// new-car deliveries by model (market.json); matched by first word of the maker + normalised model
const MK = JSON.parse(fs.readFileSync("market.json", "utf8"));
const mkKeys = Object.keys(MK.months).sort(), lastKey = mkKeys[mkKeys.length - 1];
const ymAdd = (k, d) => { let y = Number(k.slice(0, 4)), m = Number(k.slice(4)) + d; y += Math.floor((m - 1) / 12); m = ((m - 1) % 12 + 12) % 12 + 1; return String(y) + String(m).padStart(2, "0"); };
const sumRange = (obj, from, to) => Object.entries(obj).filter(([k]) => k >= from && k <= to).reduce((a, [, v]) => a + v, 0);
const deliv = new Map();
for (const [k, v] of Object.entries(MK.models)) {
  const [mk, md] = k.split("|"), key = mk.split(" ")[0] + "|" + normModel(md || ""), t = deliv.get(key) || {};
  for (const [ym, n] of Object.entries(v)) t[ym] = (t[ym] || 0) + n;   // body-style and drive variants fold into one model
  deliv.set(key, t);
}
const MKLAST = lastKey || "";
// "x% fewer / more than the average for the same vintages"
const relText = (r, unit) => { if (r === null) return ""; const d = Math.round((r - 1) * 100); return Math.abs(d) < 5 ? `בקירוב כמו הממוצע ${unit}` : `${Math.abs(d)}% ${d < 0 ? "פחות" : "יותר"} מהממוצע ${unit}`; };
const weighted = (rows, f, nat) => { let a = 0, b = 0; for (const r of rows) { const v = f(r), n = nat(NAT[r.yr]); if (v && n) { a += r.act * v; b += r.act * n; } } return b ? a / b : null; };
const slugOf = m => (m.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model") + "-" + m.cd;
const css = `@font-face{font-family:"Assistant";font-style:normal;font-weight:400;font-display:optional;src:url(https://luchit.app/lib/fonts/assistant-hebrew-400-normal.woff2) format("woff2");unicode-range:U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}@font-face{font-family:"Assistant";font-style:normal;font-weight:400;font-display:optional;src:url(https://luchit.app/lib/fonts/assistant-latin-400-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}@font-face{font-family:"Assistant";font-style:normal;font-weight:700;font-display:optional;src:url(https://luchit.app/lib/fonts/assistant-hebrew-700-normal.woff2) format("woff2");unicode-range:U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F}@font-face{font-family:"Assistant";font-style:normal;font-weight:700;font-display:optional;src:url(https://luchit.app/lib/fonts/assistant-latin-700-normal.woff2) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}:root{--bg:#f4f6fa;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#dfe4ec;--accent:#2a56c6;--plate:#f5c400}@media(prefers-color-scheme:dark){:root{--bg:#0e121a;--card:#171d28;--fg:#e9edf3;--muted:#98a2b4;--line:#262e3c;--accent:#7c9cf0}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 "Assistant",system-ui,"Segoe UI",Arial,sans-serif;direction:rtl}main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.45rem;margin:0 0 6px;line-height:1.3}h1::after{content:"";display:block;width:40px;height:4px;border-radius:2px;background:var(--plate);margin-top:8px}h2{font-size:1.05rem;margin:26px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}.muted{color:var(--muted);font-size:.9rem}
.cta{display:inline-block;background:var(--accent);color:#fff;border-radius:10px;padding:10px 18px;font-weight:700;text-decoration:none}a{color:var(--accent)}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{padding:7px 6px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:left;font-variant-numeric:tabular-nums}
ul.g{padding-inline-start:20px;margin:8px 0}ul.g li{margin:6px 0}header.top{background:linear-gradient(180deg,#e2ecfd,#fff);border-bottom:1px solid var(--line)}header.top .in{max-width:720px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}header.top .brand{display:flex;align-items:center;gap:10px;color:#151a24;text-decoration:none}header.top img{border-radius:22%}header.top .nm{display:flex;flex-direction:column;line-height:1.15}header.top b{font-size:1.45rem;font-weight:800}header.top small{font-size:.78rem;font-weight:600;color:#5d6676}header.top .chk{background:#2556c8;color:#fff;border-radius:10px;padding:9px 14px;font-weight:700;font-size:.9rem;text-decoration:none;white-space:nowrap}@media(prefers-color-scheme:dark){header.top{background:linear-gradient(180deg,#182338,#121722)}header.top .brand{color:#fff}header.top small{color:#8d98ad}}
p.gp{margin:0;padding:6px 16px;text-align:center;font-size:.82rem;background:var(--card);border-bottom:1px solid var(--line)}p.gp a{color:var(--muted);text-decoration:none}p.gp a:hover{text-decoration:underline}ul.l{columns:2;list-style:none;padding:0}ul.l li{break-inside:avoid;padding:3px 0}.top{font-weight:800;text-decoration:none;color:var(--fg)}`;
const PLAY = "https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev&referrer=" + encodeURIComponent("utm_source=luchit.app&utm_medium=web&utm_campaign=model_page");   // tagged so Play Console shows web-to-store visits
const head = (title, desc, url, type = "website") => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}"><meta property="og:type" content="${type}"><meta property="og:site_name" content="לוחית"><meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${SITE}og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="לוחית, בדיקת רכב לפי מספר"><meta property="og:locale" content="he_IL"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${SITE}og.png"><meta name="theme-color" media="(prefers-color-scheme: light)" content="#ffffff"><meta name="theme-color" media="(prefers-color-scheme: dark)" content="#121722"><link rel="manifest" href="${SITE}manifest.json"><link rel="apple-touch-icon" href="${SITE}apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="לוחית"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="icon" href="${SITE}icon-512.png"><link rel="preload" href="${SITE}lib/fonts/assistant-hebrew-700-normal.woff2" as="font" type="font/woff2" crossorigin><style>${css}</style></head><body><header class="top"><div class="in"><a class="brand" href="${SITE}"><img src="${SITE}icon-512.png" alt="" width="44" height="44"><span class="nm"><b>לוחית</b><small>בדיקת רכב לפי מספר רישוי</small></span></a><a class="chk" href="${SITE}">לבדיקת רכב</a></div></header><p class="gp"><a href="${PLAY}" rel="noopener">באפליקציה: התראות על ריקול וטסט · <bdi>Google Play</bdi></a></p><main>`;
const foot = `<p class="muted" style="margin-top:28px">המידע מגיע ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, ואינו מחליף נסח רישום רשמי או בדיקה במכון מורשה. האפליקציה אינה קשורה למשרד התחבורה. <a href="${SITE}magazine/">מגזין</a> · <a href="${SITE}guide/buy-used-car/">מדריך לקונה</a> · <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;
fs.rmSync("model", {recursive: true, force: true}); fs.mkdirSync("model", {recursive: true});
const MOD = ms.updated ? String(ms.updated).slice(0, 10) : "", lastmod = {};
const urls = [SITE, SITE + "privacy.html", SITE + "business/", SITE + "model/"], slugMap = {};
if (MOD) lastmod[SITE + "model/"] = MOD;
const actOf = m => Object.values(m.y).reduce((t, r) => t + r.act, 0);
const bodyMemo = new Map();
const bodyOf = m => { if (!bodyMemo.has(m)) { const c = new Map(); for (const r of cat.rows) if (r[5] && normModel(r[1]) === m.model && r[0].split(" ")[0] === m.make.split(" ")[0]) c.set(r[5], (c.get(r[5]) || 0) + 1); bodyMemo.set(m, [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || ""); } return bodyMemo.get(m); };
let magPosts = []; try { magPosts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); } catch {}
for (const m of models) {
  const years = Object.keys(m.y).sort();
  const rows = years.map(yr => { const t = m.y[yr]; return {yr, act: t.act, off: t.off, km: t.kmn ? t.kmw / t.kmn : null, ow: t.own ? t.ow / t.own : null}; });
  const act = rows.reduce((s, r) => s + r.act, 0), off = rows.reduce((s, r) => s + r.off, 0);
  const cr = cat.rows.filter(r => normModel(r[1]) === m.model && r[0].split(" ")[0] === m.make.split(" ")[0]);
  const bodies = [...new Set(cr.map(r => r[5]).filter(Boolean))];
  const lo = rows[0].yr, hi = rows[rows.length - 1].yr, heb = HEBN[hebKey(m.model)], name = heb && heb.startsWith("מאזדה") ? `מזדה ${heb.slice(6)} (${m.disp})` : `${m.label} ${heb ? heb + " (" + m.disp + ")" : m.disp}`;
  const url = `${SITE}model/${slugOf(m)}/`, title0 = `${name}: כמה רכבים על הכביש, ק״מ ושנתונים | לוחית`, title = title0.length > 68 ? `${name}: רכבים וק״מ לפי שנתון | לוחית` : title0;
  const alt = BRAND_ALT[m.label] ? ` (${BRAND_ALT[m.label]})` : "";
  const desc = `${name}${alt} בישראל לפי נתוני משרד התחבורה: ${fmt(act)} רכבים פעילים בשנתונים ${lo}–${hi}, ק״מ טיפוסי לפי שנתון וכמה ירדו מהכביש. בדיקת רכב לפי מספר רישוי.`;
  const stl = stlFor(m.make, m.model, years.map(Number));
  const expOff = rows.reduce((s, r) => { const n = NAT[r.yr]; return s + (n && n.act + n.off ? (r.act + r.off) * n.off / (n.act + n.off) : 0); }, 0);
  const offRel = expOff >= 30 ? off / expOff : null, offPct = act + off ? off / (act + off) * 100 : 0;
  const kmRel = weighted(rows, r => r.km, n => n && n.kmn ? n.kmw / n.kmn : 0), owRel = weighted(rows, r => r.ow, n => n && n.own ? n.ow / n.own : 0);
  const rc = years.reduce((s, y) => s + m.y[y].rc, 0), rcPer = act ? rc / act * 1000 : 0;
  const dv = deliv.get(m.make.split(" ")[0] + "|" + m.model);
  let d12 = 0, p12 = 0; if (dv && lastKey) { d12 = sumRange(dv, ymAdd(lastKey, -11), lastKey); p12 = sumRange(dv, ymAdd(lastKey, -23), ymAdd(lastKey, -12)); }
  const prs = cr.filter(r => r[4] > 0 && r[3] >= Number(hi) - 1).map(r => r[4]);
  const kmRows = rows.filter(r => r.km), kmRef = kmRows.filter(r => Number(r.yr) <= 2021).pop() || kmRows[0];
  const peakRow = rows.reduce((a, b) => b.act > a.act ? b : a);
  const facts = [
    `<b>${fmt(act)}</b> רכבים פעילים ו-<b>${fmt(off)}</b> שירדו מהכביש (${offPct.toFixed(1)}% מכל מה שנרשם) בשנתונים ${lo} עד ${hi}. השנתון הנפוץ ביותר הוא ${peakRow.yr} עם ${fmt(peakRow.act)} רכבים.`,
    offRel === null ? "" : `שיעור הירידה מהכביש הוא ${relText(offRel, "בשנתונים המקבילים")}. ההשוואה נעשית שנתון מול שנתון, כדי שדגם ותיק לא ייראה גרוע רק בגלל גילו.`,
    kmRel === null ? "" : `הק״מ הטיפוסי בטסט האחרון הוא ${relText(kmRel, "של רכבים מאותם שנתונים")}.`,
    owRel === null ? "" : `מספר רשומות הבעלות לרכב הוא ${relText(owRel, "בשנתונים המקבילים")}. הנתון כולל גם העברות בין חברות ליסינג וסוחרים.`,
    rcPer > 0 ? `לדגם יש כ-${rcPer.toFixed(0)} ריקולים רשומים לכל 1,000 רכבים פעילים (לפי מאגר הריקולים של משרד התחבורה, לפי התאמת דגם ושנתון).` : "",
    d12 >= 50 ? `מכירות רכב חדש: ${fmt(d12)} רכבים ב-12 החודשים שעד ${MKLAST.slice(4)}/${MKLAST.slice(0, 4)}${p12 >= 50 ? `, ${Math.abs(Math.round((d12 / p12 - 1) * 100)) < 3 ? "בלי שינוי משמעותי" : (d12 > p12 ? "עלייה" : "ירידה") + " של " + Math.abs(Math.round((d12 / p12 - 1) * 100)) + "%"} לעומת 12 החודשים שלפניהם` : ""}.` : "",
    prs.length && Number(hi) >= 2023 ? `מחירון משרד התחבורה לגרסאות עדכניות בקטלוג: ${Math.min(...prs) === Math.max(...prs) ? fmt(prs[0] * 1000) : fmt(Math.min(...prs) * 1000) + " עד " + fmt(Math.max(...prs) * 1000)} ₪ (${cr.length === 1 ? "גרסה אחת" : cr.length + " גרסאות"} בקטלוג בסך הכול).` : ""
  ].filter(Boolean);
  const sibs = models.filter(o => o.make === m.make && o !== m).slice(0, 6);
  const bd = bodyOf(m), actM = actOf(m);
  const like = bd ? models.filter(o => o !== m && o.make !== m.make && bodyOf(o) === bd).sort((a, b) => Math.abs(Math.log(actOf(a) / actM)) - Math.abs(Math.log(actOf(b) / actM))).slice(0, 6) : [];
  const ments = magPosts.filter(p => (p.models || []).includes(slugOf(m)));
  const extra2 = (like.length ? `<h2>דגמים באותה קטגוריה (${esc(bd)})</h2><p>${like.map(o => `<a href="${SITE}model/${slugOf(o)}/">${esc(o.label)} ${esc(o.disp)}</a>`).join(" · ")}</p>` : "") + (ments.length ? `<h2>אזכורים במגזין</h2><p>${ments.map(p => `<a href="${SITE}magazine/${p.slug}/">${esc(p.title)}</a>`).join(" · ")}</p>` : "") + (magPosts.length ? `<div class="card"><b>המגזין החודשי של לוחית</b><p class="muted" style="margin:6px 0 12px">סיכום של שוק הרכב בישראל מנתוני משרד התחבורה, פעם בחודש. הגיליון האחרון: <a href="${SITE}magazine/${magPosts[0].slug}/">${esc(magPosts[0].title)}</a></p><a class="cta" href="${SITE}magazine/#nl">לקבלת המגזין למייל</a></div>` : "");
  const faq = [
    [`כמה רכבים מדגם ${name} יש בישראל?`, `לפי מאגרי משרד התחבורה כ-${fmt(act)} רכבים פעילים בשנתונים ${lo} עד ${hi}. השנתון הנפוץ ביותר הוא ${peakRow.yr}.`],
    kmRef ? [`מה הק״מ הטיפוסי של ${name}?`, `בשנתון ${kmRef.yr} הק״מ הטיפוסי בטסט האחרון הוא כ-${fmt(Math.round(kmRef.km / 1000) * 1000)}.`] : null,
    [`כמה רכבים מדגם ${name} ירדו מהכביש?`, `${fmt(off)} רכבים, שהם ${offPct.toFixed(1)}% מכל הרכבים שנרשמו בשנתונים ${lo} עד ${hi}${offRel === null ? "" : `, ${relText(offRel, "בשנתונים המקבילים")}`}.`]
  ].filter(Boolean);
  const extra = `<h2>${esc(name)} במספרים</h2><ul class="g">${facts.map(f => `<li>${f}</li>`).join("")}</ul>${sibs.length ? `<h2>עוד דגמים של ${esc(m.label)}</h2><p>${sibs.map(o => `<a href="${SITE}model/${slugOf(o)}/">${esc(o.disp)}</a>`).join(" · ")}</p>` : ""}<h2>שאלות נפוצות</h2>${faq.map(([q, a]) => `<div class="card"><b>${esc(q)}</b><p style="margin:6px 0 0">${esc(a.replace(/<[^>]+>/g, ""))}</p></div>`).join("")}\n`;
  const ld = {"@context": "https://schema.org", "@graph": [
    {"@type": "Dataset", name: `${name}: רכבים פעילים, ק״מ וירידה מהכביש לפי שנתון`, description: desc, url, inLanguage: "he", isBasedOn: "https://data.gov.il/", temporalCoverage: `${lo}/${hi}`, creator: {"@type": "Organization", name: "לוחית", url: SITE}, variableMeasured: ["רכבים פעילים", "רכבים שירדו מהכביש", "ק״מ טיפוסי בטסט האחרון", "רשומות בעלות לרכב"]},
    {"@type": "BreadcrumbList", itemListElement: [{"@type": "ListItem", position: 1, name: "לוחית", item: SITE}, {"@type": "ListItem", position: 2, name: "כל הדגמים", item: SITE + "model/"}, {"@type": "ListItem", position: 3, name}]},
    {"@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({"@type": "Question", name: q, acceptedAnswer: {"@type": "Answer", text: a}}))}]};
  const peak = rows.reduce((a, b) => b.act > a.act ? b : a);
  const body = `${head(title, desc, url)}<p class="muted"><a href="${SITE}">לוחית</a> › <a href="${SITE}model/">כל הדגמים</a> › ${esc(m.label)}</p><h1>${esc(name)}</h1>
<p>לפי מאגרי משרד התחבורה יש בישראל כ-${fmt(act)} רכבים פעילים מדגם ${esc(name)}${esc(alt)} בשנתונים ${lo} עד ${hi}.${bodies.length ? ` סוגי מרכב בקטלוג: ${bodies.map(esc).join(", ")}.` : ""} השנתון הנפוץ ביותר הוא ${peak.yr} (${fmt(peak.act)} רכבים).</p>
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<h2>רכבים פעילים וקילומטראז׳ לפי שנתון</h2><div class="wrap"><table><thead><tr><th>שנתון</th><th class="n">פעילים</th><th class="n">ירדו מהכביש</th><th class="n">ק״מ טיפוסי</th><th class="n">רשומות בעלות לרכב</th></tr></thead><tbody>
${rows.slice().reverse().map(r => `<tr><td>${r.yr}</td><td class="n">${fmt(r.act)}</td><td class="n">${fmt(r.off)}</td><td class="n">${r.km ? fmt(r.km) : "–"}</td><td class="n">${r.ow ? r.ow.toFixed(1) : "–"}</td></tr>`).join("\n")}
</tbody></table></div><p class="muted">הק״מ הטיפוסי הוא הממוצע בטסט האחרון של רכבים מהשנתון, ומוצג רק כשיש מספיק נתונים. רשומות בעלות כוללות גם מעברים בין חברות ליסינג וסוחרים, ולכן אינן בהכרח מספר בעלים פרטיים. סה״כ ירדו מהכביש ${fmt(off)} רכבים מהדגם בשנתונים האלה.</p>
${extra}${extra2}${stl.length ? `<h2>הסדרי פשרה שעשויים לחול על ${esc(name)}</h2><p class="muted">לפי הודעות היבואנים והעיתונות נכון ל-10/2026. הזכאות תלויה בשנתון, בגרסה ולפעמים במספר שלדה, והרשימה אינה מקיפה ואינה ייעוץ משפטי. לבדיקה לפי מספר רישוי השתמשו באפליקציה.</p>${stl.map(t => `<div class="card"><b>${esc(t.t)}</b> <span class="muted">${t.st === "ok" ? "אושר" : "ממתין לאישור בית המשפט"}</span><p style="margin:6px 0 0">${esc(t.b)}</p><p class="muted" style="margin:6px 0 0">${esc(t.cond)}</p></div>`).join("")}` : ""}<h2>לפני שקונים ${esc(name)}</h2><p>בדקו את הרכב הספציפי לפי מספר רישוי: ריקול פתוח, תוקף טסט, קילומטראז׳ לאורך השנים והיסטוריית בעלויות, והשוו למחיר ביד שנייה.</p>
<p><a class="cta" href="${SITE}">בדיקת רכב בלוחית</a></p>${foot.replace("</main></body></html>", "</main>" + `<script type="application/ld+json">${JSON.stringify(ld)}</script>` + "</body></html>")}`;
  fs.mkdirSync(`model/${slugOf(m)}`, {recursive: true}); fs.writeFileSync(`model/${slugOf(m)}/index.html`, body);
  urls.push(url); if (MOD) lastmod[url] = MOD; m.slug = slugOf(m); m.act = act; slugMap[m.make + "|" + m.model] = m.slug;
}
const by = new Map(); for (const m of models) (by.get(m.label) || by.set(m.label, []).get(m.label)).push(m);
const idx = `${head("דגמי רכב בישראל לפי נתוני משרד התחבורה | לוחית", "רשימת הדגמים הנפוצים בישראל עם מספר הרכבים הפעילים, ק״מ ושנתונים, לפי מאגרי משרד התחבורה.", SITE + "model/").replace("</head>", `<script type="application/ld+json">${JSON.stringify({"@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{"@type": "ListItem", position: 1, name: "לוחית", item: SITE}, {"@type": "ListItem", position: 2, name: "כל הדגמים"}]})}</script></head>`)}<p class="muted"><a href="${SITE}">לוחית</a> › כל הדגמים</p><h1>הדגמים הנפוצים בישראל</h1><p class="muted">לפי מספר הרכבים הפעילים במאגרי משרד התחבורה.</p>
${[...by.entries()].map(([mk, a]) => `<h2>${esc(mk)}</h2><ul class="l">${a.map(m => `<li><a href="${SITE}model/${m.slug}/">${esc(m.disp)}</a> <span class="muted">${fmt(m.act)}</span></li>`).join("")}</ul>`).join("\n")}${foot}`;
fs.writeFileSync("model/index.html", idx);
fs.writeFileSync("model/slugs.json", JSON.stringify(slugMap));

// guide: one evergreen buying guide, built from the app's own "קנייה" tab (same steps, same wording)
{
  const L = (u, t) => `<a href="${u}" rel="noopener">${esc(t)}</a>`;
  const ul = items => `<ul class="g">${items.map(i => `<li>${i}</li>`).join("")}</ul>`;
  const sections = [
    ["1. בבית, לפני שנפגשים", `<p>שלוש בדיקות שאפשר לעשות מהספה, עם מספר הרישוי בלבד:</p>${ul([
      `${L("https://www.gov.il/he/service/pawn_perusal", "בדיקת שעבוד ברשם המשכונות")}: רכב משועבד לא תמיד אפשר להעביר על שמכם.`,
      `${L("https://infocar.co.il/", "בדיקת עבר ביטוחי")} במרכז הסליקה של חברות הביטוח: תביעות ואובדן גמור.`,
      `${L("https://www.gov.il/apps/police/stolencar/", "בדיקה במאגר הרכבים הגנובים")} של המשטרה.`
    ])}<p>את הריקולים הפתוחים, תוקף הטסט, רשומות הבעלות והשינויים שנרשמו ברכב תקבלו בבדיקה לפי מספר רישוי ב${L(SITE, "לוחית")}.</p>`],
    ["2. המוכר והמסמכים", ul([
      "ודאו שמי שמציג את הרכב הוא הבעלים החוקי: שמו ומספר תעודת הזהות שלו מופיעים ברישיון הרכב העדכני. אם הוא מיופה כוח, כדאי לדבר גם עם הבעלים.",
      "במכירה פרטית, מומלץ להיפגש בבית המוכר ובאור יום.",
      "בעסקה עם סוחר, בקשו בכתב מסמכי רכישה ואחריות."
    ])],
    ["3. בפגישה עם הרכב", ul([
      "הניעו את הרכב, הפעילו מזגן ותנו לו לעבוד כמה דקות בזמן שאתם בודקים אותו מבחוץ.",
      "בדקו בלוח המחוונים שהמנוע מתחמם ושומר על טמפרטורה תקינה.",
      "חפשו עשן לבן או אפור מהאגזוז, ונזילות מים או שמן תחת המנוע."
    ])],
    ["4. בדיקה במכון", "<p>מומלץ לבדוק במכון מורשה אחרי שהסכמתם על מחיר עם המוכר, וליידע מראש שתיקונים שיתגלו יקוזזו מהמחיר. סכמו מראש מי משלם על הבדיקה אם יתגלו תקלות קריטיות במנוע, בגיר או בשלדה. את מכוני הבדיקה המורשים באזורכם אפשר למצוא באפליקציה, ברשימת המוסכים המורשים של משרד התחבורה.</p>"],
    ["5. מה לשקלל במחיר", ul([
      "<b>מצבר:</b> לרוב מחליפים אחרי 30 עד 36 חודשים. בדקו את גילו ואם הוא עדיין באחריות.",
      "<b>צמיגים:</b> בדקו מצב וגיל (התאריך מוטבע על הצמיג). בשימוש רגיל הם מחזיקים כ-40 עד 50 אלף ק״מ.",
      "<b>טסט קרוב:</b> חשבו אגרה, עלות טסט, הכנה ויום חופש.",
      "<b>טיפולים:</b> בקשו פירוט מהמוסך ובדקו שהתאריכים והק״מ הגיוניים מול המד. בררו מתי הטיפול הבא ומה עלותו."
    ])],
    ["6. לפני התשלום", `<p>ייתכן שלא ניתן יהיה להעביר בעלות, ולכן הסדירו מראש:</p>${ul([
      "טסט בתוקף.", "ריקול פתוח שטופל.", "הסרת שעבוד או עיקול מול הגורם המשעבד.",
      "הסרת תג חניה לנכה, כשרשום, במשרד הרישוי.", "רישום היורשים, אם הבעלים נפטר."
    ])}<p><b>אל תעבירו תשלום לפני שפעלתם לפי השלבים, ושלמו רק במעמד העברת הבעלות.</b></p>`],
    ["7. אחרי העסקה", `<p>בצעו העברת בעלות ועדכנו את הביטוח מיד, ורק אז התחילו לנהוג ברכב. אפשר להשוות מחירי ביטוח חובה ב${L("https://car.cma.gov.il/", "אתר רשות שוק ההון")}.</p>`],
    ["מה אי אפשר לדעת ממאגרי משרד התחבורה", "<p>שעבודים, תאונות, אובדן גמור, ירידת ערך מביטוח וגניבה. את העבר הביטוחי (תביעות ואובדן גמור) אפשר לבדוק במרכז הסליקה של חברות הביטוח, ולכן הוא שלב ראשון ברשימה.</p>"],
    ["סימני אזהרה ומה לשאול", ul([
      "<b>ריקול פתוח:</b> האם הריקול תוקן? כדאי לבקש אישור תיקון מהיבואן. ריקול שלא תוקן עלול למנוע בהמשך חידוש רישיון.",
      "<b>קילומטראז׳ גבוה ביחס לשנתון:</b> בדקו שהק״מ בטסט האחרון תואם לטסטים ולחשבוניות הטיפול.",
      "<b>היה רכב השכרה:</b> רכבי השכרה עוברים בין נהגים רבים. בקשו הנחה במחיר ובדיקה יסודית במכון.",
      "<b>רכב היברידי, חשמלי או פלאג-אין:</b> עד מתי ועד כמה ק״מ יש אחריות יצרן על הסוללה, אפשר לבטח או להאריך אחריות ובכמה, וברכב חשמלי ופלאג-אין גם אם יש דוח בדיקת בריאות סוללה."
    ])],
    ["כמה הרכב באמת עולה", "<p>מחיר הרכב הוא רק חלק. בעלות של חמש שנים נכללים דלק או חשמל, אגרת רישוי וירידת ערך, וצריך להוסיף ביטוח וטיפולים. השוו בין רכבים לפי העלות הכוללת ולא רק לפי המחיר המבוקש.</p>"]
  ];
  const faq = [
    ["איך בודקים רכב יד שנייה לפי מספר רישוי?", "מקלידים את מספר הרישוי באפליקציה או באתר ומקבלים נתונים ממאגרי משרד התחבורה: ריקולים פתוחים, תוקף וטסט אחרון, רשומות בעלות, קילומטראז׳ מהטסט האחרון ושינויים שנרשמו ברכב."],
    ["האם בדיקה לפי מספר רישוי מחליפה בדיקה במכון?", "לא. היא מראה מה רשום במאגרים הממשלתיים, אבל לא מצב מכני, תאונות או טיפולים. מומלץ להשלים בבדיקה במכון בדיקה עצמאי."],
    ["האם ריקול פתוח אומר שאסור לקנות?", "לא בהכרח. ריקול הוא תיקון שהיבואן מבצע בדרך כלל ללא עלות. ריקול שלא תוקן עלול למנוע בהמשך חידוש רישיון, ולכן כדאי לבקש מהמוכר לבצע אותו או להתחשב בכך במחיר."],
    ["מתי משלמים על רכב יד שנייה?", "רק במעמד העברת הבעלות, אחרי שפעלתם לפי השלבים: טסט בתוקף, ריקול שטופל, הסרת שעבוד ושאר הסדרים."]
  ];
  const url = `${SITE}guide/buy-used-car/`, title = "מדריך לקנייה בטוחה של רכב יד שנייה | לוחית";
  const desc = "שבעה שלבים לקנייה בטוחה: בדיקות מהבית, המוכר והמסמכים, בדיקה במכון, מה לשקלל במחיר ומה לעשות לפני התשלום. כולל סימני אזהרה ושאלות למוכר.";
  const ld = {"@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({"@type": "Question", name: q, acceptedAnswer: {"@type": "Answer", text: a}}))};
  const body = `${head(title, desc, url).replace("</style>", "ul.g{padding-inline-start:20px;margin:8px 0}ul.g li{margin:6px 0}</style>")}<p class="muted"><a href="${SITE}">לוחית</a> › מדריך</p><h1>מדריך לקנייה בטוחה של רכב יד שנייה</h1>
<p>אותם שלבים שמופיעים בלשונית "קנייה" באפליקציית לוחית, מסודרים לפי הסדר שבו כדאי לעשות אותם. בדיקות המאגרים נעשות לפי מספר הרישוי בלבד.</p>
<div class="card"><b>בדקו רכב עכשיו</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, טסט, בעלויות, שינויים והסדרי פשרה במסך אחד, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
${sections.map(([h, t]) => `<h2>${h}</h2>${t}`).join("")}
<h2>שאלות נפוצות</h2>${faq.map(([q, a]) => `<div class="card"><b>${esc(q)}</b><p style="margin:6px 0 0">${esc(a)}</p></div>`).join("")}
<p><a class="cta" href="${SITE}">בדיקת רכב בלוחית</a></p>${foot}<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  fs.mkdirSync("guide/buy-used-car", {recursive: true}); fs.writeFileSync("guide/buy-used-car/index.html", body);
  urls.push(url);
}
// the monthly magazine (magazine.mjs) keeps its own pages; keep them in the sitemap
try { const posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); urls.push(SITE + "magazine/", ...posts.map(p => `${SITE}magazine/${p.slug}/`)); for (const p of posts) if (p.date) lastmod[`${SITE}magazine/${p.slug}/`] = p.date; if (posts[0] && posts[0].date) lastmod[SITE + "magazine/"] = posts[0].date; } catch {}
fs.writeFileSync("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc>${lastmod[u] ? `<lastmod>${lastmod[u]}</lastmod>` : ""}</url>`).join("\n")}\n</urlset>\n`);
console.log("pages", models.length, "sitemap urls", urls.length);
