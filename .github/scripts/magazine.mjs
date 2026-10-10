// Builds the monthly market article (magazine/<YYYY-MM>/index.html), magazine/index.html, magazine/posts.json and sitemap entries
// from market.json. The prose comes from Gemini when GEMINI_API_KEY is set and passes the number check, otherwise from a fixed template.
// run: node .github/scripts/magazine.mjs [YYYYMM]   (default: latest closed month in market.json)
import fs from "node:fs";
const SITE = "https://luchit.app/";
const M = JSON.parse(fs.readFileSync("market.json", "utf8"));
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const keys = Object.keys(M.months).sort();
const ym = process.argv[2] || keys[keys.length - 1];
const year = Number(ym.slice(0, 4)), mon = Number(ym.slice(4)), prevYm = String(year - 1) + ym.slice(4);
const monthName = MONTHS[mon - 1], label = `${monthName} ${year}`, slug = `${year}-${String(mon).padStart(2, "0")}`;
const now = new Date();
// publish only a closed month, and refuse one that looks partial (under 60% of the average of the three months before it)
if (!M.months[ym] || ym >= `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`) { console.error("month is not closed:", ym); process.exit(2); }
const before = keys.filter(k => k < ym).slice(-3).map(k => M.months[k]);
if (before.length && M.months[ym] < 0.6 * before.reduce((a, b) => a + b, 0) / before.length) { console.error("month looks partial:", ym); process.exit(2); }

const total = M.months[ym], prev = M.months[prevYm] || 0, chg = prev ? (total - prev) / prev * 100 : null;
const rank = (obj, n) => Object.entries(obj).map(([k, v]) => [k, v[ym] || 0]).filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, n);
const models = rank(M.models, 5).map(([k, n]) => ({name: k.split("|").join(" "), key: k, n}));
const makers = rank(M.makers, 5).map(([k, n]) => ({name: k, n}));
const bodies = rank(M.bodies, 3).map(([k, n]) => ({name: k, n, pct: Math.round(n / total * 100)}));
const sumYtd = y => Object.entries(M.months).filter(([k]) => k.startsWith(String(y)) && Number(k.slice(4)) <= mon).reduce((a, [, v]) => a + v, 0);
const ytd = sumYtd(year), ytdPrev = sumYtd(year - 1), ytdChg = ytdPrev ? (ytd - ytdPrev) / ytdPrev * 100 : null;
const pct = x => Math.round(Math.abs(x));
const dir = (c, up = "עלייה", down = "ירידה") => c === null ? "" : Math.abs(c) < 2 ? "שינוי קטן" : c > 0 ? up : down;

// facts handed to the writer; every number allowed in the prose comes from here
const facts = {
  month: label, total, same_month_last_year: prev, change_percent_vs_last_year: chg === null ? null : pct(chg), change_direction: dir(chg),
  top_models: models.map(m => ({model: m.name, deliveries: m.n})), top_makers: makers.map(m => ({maker: m.name, deliveries: m.n})),
  top_body_types: bodies.map(b => ({type: b.name, deliveries: b.n, share_percent: b.pct})),
  year_to_date: ytd, year_to_date_last_year: ytdPrev, ytd_change_percent: ytdChg === null ? null : pct(ytdChg), ytd_direction: dir(ytdChg)
};
const allowed = new Set([...JSON.stringify(facts).matchAll(/\d[\d.]*\d|\d/g)].map(m => m[0]));
for (let i = 0; i <= 12; i++) allowed.add(String(i));
for (let y = 2020; y <= 2030; y++) allowed.add(String(y));
const FORBIDDEN = /בגלל|הסיבה|כתוצאה|עקב|צפוי|תחזית|צפויה|נראה כי|ככל הנראה/;

const template = () => ({
  title: `מה נמכר ב${label}: ${models[0].name} בפסגה`,
  lead: `ב${monthName} ${year} נמסרו בישראל ${fmt(total)} רכבים פרטיים חדשים${prev ? `, ${dir(chg) === "שינוי קטן" ? "שינוי קטן" : dir(chg)} של כ-${pct(chg)}% לעומת ${monthName} אשתקד (${fmt(prev)})` : ""}. ${makers[0].name} הובילה בין היצרנים, ובין הדגמים הובילה ${models[0].name}.`,
  models_p: `בראש הרשימה ${models[0].name} עם ${fmt(models[0].n)} רכבים, אחריה ${models.slice(1).map(m => `${m.name} (${fmt(m.n)})`).join(", ")}.`,
  makers_p: `בין היצרנים הובילה ${makers[0].name} עם ${fmt(makers[0].n)} רכבים, אחריה ${makers.slice(1).map(m => `${m.name} (${fmt(m.n)})`).join(", ")}.`,
  bodies_p: `לפי סוג המרכב, ${bodies.map(b => `${b.name} היו ${b.pct}% מהמסירות (${fmt(b.n)} רכבים)`).join(", ")}.`,
  ytd_p: ytdPrev ? `מתחילת ${year} ועד סוף ${monthName} נמסרו ${fmt(ytd)} רכבים, לעומת ${fmt(ytdPrev)} בתקופה המקבילה אשתקד (${dir(ytdChg)} של כ-${pct(ytdChg)}%).` : ""
});

async function gemini() {
  const key = process.env.GEMINI_API_KEY; if (!key) return null;
  const prompt = `כתוב כתבה קצרה בעברית בסגנון עיתונאי עניייני על מסירות רכבים חדשים בישראל, על בסיס העובדות שב-JSON בלבד.
כללים: אל תוסיף שום עובדה, מספר, אחוז, סיבה, תחזית או השוואה שלא מופיעים ב-JSON. אל תנחש למה משהו קרה. כתוב מספרים בדיוק כפי שהם. אל תזכיר מקורות או אתרים. הטבלאות והגרפים מוצגים בנפרד, אז אל תפרט כל מספר, אבל כל מספר שתכתוב חייב להופיע ב-JSON.
החזר JSON בלבד עם השדות: title (כותרת עד 90 תווים), lead (פסקת פתיחה של 2 עד 3 משפטים), models_p, makers_p, bodies_p, ytd_p (כל אחד 1 עד 2 משפטים).
העובדות:\n${JSON.stringify(facts)}`;
  for (const model of (process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : ["gemini-flash-lite-latest", "gemini-flash-latest"])) {
    for (let t = 0; t < 2; t++) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST", headers: {"content-type": "application/json", "x-goog-api-key": key}, signal: AbortSignal.timeout(60000),
          body: JSON.stringify({contents: [{parts: [{text: prompt}]}], generationConfig: {responseMimeType: "application/json", temperature: 0.4}})
        });
        if (!r.ok) { console.error("gemini", model, r.status); continue; }
        const j = await r.json(), txt = j.candidates?.[0]?.content?.parts?.map(p => p.text).join("") || "";
        const a = JSON.parse(txt), bad = check(a);
        if (!bad) return a;
        console.error("gemini draft rejected:", bad);
      } catch (e) { console.error("gemini error", e.message); }
    }
  }
  return null;
}
// every number in the prose must exist in the facts, and no causal or forecast wording
export function check(a) {
  for (const f of ["title", "lead", "models_p", "makers_p", "bodies_p", "ytd_p"]) if (typeof a[f] !== "string" || (!a[f] && f !== "ytd_p")) return "missing " + f;
  const text = Object.values(a).join(" ");
  if (FORBIDDEN.test(text)) return "forbidden wording";
  for (const m of text.matchAll(/\d[\d,.]*\d|\d/g)) { const n = m[0].replace(/,/g, ""); if (!allowed.has(n)) return "unknown number " + m[0]; }
  if (a.title.length > 120) return "title too long";
  return null;
}

const css = fs.readFileSync(".github/scripts/pages.mjs", "utf8").match(/const css = `([\s\S]*?)`;/)[1] + `.bar{display:block;height:8px;border-radius:4px;background:var(--accent);margin-top:4px}.rk{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.rk:last-child{border-bottom:0}.rk i{font-style:normal;font-weight:800;color:var(--muted)}.rk span{font-variant-numeric:tabular-nums;color:var(--muted)}.tag{display:inline-block;background:#eef2fb;color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.78rem;font-weight:600}.lst a{display:block;padding:10px 0;border-bottom:1px solid var(--line);color:var(--fg);text-decoration:none}.lst small{display:block;color:var(--muted)}`;
const headOf = pages => pages.match(/const head = [\s\S]*?\n/)[0];
const pagesSrc = fs.readFileSync(".github/scripts/pages.mjs", "utf8");
const head = new Function("esc", "css", "SITE", headOf(pagesSrc) + "\nreturn head;")(esc, css, SITE);
const foot = `<p class="muted" style="margin-top:28px">מערכת לוחית. הנתונים מגיעים ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, והאתר אינו קשור למשרד התחבורה. <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;

let slugs = {}; try { slugs = JSON.parse(fs.readFileSync("model/slugs.json", "utf8")); } catch {}
const bars = (list, label2) => { const mx = list[0].n; return list.map((x, i) => { const s = label2 && slugs[x.key]; const nm = s ? `<a href="${SITE}model/${s}/">${esc(x.name)}</a>` : esc(x.name); return `<div class="rk"><i>${i + 1}</i><div>${nm}<span class="bar" style="width:${Math.max(4, Math.round(x.n / mx * 100))}%"></span></div><span>${fmt(x.n)}</span></div>`; }).join(""); };

// a trailing % flips in right-to-left text, so prose spells it out
const pr = t => esc(t).replace(/(\d+)%/g, "$1 אחוזים");
const ai = await gemini(), art = ai || template(), usedAi = !!ai;
fs.mkdirSync(`magazine/${slug}`, {recursive: true});
const url = `${SITE}magazine/${slug}/`, desc = art.lead.slice(0, 200), published = now.toISOString().slice(0, 10);
const ld = {"@context": "https://schema.org", "@type": "Article", headline: art.title, datePublished: published, inLanguage: "he", author: {"@type": "Organization", name: "מערכת לוחית"}, publisher: {"@type": "Organization", name: "לוחית", url: SITE}, mainEntityOfPage: url};
const body = `${head(art.title + " | לוחית", desc, url).replace("</head>", `<script type="application/ld+json">${JSON.stringify(ld)}</script></head>`)}<p class="muted"><a href="${SITE}magazine/">מגזין לוחית</a></p><p><span class="tag">שוק הרכב</span> <span class="muted">${esc(label)}</span></p><h1>${pr(art.title)}</h1>
<p>${pr(art.lead)}</p>
<h2>הדגמים המובילים</h2><div class="card">${bars(models, true)}</div><p>${pr(art.models_p)}</p>
<h2>היצרנים המובילים</h2><div class="card">${bars(makers.map(m => ({...m, key: ""})), false)}</div><p>${pr(art.makers_p)}</p>
<h2>סוגי מרכב</h2><p>${pr(art.bodies_p)}</p>${art.ytd_p ? `<h2>מתחילת השנה</h2><p>${pr(art.ytd_p)}</p>` : ""}
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, הסדרי פשרה, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<p class="muted">מקור הנתונים: מאגרי משרד התחבורה, מסירות של רכבים פרטיים חדשים. ${usedAi ? "הכתבה נוצרה בעזרת מודל שפה מעובדות שחושבו מהנתונים, ונבדקה לפני פרסום." : "הכתבה נוצרה אוטומטית מהנתונים."} פורסם ב-${esc(published)}.</p>${foot}`;
fs.writeFileSync(`magazine/${slug}/index.html`, body);

// index, posts list and sitemap
let posts = []; try { posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); } catch {}
posts = posts.filter(p => p.slug !== slug); posts.push({slug, title: art.title, tag: "שוק הרכב", date: published, month: label, lead: art.lead});
posts.sort((a, b) => b.slug.localeCompare(a.slug));
fs.writeFileSync("magazine/posts.json", JSON.stringify(posts, null, 1));
const idxUrl = SITE + "magazine/";
fs.writeFileSync("magazine/index.html", `${head("מגזין לוחית: שוק הרכב בישראל", "כתבות חודשיות על שוק הרכב בישראל מנתוני משרד התחבורה: מה נמכר, אילו דגמים ויצרנים מובילים.", idxUrl)}<p class="muted"><a href="${SITE}">לוחית</a></p><h1>מגזין לוחית</h1><p class="muted">כתבות על שוק הרכב בישראל, מנתוני משרד התחבורה.</p><div class="card lst">${posts.map(p => `<a href="${SITE}magazine/${p.slug}/"><b>${esc(p.title)}</b><small>${esc(p.tag)} · ${esc(p.month)}</small></a>`).join("")}</div>${foot}`);
let sm = fs.readFileSync("sitemap.xml", "utf8");
for (const u of [idxUrl, url]) if (!sm.includes(`<loc>${u}</loc>`)) sm = sm.replace("</urlset>", `  <url><loc>${u}</loc></url>\n</urlset>`);
fs.writeFileSync("sitemap.xml", sm);
console.log(`magazine ${slug}: ${usedAi ? "gemini" : "template"}, ${posts.length} posts`);
