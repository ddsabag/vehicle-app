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
ul.l{columns:2;list-style:none;padding:0}ul.l li{break-inside:avoid;padding:3px 0}.top{font-weight:800;text-decoration:none;color:var(--fg)}`;
const head = (title, desc, url) => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><meta name="description" content="${esc(desc)}"><link rel="canonical" href="${url}"><meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(desc)}"><meta property="og:image" content="${SITE}og.png"><meta property="og:locale" content="he_IL"><link rel="icon" href="${SITE}icon-512.png"><style>${css}</style></head><body><main>`;
const foot = `<p class="muted" style="margin-top:28px">המידע מגיע ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, ואינו מחליף נסח רישום רשמי או בדיקה במכון מורשה. האפליקציה אינה קשורה למשרד התחבורה. <a href="${SITE}magazine/">מגזין</a> · <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;
fs.rmSync("model", {recursive: true, force: true}); fs.mkdirSync("model", {recursive: true});
const urls = [SITE, SITE + "privacy.html", SITE + "model/"], slugMap = {};
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
  const peak = rows.reduce((a, b) => b.act > a.act ? b : a);
  const body = `${head(title, desc, url)}<p class="muted"><a href="${SITE}model/">כל הדגמים</a> › ${esc(m.make)}</p><h1>${esc(name)}</h1>
<p>לפי מאגרי משרד התחבורה יש בישראל כ-${fmt(act)} רכבים פעילים מדגם ${esc(name)} בשנתונים ${lo} עד ${hi}.${bodies.length ? ` סוגי מרכב בקטלוג: ${bodies.map(esc).join(", ")}.` : ""} השנתון הנפוץ ביותר הוא ${peak.yr} (${fmt(peak.act)} רכבים).</p>
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<h2>רכבים פעילים וקילומטראז׳ לפי שנתון</h2><div class="wrap"><table><thead><tr><th>שנתון</th><th class="n">פעילים</th><th class="n">ירדו מהכביש</th><th class="n">ק״מ טיפוסי</th><th class="n">רשומות בעלות לרכב</th></tr></thead><tbody>
${rows.slice().reverse().map(r => `<tr><td>${r.yr}</td><td class="n">${fmt(r.act)}</td><td class="n">${fmt(r.off)}</td><td class="n">${r.km ? fmt(r.km) : "–"}</td><td class="n">${r.ow ? r.ow.toFixed(1) : "–"}</td></tr>`).join("\n")}
</tbody></table></div><p class="muted">הק״מ הטיפוסי הוא הממוצע בטסט האחרון של רכבים מהשנתון, ומוצג רק כשיש מספיק נתונים. רשומות בעלות כוללות גם מעברים בין חברות ליסינג וסוחרים, ולכן אינן בהכרח מספר בעלים פרטיים. סה״כ ירדו מהכביש ${fmt(off)} רכבים מהדגם בשנתונים האלה.</p>
${stl.length ? `<h2>הסדרי פשרה שעשויים לחול על ${esc(name)}</h2><p class="muted">לפי הודעות היבואנים והעיתונות נכון ל-10/2026. הזכאות תלויה בשנתון, בגרסה ולפעמים במספר שלדה, והרשימה אינה מקיפה ואינה ייעוץ משפטי. לבדיקה לפי מספר רישוי השתמשו באפליקציה.</p>${stl.map(t => `<div class="card"><b>${esc(t.t)}</b> <span class="muted">${t.st === "ok" ? "אושר" : "ממתין לאישור בית המשפט"}</span><p style="margin:6px 0 0">${esc(t.b)}</p><p class="muted" style="margin:6px 0 0">${esc(t.cond)}</p></div>`).join("")}` : ""}<h2>לפני שקונים ${esc(name)}</h2><p>בדקו את הרכב הספציפי לפי מספר רישוי: ריקול פתוח, תוקף טסט, קילומטראז׳ לאורך השנים והיסטוריית בעלויות, והשוו למחיר ביד שנייה.</p>
<p><a class="cta" href="${SITE}">בדיקת רכב בלוחית</a></p>${foot}`;
  fs.mkdirSync(`model/${slugOf(m)}`, {recursive: true}); fs.writeFileSync(`model/${slugOf(m)}/index.html`, body);
  urls.push(url); m.slug = slugOf(m); m.act = act; slugMap[m.make + "|" + m.model] = m.slug;
}
const by = new Map(); for (const m of models) (by.get(m.make) || by.set(m.make, []).get(m.make)).push(m);
const idx = `${head("דגמי רכב בישראל לפי נתוני משרד התחבורה | לוחית", "רשימת הדגמים הנפוצים בישראל עם מספר הרכבים הפעילים, ק״מ ושנתונים, לפי מאגרי משרד התחבורה.", SITE + "model/")}<h1>הדגמים הנפוצים בישראל</h1><p class="muted">לפי מספר הרכבים הפעילים במאגרי משרד התחבורה.</p>
${[...by.entries()].map(([mk, a]) => `<h2>${esc(mk)}</h2><ul class="l">${a.map(m => `<li><a href="${SITE}model/${m.slug}/">${esc(m.disp)}</a> <span class="muted">${fmt(m.act)}</span></li>`).join("")}</ul>`).join("\n")}${foot}`;
fs.writeFileSync("model/index.html", idx);
fs.writeFileSync("model/slugs.json", JSON.stringify(slugMap));
// the monthly magazine (magazine.mjs) keeps its own pages; keep them in the sitemap
try { const posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); urls.push(SITE + "magazine/", ...posts.map(p => `${SITE}magazine/${p.slug}/`)); } catch {}
fs.writeFileSync("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u}</loc></url>`).join("\n")}\n</urlset>\n`);
console.log("pages", models.length, "sitemap urls", urls.length);
