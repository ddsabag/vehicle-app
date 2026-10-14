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
  bodies_p: `לפי סוג המרכב, ${bodies.map(b => `${b.name} היו ${b.pct}% מהמסירות (${fmt(b.n)} רכבים)`).join(", ")}.`,
  ytd_p: ytdPrev ? `מתחילת ${year} ועד סוף ${monthName} נמסרו ${fmt(ytd)} רכבים, לעומת ${fmt(ytdPrev)} בתקופה המקבילה אשתקד (${dir(ytdChg)} של כ-${pct(ytdChg)}%).` : "",
  tldr: [
    `ב${monthName} ${year} נמסרו ${fmt(total)} רכבים פרטיים חדשים${prev && dir(chg) !== "שינוי קטן" ? `, ${dir(chg)} של כ-${pct(chg)}% לעומת ${monthName} אשתקד` : ""}.`,
    `${models[0].name} הדגם המוביל עם ${fmt(models[0].n)} רכבים, ו${makers[0].name} היצרנית המובילה עם ${fmt(makers[0].n)}.`,
    `${bodies[0].name} הם סוג המרכב הנפוץ ביותר, עם ${bodies[0].pct}% מהמסירות.`
  ],
  faq: [
    {q: `כמה רכבים חדשים נמסרו בישראל ב${monthName} ${year}?`, a: `נמסרו ${fmt(total)} רכבים פרטיים חדשים${prev ? `, לעומת ${fmt(prev)} ב${monthName} אשתקד` : ""}.`},
    {q: `איזה דגם נמכר הכי הרבה ב${monthName} ${year}?`, a: `${models[0].name}, עם ${fmt(models[0].n)} רכבים.`},
    {q: `איזו יצרנית הובילה ב${monthName} ${year}?`, a: `${makers[0].name}, עם ${fmt(makers[0].n)} רכבים.`},
    {q: `איזה סוג מרכב הכי נפוץ?`, a: `${bodies[0].name}, עם ${bodies[0].pct}% מהמסירות (${fmt(bodies[0].n)} רכבים).`}
  ]
});

async function gemini() {
  // off by default: the 2026-09 drafts had a repeated typo and clumsy wording, the data template reads better. Set MAGAZINE_AI=1 to try again.
  const key = process.env.GEMINI_API_KEY; if (!key || process.env.MAGAZINE_AI !== "1") return null;
  const prompt = `כתוב כתבה קצרה בעברית בסגנון עיתונאי עניייני על מסירות רכבים חדשים בישראל, על בסיס העובדות שב-JSON בלבד.
כללים: אל תוסיף שום עובדה, מספר, אחוז, סיבה, תחזית או השוואה שלא מופיעים ב-JSON. אל תנחש למה משהו קרה. כתוב מספרים בדיוק כפי שהם. אל תזכיר מקורות או אתרים. בדוק איות ודקדוק לפני שאתה מחזיר. הטבלאות והגרפים מוצגים בנפרד, אז אל תפרט כל מספר, אבל כל מספר שתכתוב חייב להופיע ב-JSON.
החזר JSON בלבד עם השדות: title (כותרת עד 90 תווים), lead (פסקת פתיחה של 2 עד 3 משפטים), bodies_p, ytd_p (כל אחד 1 עד 2 משפטים; הדגמים והיצרנים מוצגים ברשימות ממוספרות נפרדות, ולכן אל תחזור עליהם בפירוט), tldr (מערך של בדיוק 3 משפטים קצרים שמסכמים את הכתבה), faq (מערך של 3 עד 4 אובייקטים {"q": שאלה, "a": תשובה של משפט אחד עד שניים}). שאלות ה-FAQ הן שאלות שקורא היה שואל על הנתונים, והתשובות רק מתוך העובדות.
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
  for (const f of ["title", "lead", "bodies_p", "ytd_p"]) if (typeof a[f] !== "string" || (!a[f] && f !== "ytd_p")) return "missing " + f;
  if (!Array.isArray(a.tldr) || a.tldr.length !== 3 || a.tldr.some(x => typeof x !== "string" || !x.trim() || x.length > 220)) return "bad tldr";
  if (!Array.isArray(a.faq) || a.faq.length < 3 || a.faq.length > 4 || a.faq.some(x => !x || typeof x.q !== "string" || typeof x.a !== "string" || !x.q.trim() || !x.a.trim() || x.q.length > 160 || x.a.length > 400)) return "bad faq";
  const text = [a.title, a.lead, a.bodies_p, a.ytd_p, ...a.tldr, ...a.faq.flatMap(x => [x.q, x.a])].join(" ");
  if (FORBIDDEN.test(text)) return "forbidden wording";
  for (const m of text.matchAll(/\d[\d,.]*\d|\d/g)) { const n = m[0].replace(/,/g, ""); if (!allowed.has(n)) return "unknown number " + m[0]; }
  if (a.title.length > 120) return "title too long";
  return null;
}

const subCss = `.sub{border-inline-start:4px solid var(--accent)}.sub b{display:block;margin-bottom:2px}.sub p{margin:4px 0 12px}.sub .row{display:flex;gap:8px;flex-wrap:wrap}.sub input[type=email]{flex:1 1 220px;min-width:0;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);direction:ltr;text-align:left}.sub input[type=email]:placeholder-shown{direction:rtl;text-align:right}.sub button{flex:1 1 100%;font:inherit;font-weight:700;background:var(--accent);color:#fff;border:0;border-radius:10px;padding:10px 18px;cursor:pointer}.sub button[disabled]{opacity:.6;cursor:default}.sub label{display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:.88rem;color:var(--muted);line-height:1.5}.sub label input{margin-top:3px}.sub .hp{position:absolute;inset-inline-start:-9999px;width:1px;height:1px;overflow:hidden}.sub .st{min-height:1.4em;margin:8px 0 0;font-size:.9rem}.sub .ok{color:#1d7a46}.sub .er{color:#b3261e}.subbar{background:#e9f6ee;color:#14532d;border-radius:10px;padding:10px 14px;margin:0 0 14px}`;
const css = fs.readFileSync(".github/scripts/pages.mjs", "utf8").match(/const css = `([\s\S]*?)`;/)[1] + `.bar{display:block;height:8px;border-radius:4px;background:var(--accent);margin-top:4px}.rk{display:grid;grid-template-columns:26px 1fr auto;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.rk:last-child{border-bottom:0}.rk i{font-style:normal;font-weight:800;color:var(--muted)}.rk span{font-variant-numeric:tabular-nums;color:var(--muted)}.tag{display:inline-block;background:#eef2fb;color:var(--accent);border-radius:99px;padding:2px 10px;font-size:.78rem;font-weight:600}.lst a{display:block;padding:10px 0;border-bottom:1px solid var(--line);color:var(--fg);text-decoration:none}.lst small{display:block;color:var(--muted)}.tldr{border-inline-start:4px solid var(--accent)}.tldr b{display:block;margin-bottom:4px}.tldr ul{margin:0;padding-inline-start:20px}.tldr li{margin:4px 0}.faq h3{font-size:1rem;margin:16px 0 4px}.faq p{margin:0}` + subCss + `
header.top{background:var(--card)}header.top small{color:var(--muted)}header.top b{color:var(--fg)}header.top .brand{color:var(--fg)}
main h1{font-size:1.9rem;line-height:1.2;text-wrap:balance;margin:10px 0 18px}main h1::after{display:none}
.hero{position:relative;overflow:hidden;background:#15171b;color:#fff;border-radius:16px;padding:22px 20px;margin:0 0 22px}.hero::before{content:"";position:absolute;inset-inline-start:0;top:0;bottom:0;width:5px;background:var(--plate)}
.hero small{display:block;color:#b8bcc4}.hero strong{display:block;font-size:3.2rem;line-height:1.1;letter-spacing:-.02em;font-variant-numeric:tabular-nums}.hero em{font-style:normal;color:#e9c240;font-weight:700}
.tldr{border-inline-start-color:var(--plate)}
.rk .bar{background:#9aa0a8;height:6px}.rk:first-child .bar{background:var(--plate)}.rk{padding:10px 0}`;
const headOf = pages => pages.match(/const head = [\s\S]*?\n/)[0];
const pagesSrc = fs.readFileSync(".github/scripts/pages.mjs", "utf8");
const head = new Function("esc", "css", "SITE", `const PLAY = ${JSON.stringify("https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev&referrer=" + encodeURIComponent("utm_source=luchit.app&utm_medium=web&utm_campaign=magazine"))};\n` + headOf(pagesSrc) + "\nreturn head;")(esc, css, SITE);
const foot = `<p class="muted" style="margin-top:28px">מערכת לוחית. הנתונים מגיעים ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, והאתר אינו קשור למשרד התחבורה. <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;

let slugs = {}; try { slugs = JSON.parse(fs.readFileSync("model/slugs.json", "utf8")); } catch {}
const bars = (list, label2) => { const mx = list[0].n; return list.map((x, i) => { const s = label2 && slugFor(x.key); const nm = s ? `<a href="${SITE}model/${s}/">${esc(x.name)}</a>` : esc(x.name); return `<div class="rk"><i>${i + 1}</i><div>${nm}<span class="bar" style="width:${Math.max(4, Math.round(x.n / mx * 100))}%"></span></div><span>${fmt(x.n)}</span></div>`; }).join(""); };

// a trailing % flips in right-to-left text, so prose spells it out
const prPlain = t => esc(t).replace(/(\d+)%/g, "$1 אחוזים");
// link model names that have a model page (model/slugs.json), once per article. The registry spells models differently from the catalogue
// ("MODEL 3" vs "MODEL3", "RAV 4" vs "RAV4", "JAECOO 5 HEV" vs "JAECOO5"), so matching ignores case, spaces and hyphens, and a variant name
// links to its base model when the first words of the variant spell the catalogue name. Works on escaped text that holds no tags yet, so it
// cannot break markup; Hebrew prefix letters (ב, ל, ו, ...) stay outside the link, and longer names win over shorter ones.
const linked = new Set();
const wordsOf = t => String(t).trim().split(/[\s\-]+/).filter(Boolean);
const joinKey = ws => ws.join("").toLowerCase();
const slugEntries = Object.entries(slugs).map(([k, sl]) => { const [mk, md = ""] = k.split("|"); return {mk: joinKey(wordsOf(mk)), md: joinKey(wordsOf(md)), sl}; });
function slugFor(key) {
  const [mk, md] = String(key).split("|"); if (!md) return null;
  const mkk = joinKey(wordsOf(mk)), ws = wordsOf(md); let best = null;
  for (const e of slugEntries) {
    if (e.mk !== mkk || !e.md) continue;
    for (let k = ws.length; k >= 1; k--) if (joinKey(ws.slice(0, k)) === e.md) { if (!best || k > best.k) best = {k, sl: e.sl}; break; }
  }
  return best && best.sl;
}
const normName = t => String(t).replace(/[\s\-]+/g, "").toLowerCase();
const LINKABLE = models.map(m => ({name: esc(m.name), sl: slugFor(m.key)})).filter(x => x.sl).sort((x, y) => y.name.length - x.name.length);
const SLUG_OF = Object.fromEntries(LINKABLE.map(x => [normName(x.name), x.sl]));
const MODEL_RE = LINKABLE.length ? new RegExp(`(?<![\\p{L}\\p{N}])([ובכלמשה]{0,2})(${LINKABLE.map(x => wordsOf(x.name).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\-]*")).join("|")})(?![\\p{L}\\p{N}])`, "giu") : null;
const pr = t => {
  const out = prPlain(t);
  if (!MODEL_RE) return out;
  return out.replace(MODEL_RE, (m, pre, name) => {
    const sl = SLUG_OF[normName(name)];
    if (!sl || linked.has(sl)) return m;
    linked.add(sl);
    return `${pre}<a href="${SITE}model/${sl}/">${name}</a>`;
  });
};
const plain = prPlain;
// Gemini writes the body only: the title always comes from the data (it names the leader), and numbers get thousands separators (never years)
const ai = await gemini(), art = ai || template(), usedAi = !!ai;
if (ai) {
  art.title = template().title;
  const thou = t => t.replace(/(?<![\d,.])\d{4,}(?![\d,.])/g, m => +m === year || +m === year - 1 ? m : fmt(+m));
  for (const f of ["lead", "bodies_p", "ytd_p"]) art[f] = thou(art[f]);
  art.tldr = art.tldr.map(thou); art.faq = art.faq.map(x => ({q: thou(x.q), a: thou(x.a)}));
}
fs.mkdirSync(`magazine/${slug}`, {recursive: true});
const url = `${SITE}magazine/${slug}/`, desc = (art.lead.length <= 200 ? art.lead : art.lead.slice(0, 200).replace(/[^.]*$/, "") || art.lead.slice(0, 200)), published = now.toISOString().slice(0, 10);
const ld = {"@context": "https://schema.org", "@type": "Article", headline: art.title, datePublished: published, inLanguage: "he", author: {"@type": "Organization", name: "מערכת לוחית"}, publisher: {"@type": "Organization", name: "לוחית", url: SITE}, mainEntityOfPage: url};
const faqLd = {"@context": "https://schema.org", "@type": "FAQPage", mainEntity: art.faq.map(x => ({"@type": "Question", name: x.q, acceptedAnswer: {"@type": "Answer", text: x.a}}))};
const crumbLd = items => ({"@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, item], i) => ({"@type": "ListItem", position: i + 1, name, ...(item ? {item} : {})}))});
const ldTag = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const subTop = `<form class="card sub subtop" id="nl-top" novalidate aria-labelledby="nl-top-h"><b id="nl-top-h">המגזין החודשי, ישר למייל</b><div class="row"><input type="email" name="email" placeholder="האימייל שלך" autocomplete="email" inputmode="email" required aria-label="כתובת אימייל"><button type="submit">להרשמה</button></div><div class="hp" aria-hidden="true"><label>אל תמלאו שדה זה<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div><label><input type="checkbox" name="consent" required> אני מסכים/ה לקבל פרסומות ועדכונים מלוחית, כולל המגזין החודשי. אפשר להסיר בכל עת בלחיצה אחת.</label><p class="st" id="nl-top-st" role="status" aria-live="polite"></p></form>`;
const subCard = `<form class="card sub" id="nl" novalidate aria-labelledby="nl-h"><b id="nl-h">המגזין החודשי של לוחית</b><p class="muted">סיכום של שוק הרכב בישראל מנתוני משרד התחבורה, פעם בחודש, ישר למייל.</p><div class="row"><input type="email" name="email" placeholder="האימייל שלך" autocomplete="email" inputmode="email" required aria-label="כתובת אימייל"><button type="submit">להרשמה</button></div><div class="hp" aria-hidden="true"><label>אל תמלאו שדה זה<input type="text" name="website" tabindex="-1" autocomplete="off"></label></div><label><input type="checkbox" name="consent" required> אני מסכים/ה לקבל פרסומות ועדכונים מלוחית, כולל המגזין החודשי. אפשר להסיר בכל עת בלחיצה אחת.</label><p class="st" id="nl-st" role="status" aria-live="polite"></p></form><script>(function(){Array.prototype.forEach.call(document.querySelectorAll("form.sub"),function(f){var st=f.querySelector(".st"),btn=f.querySelector("button");function say(t,c){st.textContent=t;st.className="st "+(c||"")}f.addEventListener("submit",function(e){e.preventDefault();var em=f.email.value.trim();if(!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(em)){say("כתובת האימייל אינה תקינה","er");return}if(!f.consent.checked){say("כדי להירשם יש לאשר את תיבת ההסכמה","er");return}btn.disabled=true;say("שולח...");fetch("/api/subscribe",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({email:em,website:f.website.value,consent:true})}).then(function(r){if(!r.ok)throw 0;say("שלחנו אליכם מייל. לחצו בו על \u201Cאישור הרשמה\u201D כדי להשלים.","ok");f.reset()}).catch(function(){say("משהו השתבש. נסו שוב בעוד רגע.","er")}).then(function(){btn.disabled=false})})})})();var sm=/[?&]subscribed=([a-z0-9]+)/.exec(location.search);if(sm){var m=document.querySelector("main")||document.body,d=document.createElement("div");d.className="subbar";d.setAttribute("role","status");d.textContent=sm[1]==="1"?"ההרשמה אושרה. תודה, נתראה בגיליון הבא.":"הקישור לא תקף או שפג תוקפו. נסו להירשם שוב.";m.insertBefore(d,m.firstChild)}</script>`;
const tldrHtml = `<div class="card tldr"><b>בקצרה</b><ul>${art.tldr.map(t => `<li>${plain(t)}</li>`).join("")}</ul></div>`;
const faqHtml = `<h2>שאלות ותשובות</h2><div class="faq">${art.faq.map(x => `<h3>${plain(x.q)}</h3><p>${plain(x.a)}</p>`).join("")}</div>`;
const hero = `<div class="hero"><small>רכבים פרטיים חדשים שנמסרו</small><strong>${fmt(total)}</strong>${prev && Math.abs(chg) >= 2 ? `<em>${chg > 0 ? "▲" : "▼"} ${pct(chg)}% לעומת ${monthName} אשתקד (${fmt(prev)})</em>` : ""}</div>`;
const body = `${head(art.title + " | לוחית", desc, url, "article").replace("</head>", ldTag(ld) + ldTag(faqLd) + ldTag(crumbLd([["לוחית", SITE], ["מגזין", SITE + "magazine/"], [plain(art.title).replace(/<[^>]+>/g, "")]])) + "</head>")}<p class="muted"><a href="${SITE}">לוחית</a> › <a href="${SITE}magazine/">מגזין</a></p><p><span class="tag">שוק הרכב</span> <span class="muted">${esc(label)}</span></p><h1>${plain(art.title)}</h1>${hero}
${tldrHtml}
${subTop}
<p>${pr(art.lead)}</p>
<h2>הדגמים המובילים</h2><div class="card">${bars(models, true)}</div>
<h2>היצרנים המובילים</h2><div class="card">${bars(makers.map(m => ({...m, key: ""})), false)}</div>
<h2>סוגי מרכב</h2><p>${pr(art.bodies_p)}</p>${art.ytd_p ? `<h2>מתחילת השנה</h2><p>${pr(art.ytd_p)}</p>` : ""}
${faqHtml}
${subCard}
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, הסדרי פשרה, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<p class="muted">מקור הנתונים: מאגרי משרד התחבורה, מסירות של רכבים פרטיים חדשים. ${usedAi ? "הכתבה נכתבה בעזרת מודל שפה על בסיס הנתונים, ונבדקה לפני פרסום." : "הכתבה נוצרה אוטומטית מהנתונים."} פורסם ב-${esc(published)}.</p>${foot}`;
fs.writeFileSync(`magazine/${slug}/index.html`, body);

// index, posts list and sitemap
let posts = []; try { posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); } catch {}
posts = posts.filter(p => p.slug !== slug); posts.push({slug, title: art.title, tag: "שוק הרכב", date: published, month: label, lead: art.lead, models: [...new Set([...body.matchAll(/\/model\/([a-z0-9-]+)\//g)].map(x => x[1]))].sort()});
posts.sort((a, b) => b.slug.localeCompare(a.slug));
fs.writeFileSync("magazine/posts.json", JSON.stringify(posts, null, 1));
const idxUrl = SITE + "magazine/";
fs.writeFileSync("magazine/index.html", `${head("מגזין לוחית: שוק הרכב בישראל", "כתבות חודשיות על שוק הרכב בישראל מנתוני משרד התחבורה: מה נמכר, אילו דגמים ויצרנים מובילים.", idxUrl).replace("</head>", ldTag(crumbLd([["לוחית", SITE], ["מגזין"]])) + "</head>")}<p class="muted"><a href="${SITE}">לוחית</a> › מגזין</p><h1>מגזין לוחית</h1><p class="muted">כתבות על שוק הרכב בישראל, מנתוני משרד התחבורה.</p><div class="card lst">${posts.map(p => `<a href="${SITE}magazine/${p.slug}/"><b>${esc(p.title)}</b><small>${esc(p.tag)} · ${esc(p.month)}</small></a>`).join("")}</div>${subCard}${foot}`);
let sm = fs.readFileSync("sitemap.xml", "utf8");
for (const u of [idxUrl, url]) { sm = sm.replace(new RegExp(`\\s*<url><loc>${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>(<lastmod>[^<]*</lastmod>)?</url>`), ""); sm = sm.replace("</urlset>", `  <url><loc>${u}</loc><lastmod>${published}</lastmod></url>\n</urlset>`); }
fs.writeFileSync("sitemap.xml", sm);
console.log(`magazine ${slug}: ${usedAi ? "gemini" : "template"}, ${posts.length} posts`);
