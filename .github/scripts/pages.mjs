// Builds static model pages (model/<slug>/index.html), model/index.html and sitemap.xml from modelstats.json + models.json.
// Only data already in the repo is used; run: node .github/scripts/pages.mjs [count]
import fs from "node:fs";
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
const normModel = m => { const t = m.toUpperCase().replace(/\s+/g, " ").split(" ").filter(x => !NOISE.has(x)); return (t.length ? t : [m]).join(" ").replace(/([A-Z]) (\d)/g, "$1$2").replace(/([A-Z])-(\d)/g, "$1$2"); };
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
    const t = e.y[yr] || (e.y[yr] = {act: 0, off: 0, kmw: 0, kmn: 0, ow: 0, own: 0});
    t.act += a[0]; t.off += a[1];
    if (a[2]) { t.kmw += a[2] * a[0]; t.kmn += a[0]; }
    if (a[3]) { t.ow += a[3] * a[0]; t.own += a[0]; }
  }
  g.set(k, e);
}
const models = [...g.values()].sort((a, b) => b.total - a.total).slice(0, N);
const slugOf = m => (m.model.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "model") + "-" + m.cd;
const css = `:root{--bg:#f4f6fa;--card:#fff;--fg:#151a24;--muted:#5d6676;--line:#dfe4ec;--accent:#2a56c6;--plate:#f5c400}@media(prefers-color-scheme:dark){:root{--bg:#0e121a;--card:#171d28;--fg:#e9edf3;--muted:#98a2b4;--line:#262e3c;--accent:#7c9cf0}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.65 system-ui,"Segoe UI",Arial,sans-serif;direction:rtl}main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
h1{font-size:1.45rem;margin:0 0 6px;line-height:1.3}h1::after{content:"";display:block;width:40px;height:4px;border-radius:2px;background:var(--plate);margin-top:8px}h2{font-size:1.05rem;margin:26px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}.muted{color:var(--muted);font-size:.9rem}
.cta{display:inline-block;background:var(--accent);color:#fff;border-radius:10px;padding:10px 18px;font-weight:700;text-decoration:none}a{color:var(--accent)}
.wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:.92rem}th,td{padding:7px 6px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:left;font-variant-numeric:tabular-nums}
header.top{background:linear-gradient(180deg,#e2ecfd,#fff);border-bottom:1px solid var(--line)}header.top .in{max-width:720px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}header.top .brand{display:flex;align-items:center;gap:10px;color:#151a24;text-decoration:none}header.top img{border-radius:10px}header.top .nm{display:flex;flex-direction:column;line-height:1.15}header.top b{font-size:1.45rem;font-weight:800}header.top small{font-size:.78rem;font-weight:600;color:#5d6676}header.top .chk{background:#2556c8;color:#fff;border-radius:10px;padding:9px 14px;font-weight:700;font-size:.9rem;text-decoration:none;white-space:nowrap}@media(prefers-color-scheme:dark){header.top{background:linear-gradient(180deg,#182338,#121722)}header.top .brand{color:#fff}header.top small{color:#8d98ad}}
p.gp{margin:0;padding:6px 16px;text-align:center;font-size:.82rem;background:var(--card);border-bottom:1px solid var(--line)}p.gp a{color:var(--muted);text-decoration:none}p.gp a:hover{text-decoration:underline}ul.l{columns:2;list-style:none;padding:0}ul.l li{break-inside:avoid;padding:3px 0}.top{font-weight:800;text-decoration:none;color:var(--fg)}`;
const PLAY = "https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev";
const head = (title, desc, url, type = "website") => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}"><meta property="og:type" content="${type}"><meta property="og:site_name" content="לוחית"><meta property="og:url" content="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${SITE}og.png"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"><meta property="og:image:alt" content="לוחית, בדיקת רכב לפי מספר"><meta property="og:locale" content="he_IL"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(desc)}"><meta name="twitter:image" content="${SITE}og.png"><meta name="theme-color" content="#ffffff"><link rel="manifest" href="${SITE}manifest.json"><link rel="apple-touch-icon" href="${SITE}apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="לוחית"><meta name="apple-mobile-web-app-status-bar-style" content="default"><link rel="icon" href="${SITE}icon-512.png"><style>${css}</style></head><body><header class="top"><div class="in"><a class="brand" href="${SITE}"><img src="${SITE}icon-512.png" alt="" width="44" height="44"><span class="nm"><b>לוחית</b><small>בדיקת רכב לפי מספר רישוי</small></span></a><a class="chk" href="${SITE}">לבדיקת רכב</a></div></header><p class="gp"><a href="${PLAY}" rel="noopener">באפליקציה: התראות על ריקול וטסט · <bdi>Google Play</bdi></a></p><main>`;
const foot = `<p class="muted" style="margin-top:28px">המידע מגיע ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, ואינו מחליף נסח רישום רשמי או בדיקה במכון מורשה. האפליקציה אינה קשורה למשרד התחבורה. <a href="${SITE}magazine/">מגזין</a> · <a href="${SITE}guide/buy-used-car/">מדריך לקונה</a> · <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;
fs.rmSync("model", {recursive: true, force: true}); fs.mkdirSync("model", {recursive: true});
const MOD = ms.updated ? String(ms.updated).slice(0, 10) : "", lastmod = {};
const urls = [SITE, SITE + "privacy.html", SITE + "model/"], slugMap = {};
if (MOD) lastmod[SITE + "model/"] = MOD;
for (const m of models) {
  const years = Object.keys(m.y).sort();
  const rows = years.map(yr => { const t = m.y[yr]; return {yr, act: t.act, off: t.off, km: t.kmn ? t.kmw / t.kmn : null, ow: t.own ? t.ow / t.own : null}; });
  const act = rows.reduce((s, r) => s + r.act, 0), off = rows.reduce((s, r) => s + r.off, 0);
  const cr = cat.rows.filter(r => normModel(r[1]) === m.model && r[0].split(" ")[0] === m.make.split(" ")[0]);
  const bodies = [...new Set(cr.map(r => r[5]).filter(Boolean))];
  const lo = rows[0].yr, hi = rows[rows.length - 1].yr, heb = HEBN[hebKey(m.model)], name = heb && heb.startsWith("מאזדה") ? `מזדה ${heb.slice(6)} (${m.disp})` : `${m.make} ${heb ? heb + " (" + m.disp + ")" : m.disp}`;
  const url = `${SITE}model/${slugOf(m)}/`, title = `${name}: כמה רכבים על הכביש, ק״מ ושנתונים | לוחית`;
  const desc = `${name} בישראל לפי נתוני משרד התחבורה: ${fmt(act)} רכבים פעילים בשנתונים ${lo}–${hi}, ק״מ טיפוסי לפי שנתון וכמה ירדו מהכביש. בדיקת רכב לפי מספר רישוי.`;
  const stl = stlFor(m.make, m.model, years.map(Number));
  const ld = {"@context": "https://schema.org", "@graph": [
    {"@type": "Dataset", name: `${name}: רכבים פעילים, ק״מ וירידה מהכביש לפי שנתון`, description: desc, url, inLanguage: "he", isBasedOn: "https://data.gov.il/", temporalCoverage: `${lo}/${hi}`, creator: {"@type": "Organization", name: "לוחית", url: SITE}, variableMeasured: ["רכבים פעילים", "רכבים שירדו מהכביש", "ק״מ טיפוסי בטסט האחרון", "רשומות בעלות לרכב"]},
    {"@type": "BreadcrumbList", itemListElement: [{"@type": "ListItem", position: 1, name: "לוחית", item: SITE}, {"@type": "ListItem", position: 2, name: "כל הדגמים", item: SITE + "model/"}, {"@type": "ListItem", position: 3, name}]}]};
  const peak = rows.reduce((a, b) => b.act > a.act ? b : a);
  const body = `${head(title, desc, url)}<p class="muted"><a href="${SITE}model/">כל הדגמים</a> › ${esc(m.make)}</p><h1>${esc(name)}</h1>
<p>לפי מאגרי משרד התחבורה יש בישראל כ-${fmt(act)} רכבים פעילים מדגם ${esc(name)} בשנתונים ${lo} עד ${hi}.${bodies.length ? ` סוגי מרכב בקטלוג: ${bodies.map(esc).join(", ")}.` : ""} השנתון הנפוץ ביותר הוא ${peak.yr} (${fmt(peak.act)} רכבים).</p>
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<h2>רכבים פעילים וקילומטראז׳ לפי שנתון</h2><div class="wrap"><table><thead><tr><th>שנתון</th><th class="n">פעילים</th><th class="n">ירדו מהכביש</th><th class="n">ק״מ טיפוסי</th><th class="n">רשומות בעלות לרכב</th></tr></thead><tbody>
${rows.slice().reverse().map(r => `<tr><td>${r.yr}</td><td class="n">${fmt(r.act)}</td><td class="n">${fmt(r.off)}</td><td class="n">${r.km ? fmt(r.km) : "–"}</td><td class="n">${r.ow ? r.ow.toFixed(1) : "–"}</td></tr>`).join("\n")}
</tbody></table></div><p class="muted">הק״מ הטיפוסי הוא הממוצע בטסט האחרון של רכבים מהשנתון, ומוצג רק כשיש מספיק נתונים. רשומות בעלות כוללות גם מעברים בין חברות ליסינג וסוחרים, ולכן אינן בהכרח מספר בעלים פרטיים. סה״כ ירדו מהכביש ${fmt(off)} רכבים מהדגם בשנתונים האלה.</p>
${stl.length ? `<h2>הסדרי פשרה שעשויים לחול על ${esc(name)}</h2><p class="muted">לפי הודעות היבואנים והעיתונות נכון ל-10/2026. הזכאות תלויה בשנתון, בגרסה ולפעמים במספר שלדה, והרשימה אינה מקיפה ואינה ייעוץ משפטי. לבדיקה לפי מספר רישוי השתמשו באפליקציה.</p>${stl.map(t => `<div class="card"><b>${esc(t.t)}</b> <span class="muted">${t.st === "ok" ? "אושר" : "ממתין לאישור בית המשפט"}</span><p style="margin:6px 0 0">${esc(t.b)}</p><p class="muted" style="margin:6px 0 0">${esc(t.cond)}</p></div>`).join("")}` : ""}<h2>לפני שקונים ${esc(name)}</h2><p>בדקו את הרכב הספציפי לפי מספר רישוי: ריקול פתוח, תוקף טסט, קילומטראז׳ לאורך השנים והיסטוריית בעלויות, והשוו למחיר ביד שנייה.</p>
<p><a class="cta" href="${SITE}">בדיקת רכב בלוחית</a></p>${foot.replace("</main></body></html>", "</main>" + `<script type="application/ld+json">${JSON.stringify(ld)}</script>` + "</body></html>")}`;
  fs.mkdirSync(`model/${slugOf(m)}`, {recursive: true}); fs.writeFileSync(`model/${slugOf(m)}/index.html`, body);
  urls.push(url); if (MOD) lastmod[url] = MOD; m.slug = slugOf(m); m.act = act; slugMap[m.make + "|" + m.model] = m.slug;
}
const by = new Map(); for (const m of models) (by.get(m.make) || by.set(m.make, []).get(m.make)).push(m);
const idx = `${head("דגמי רכב בישראל לפי נתוני משרד התחבורה | לוחית", "רשימת הדגמים הנפוצים בישראל עם מספר הרכבים הפעילים, ק״מ ושנתונים, לפי מאגרי משרד התחבורה.", SITE + "model/")}<h1>הדגמים הנפוצים בישראל</h1><p class="muted">לפי מספר הרכבים הפעילים במאגרי משרד התחבורה.</p>
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
      "<b>ריקול פתוח:</b> האם הריקול תוקן? כדאי לבקש אישור תיקון מהיבואן. ריקול מגביל יכול למנוע חידוש רישיון עד לתיקון.",
      "<b>קילומטראז׳ גבוה ביחס לשנתון:</b> בדקו שהק״מ בטסט האחרון תואם לטסטים ולחשבוניות הטיפול.",
      "<b>היה רכב השכרה:</b> רכבי השכרה עוברים בין נהגים רבים. בקשו הנחה במחיר ובדיקה יסודית במכון.",
      "<b>רכב היברידי, חשמלי או פלאג-אין:</b> עד מתי ועד כמה ק״מ יש אחריות יצרן על הסוללה, אפשר לבטח או להאריך אחריות ובכמה, וברכב חשמלי ופלאג-אין גם אם יש דוח בדיקת בריאות סוללה."
    ])],
    ["כמה הרכב באמת עולה", "<p>מחיר הרכב הוא רק חלק. בעלות של חמש שנים נכללים דלק או חשמל, אגרת רישוי וירידת ערך, וצריך להוסיף ביטוח וטיפולים. השוו בין רכבים לפי העלות הכוללת ולא רק לפי המחיר המבוקש.</p>"]
  ];
  const faq = [
    ["איך בודקים רכב יד שנייה לפי מספר רישוי?", "מקלידים את מספר הרישוי באפליקציה או באתר ומקבלים נתונים ממאגרי משרד התחבורה: ריקולים פתוחים, תוקף וטסט אחרון, רשומות בעלות, קילומטראז׳ מהטסט האחרון ושינויים שנרשמו ברכב."],
    ["האם בדיקה לפי מספר רישוי מחליפה בדיקה במכון?", "לא. היא מראה מה רשום במאגרים הממשלתיים, אבל לא מצב מכני, תאונות או טיפולים. מומלץ להשלים בבדיקה במכון בדיקה עצמאי."],
    ["האם ריקול פתוח אומר שאסור לקנות?", "לא בהכרח. ריקול הוא תיקון שהיבואן מבצע בדרך כלל ללא עלות. ריקול מגביל יכול למנוע חידוש רישיון עד שהתיקון מתבצע, ולכן כדאי לבקש מהמוכר לבצע אותו או להתחשב בכך במחיר."],
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
