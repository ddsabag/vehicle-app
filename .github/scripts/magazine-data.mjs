// Data articles for the magazine beyond the monthly market summary: "recalls" and "offroad", built from model/stats.json
// (written by pages.mjs from modelstats.json and the ministry datasets). Every number in the text comes from that file, no AI prose,
// no causal wording. One article per type per modelstats refresh (slug = type-YYYY-MM of the refresh), so it never repeats.
// run: node .github/scripts/magazine-data.mjs recalls|offroad|newmodels [2026Q2]   (newmodels: a closed calendar quarter, default the latest; PREVIEW=1 writes out/<slug>.html only)
import fs from "node:fs";
const TYPE = process.argv[2], SITE = "https://luchit.app/";
if (!["recalls", "offroad", "newmodels"].includes(TYPE)) { console.error("type must be recalls, offroad or newmodels"); process.exit(1); }
const S = JSON.parse(fs.readFileSync("model/stats.json", "utf8"));
if (!S.updated) { console.error("no update date"); process.exit(2); }
const NM = TYPE === "newmodels" ? await (await import("./new-models.mjs")).newModels(process.argv.find(a => /^\d{4}Q[1-4]$/.test(a))) : null;
if (NM && !NM.closed) { console.error("quarter not closed yet in the data:", NM.Y, "Q" + NM.Q); process.exit(2); }
const MONTHS = ["ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני", "יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"];
const [Y, Mo] = S.updated.split("-").map(Number), label = NM ? NM.label : `${MONTHS[Mo - 1]} ${Y}`, slug = NM ? NM.slug : `${TYPE}-${Y}-${String(Mo).padStart(2, "0")}`;
let posts = []; try { posts = JSON.parse(fs.readFileSync("magazine/posts.json", "utf8")); } catch {}
if (posts.some(p => p.slug === slug)) { console.error("already published:", slug); process.exit(2); }
const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const fmt = n => Math.round(n).toLocaleString("en-US");
const nameOf = m => /^[A-Za-z]/.test(m.label) && String(m.disp).toUpperCase().startsWith(String(m.label).toUpperCase()) ? m.disp : `${m.label} ${m.disp}`;
const big = S.models.filter(m => m.act >= 3000);
const published = new Date().toISOString().slice(0, 10);

// ---- content per type
let title, lead, tag, rows, unit, tldr, faq, sections, intro, listTitle, listHtml;
if (TYPE === "recalls") {
  rows = big.filter(m => m.rcPer > 0).sort((a, b) => b.rcPer - a.rcPer).slice(0, 10);
  const none = big.filter(m => m.rcPer === 0).length, tot = big.length;
  tag = "ריקולים"; unit = "ריקולים לכל 1,000 רכבים";
  title = `ריקולים: ${nameOf(rows[0])} בראש הרשימה ב${label}`;
  lead = `לפי מאגרי משרד התחבורה, ${nameOf(rows[0])} הוא הדגם עם הכי הרבה ריקולים רשומים ביחס לגודל הצי: ${rows[0].rcPer.toFixed(0)} ריקולים לכל 1,000 רכבים פעילים. הרשימה כוללת ${tot} דגמים עם לפחות 3,000 רכבים על הכביש, ו-${none} מהם בלי אף ריקול רשום.`;
  tldr = [`${nameOf(rows[0])} מוביל עם ${rows[0].rcPer.toFixed(0)} ריקולים לכל 1,000 רכבים פעילים.`, `${none} מתוך ${tot} הדגמים הנפוצים בלי ריקול רשום במאגר.`, `ריקול הוא תיקון שהיבואן מבצע בדרך כלל ללא עלות, ולכן מספר גבוה אינו אומר שהדגם מסוכן.`];
  intro = "הנתון מחשב כמה ריקולים רשומים במאגר הריקולים של משרד התחבורה לכל 1,000 רכבים פעילים מהדגם, לפי התאמת דגם ושנתון. הוא מוצג רק לדגמים עם לפחות 3,000 רכבים על הכביש, כדי שדגם קטן לא יעוות את הרשימה.";
  sections = [["איך לקרוא את הרשימה", "<p>יבואן שמדווח וטיפל בריקולים ביסודיות יופיע ברשימה יותר מיבואן שלא דיווח. לכן הרשימה מראה כמה ריקולים רשומים, לא כמה הדגם אמין. כדי לדעת אם לרכב מסוים יש ריקול פתוח, בודקים לפי מספר הרישוי.</p>"], ["מה עושים כשיש ריקול פתוח", `<p>מתאמים תור במרכז שירות מורשה של היבואן ושומרים את אישור התיקון. ריקול שלא תוקן עלול למנוע חידוש רישיון. <a href="${SITE}check/recall/">בדיקת ריקול לפי מספר רכב</a>.</p>`]];
  faq = [[`איזה דגם עם הכי הרבה ריקולים בישראל?`, `לפי מאגרי משרד התחבורה ב${label}, ${nameOf(rows[0])}, עם ${rows[0].rcPer.toFixed(0)} ריקולים רשומים לכל 1,000 רכבים פעילים (דגמים עם לפחות 3,000 רכבים).`], [`האם מספר ריקולים גבוה אומר שהדגם לא אמין?`, "לא בהכרח. הרשימה מראה כמה ריקולים רשומים, וזה תלוי גם בכמה היבואן מדווח ומטפל."], [`איך בודקים אם לרכב יש ריקול?`, "מקלידים את מספר הרישוי בלוחית ורואים את הריקולים הפתוחים מהמאגר של משרד התחבורה."]];
} else if (TYPE === "newmodels") {
  const fresh = NM.models.filter(m => !m.versionOf), vers = NM.models.filter(m => m.versionOf);
  if (!fresh.length && !vers.length) { console.error("no new models in the quarter"); process.exit(2); }
  const qtxt = NM.label.replace(/^הרבעון /, ""), nm = m => `${m.brand} ${m.name}`;
  const price = t => t.lo === Infinity ? "טרם פורסם במחירון" : t.lo === t.hi ? `${fmt(t.lo)} ש"ח` : `${fmt(t.lo)} עד ${fmt(t.hi)} ש"ח`;
  const eng = t => [t.drive, t.hp ? `${t.hp} כ"ס` : ""].filter(Boolean).join(", ") || "-";
  const card = m => `<h3>${esc(nm(m))}</h3><p class="muted">מסירה ראשונה: ${MONTHS[Number(m.first.slice(4)) - 1]} ${m.first.slice(0, 4)}.${m.versionOf ? ` גרסה חדשה של ${esc(m.brand + " " + m.versionOf)}.` : ""}</p>` + (m.trims.length ? `<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse"><thead><tr><th style="text-align:start;padding:4px 6px">רמת גימור</th><th style="text-align:start;padding:4px 6px">מנוע</th><th style="text-align:start;padding:4px 6px">מחיר מחירון</th></tr></thead><tbody>${m.trims.map(t => `<tr><td style="padding:4px 6px;border-top:1px solid var(--line,#ddd)">${esc(t.name)}</td><td style="padding:4px 6px;border-top:1px solid var(--line,#ddd)">${esc(eng(t))}</td><td style="padding:4px 6px;border-top:1px solid var(--line,#ddd)"><bdi>${esc(price(t))}</bdi></td></tr>`).join("")}</tbody></table></div>` : `<p>עדיין אין מספיק מסירות כדי להציג רמות גימור.</p>`);
  rows = []; tag = "דגמים חדשים"; unit = "";
  title = `דגמים חדשים שנמסרו ברבעון ${qtxt}`;
  lead = `ברבעון ${qtxt} נמסרו לראשונה בישראל ${[fresh.length ? `${fresh.length} דגמים חדשים` : "", vers.length ? `${vers.length} גרסאות חדשות של דגמים שכבר נמכרים` : ""].filter(Boolean).join(" ו-")}. כאן רמות הגימור והמחירים שלהן במחירון, לפי מאגרי משרד התחבורה.`;
  tldr = [fresh.length ? `${nm(fresh[0])} הוא הדגם החדש עם הכי הרבה מסירות ברבעון (${fmt(fresh[0].units)} רכבים).` : `${nm(vers[0])} היא הגרסה החדשה עם הכי הרבה מסירות ברבעון (${fmt(vers[0].units)} רכבים).`, "מחיר מחירון הוא המחיר שהיבואן הצהיר עליו, לא מחיר שהקונים משלמים בפועל.", "דגם נחשב חדש אם לא נמסרו ממנו רכבים בישראל מינואר 2022 ועד תחילת הרבעון."];
  intro = `הרשימה כוללת דגמים שנמסרו מהם לפחות 25 רכבים ברבעון. לכל דגם מוצגות רמות הגימור כפי שהן רשומות במאגר, המנוע והמחיר במחירון. רמת גימור שנמסרו ממנה פחות מ-5 רכבים ברבעון אינה מוצגת.`;
  listTitle = ""; listHtml = (fresh.length ? `<h2>דגמים חדשים</h2>${fresh.map(card).join("")}` : "") + (vers.length ? `<h2>גרסאות חדשות של דגמים שכבר נמכרים</h2>${vers.map(card).join("")}` : "");
  sections = [["איך לקרוא את הרשימה", "<p>שמות רמות הגימור נלקחים מקטלוג הדגמים של משרד התחבורה כפי שהם רשומים שם, ולכן לפעמים הם קצרים או שונים מהשם השיווקי. כשיש כמה קודי קטלוג לאותה רמה, מוצג טווח המחירים. הסיווג בין דגם חדש לגרסה חדשה נעשה לפי השם בקטלוג, ולכן ייתכן שדגם מסוים סווג בצורה שונה מזו שהיבואן משתמש בה.</p>"], ["לפני קנייה", `<p>מחיר המחירון אינו מחיר העסקה. כדאי לבדוק מחיר בפועל מול היבואן או הסוכנות, ולבדוק את הרכב הספציפי לפי מספר הרישוי. <a href="${SITE}">בדיקת רכב לפי מספר רישוי</a>.</p>`]];
  faq = [[`אילו דגמים חדשים נמסרו ברבעון ${qtxt}?`, (fresh.length ? fresh.map(nm).join(", ") : "אף דגם חדש לגמרי עם לפחות 25 מסירות") + (vers.length ? `. בנוסף גרסאות חדשות של דגמים קיימים: ${vers.map(nm).join(", ")}.` : ".")], ["מה זה מחיר מחירון?", "המחיר שהיבואן הצהיר עליו בטופס של משרד התחבורה. מחיר העסקה בפועל יכול להיות שונה."], ["מה ההבדל בין דגם חדש לגרסה חדשה?", "דגם חדש הוא דגם שלא נמסרו ממנו רכבים בישראל לפני הרבעון. גרסה חדשה היא דגם שנרשם בשם חדש בקטלוג, אבל קיים כבר דגם באותו שם בסיס, למשל גרסה היברידית או חשמלית."]];
} else {
  rows = big.filter(m => m.offRel !== null).sort((a, b) => b.offRel - a.offRel).slice(0, 10);
  const low = big.filter(m => m.offRel !== null).sort((a, b) => a.offRel - b.offRel)[0];
  tag = "נתוני צי"; unit = "יחס לממוצע השנתון";
  title = `ירדו מהכביש: ${nameOf(rows[0])} מעל הממוצע ב${label}`;
  lead = `לפי מאגרי משרד התחבורה, שיעור הרכבים שירדו מהכביש מדגם ${nameOf(rows[0])} גבוה פי ${rows[0].offRel.toFixed(1)} מהממוצע ברכבים מאותם שנתונים. בקצה השני, ${nameOf(low)} עם פי ${low.offRel.toFixed(1)} בלבד.`;
  tldr = [`${nameOf(rows[0])} הדגם עם שיעור הירידה מהכביש הגבוה ביותר ביחס לשנתונים המקבילים: פי ${rows[0].offRel.toFixed(1)}.`, `${nameOf(low)} בצד הנמוך, עם פי ${low.offRel.toFixed(1)}.`, "ההשוואה נעשית שנתון מול שנתון, כדי שדגם ותיק לא ייראה גרוע רק בגלל גילו."];
  intro = "רכב שירד מהכביש הוא רכב שבוטל סופית ואינו יכול לנסוע. היחס מחשב כמה רכבים מהדגם ירדו, לעומת כמה היו אמורים לרדת אם הדגם היה כמו הממוצע של כל הרכבים הפרטיים מאותם שנתונים. הוא מוצג לדגמים עם לפחות 3,000 רכבים פעילים.";
  sections = [["איך לקרוא את הרשימה", "<p>יחס של 1.0 פירושו כמו הממוצע. הנתון אינו מסביר למה הרכבים ירדו מהכביש, והוא משקף גם החלטות של בעלים, חברות ביטוח ומשווקים.</p>"], ["לפני קנייה", `<p>גם אם הדגם נראה טוב ברשימה, כדאי לבדוק את הרכב הספציפי לפי מספר הרישוי ולוודא שהוא פעיל. <a href="${SITE}check/off-road/">בדיקה אם רכב ירד מהכביש</a>.</p>`]];
  faq = [[`איזה דגם יורד מהכביש הכי הרבה?`, `לפי מאגרי משרד התחבורה ב${label}, ${nameOf(rows[0])}, פי ${rows[0].offRel.toFixed(1)} מהממוצע ברכבים מאותם שנתונים (דגמים עם לפחות 3,000 רכבים פעילים).`], [`מה זה רכב שירד מהכביש?`, "רכב שבוטל סופית ואינו יכול לנסוע. אי אפשר להחזיר אותו לתנועה."], [`איך בודקים אם רכב ירד מהכביש?`, "מקלידים את מספר הרישוי בלוחית, והתוצאה מסמנת רכב לא פעיל בראש הדף."]];
}
const fmtVal = m => TYPE === "recalls" ? m.rcPer.toFixed(0) : "פי " + m.offRel.toFixed(1);
const max = !rows.length ? 1 : TYPE === "recalls" ? rows[0].rcPer : rows[0].offRel;
const val = m => TYPE === "recalls" ? m.rcPer : m.offRel;

// ---- shared page shell (same head/css as the monthly article)
const pagesSrc = fs.readFileSync(".github/scripts/pages.mjs", "utf8"), magSrc = fs.readFileSync(".github/scripts/magazine.mjs", "utf8");
const css = (() => { const base = pagesSrc.match(/const css = `([\s\S]*?)`;/)[1]; const extra = magSrc.match(/const css = [\s\S]*?\+ `([\s\S]*?)` \+ subCss \+ `([\s\S]*?)`;/); const sub = magSrc.match(/const subCss = `([\s\S]*?)`;/)[1]; return base + extra[1] + sub + extra[2]; })();
const head = new Function("esc", "css", "SITE", `const PLAY = ${JSON.stringify("https://play.google.com/store/apps/details?id=com.ddsabag.pratirechev&referrer=" + encodeURIComponent("utm_source=luchit.app&utm_medium=web&utm_campaign=magazine"))};\n` + pagesSrc.match(/const head = [\s\S]*?\n/)[0] + "\nreturn head;")(esc, css, SITE);
const foot = `<p class="muted" style="margin-top:10px">מערכת לוחית. הנתונים מגיעים ממאגרים פתוחים של משרד התחבורה ב-data.gov.il, והאתר אינו קשור למשרד התחבורה. <a href="${SITE}privacy.html">מדיניות פרטיות</a></p></main></body></html>`;
const url = `${SITE}magazine/${slug}/`, desc = lead.length <= 200 ? lead : lead.slice(0, 200).replace(/[^.:]*$/, "") || lead.slice(0, 200);
const prPlain = t => esc(t).replace(/(\d+)%/g, "$1 אחוזים");
const ldTag = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, "\\u003c")}</script>`;
const crumbLd = items => ({"@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: items.map(([name, item], i) => ({"@type": "ListItem", position: i + 1, name, ...(item ? {item} : {})}))});
const ld = {"@context": "https://schema.org", "@type": "Article", headline: title, datePublished: published, inLanguage: "he", author: {"@type": "Organization", name: "מערכת לוחית"}, publisher: {"@type": "Organization", name: "לוחית", url: SITE}, mainEntityOfPage: url};
const faqLd = {"@context": "https://schema.org", "@type": "FAQPage", mainEntity: faq.map(([q, a]) => ({"@type": "Question", name: q, acceptedAnswer: {"@type": "Answer", text: a}}))};
const bars = rows.map((m, i) => `<div class="rk"><i>${i + 1}</i><div><a href="${SITE}model/${m.slug}/">${esc(nameOf(m))}</a><span class="bar" style="width:${Math.max(4, Math.round(val(m) / max * 100))}%"></span></div><span>${fmtVal(m)}</span></div>`).join("");
const body = `${head(title + " | לוחית", desc, url, "article").replace("</head>", ldTag(ld) + ldTag(faqLd) + ldTag(crumbLd([["לוחית", SITE], ["מגזין", SITE + "magazine/"], [title]])) + "</head>")}<p class="muted"><a href="${SITE}">לוחית</a> › <a href="${SITE}magazine/">מגזין</a></p><p><span class="tag">${esc(tag)}</span> <span class="muted">${esc(label)}</span></p><h1>${prPlain(title)}</h1>
<div class="card tldr"><b>בקצרה</b><ul>${tldr.map(t => `<li>${prPlain(t)}</li>`).join("")}</ul></div>
<p>${prPlain(lead)}</p><p>${prPlain(intro)}</p>
${TYPE === "newmodels" ? listHtml : `<h2>עשרת הדגמים הראשונים (${esc(unit)})</h2><div class="card">${bars}</div>`}
${sections.map(([h, t]) => `<h2>${esc(h)}</h2>${t}`).join("")}
<h2>שאלות ותשובות</h2><div class="faq">${faq.map(([q, a]) => `<h3>${prPlain(q)}</h3><p>${prPlain(a)}</p>`).join("")}</div>
<div class="card"><b>בדקו רכב מסוים</b><p class="muted" style="margin:6px 0 12px">הקלידו מספר רישוי וקבלו ריקולים, הסדרי פשרה, טסט, היסטוריית בעלויות ומחיר משוער, בחינם.</p><a class="cta" href="${SITE}">לבדיקה לפי מספר רישוי</a></div>
<p class="muted">מקור הנתונים: מאגרי משרד התחבורה, נכון ל-<bdi>${esc(NM ? MONTHS[NM.latest % 100 - 1] + " " + Math.floor(NM.latest / 100) : S.updated.split("-").reverse().join("."))}</bdi>. הכתבה נוצרה אוטומטית מהנתונים. פורסם ב-<bdi>${esc(published.split("-").reverse().join("."))}</bdi>.</p>${foot}`;
if (process.env.PREVIEW) { fs.mkdirSync("out", {recursive: true}); fs.writeFileSync(`out/${slug}.html`, body); console.log("preview written: out/" + slug + ".html", body.length, "bytes"); process.exit(0); }
fs.mkdirSync(`magazine/${slug}`, {recursive: true}); fs.writeFileSync(`magazine/${slug}/index.html`, body);

// posts list, magazine index and sitemap (same layout as magazine.mjs)
posts.push({slug, title, tag, date: published, month: label, lead, models: rows.map(m => m.slug).sort()});
posts.sort((a, b) => b.date.localeCompare(a.date) || b.slug.localeCompare(a.slug));
fs.writeFileSync("magazine/posts.json", JSON.stringify(posts, null, 1));
const idx = fs.readFileSync("magazine/index.html", "utf8");
const lst = `<div class="card lst">${posts.map(p => `<a href="${SITE}magazine/${p.slug}/"><b>${esc(p.title)}</b><small>${esc(p.tag)} · ${esc(p.month)}</small></a>`).join("")}</div>`;
fs.writeFileSync("magazine/index.html", idx.replace(/<div class="card lst">[\s\S]*?<\/div>(?=<form)/, lst));
let sm = fs.readFileSync("sitemap.xml", "utf8");
for (const u of [SITE + "magazine/", url]) { sm = sm.replace(new RegExp(`\\s*<url><loc>${u.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</loc>(<lastmod>[^<]*</lastmod>)?</url>`), ""); sm = sm.replace("</urlset>", `  <url><loc>${u}</loc><lastmod>${published}</lastmod></url>\n</urlset>`); }
fs.writeFileSync("sitemap.xml", sm);
console.log("published", slug);
