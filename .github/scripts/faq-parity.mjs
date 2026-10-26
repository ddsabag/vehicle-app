// The home FAQ exists three times in index.html: the static <section id="faqSrc"> (what crawlers without JavaScript read; the app reads its
// questions from it, so there is one list to edit), the FAQPage in the head's JSON-LD (must say exactly what the page shows), and nothing else.
// Fails when the JSON-LD questions and answers differ from the static section. `node .github/scripts/faq-parity.mjs`
import fs from "node:fs";
const html = fs.readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const text = s => s.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const sec = (html.match(/<section[^>]*id="faqSrc"[\s\S]*?<\/section>/) || [""])[0];
const page = [...sec.matchAll(/<details class="faq"><summary>([\s\S]*?)<\/summary><p>([\s\S]*?)<\/p><\/details>/g)].map(m => [text(m[1]), text(m[2])]);
let ld = [];
for (const m of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
  const j = JSON.parse(m[1]); for (const n of j["@graph"] || [j]) if (n["@type"] === "FAQPage") ld = n.mainEntity.map(q => [q.name, q.acceptedAnswer.text]);
}
const bad = [];
if (!page.length) bad.push("no static FAQ section (#faqSrc) with <details class=\"faq\"> items");
if (page.length !== ld.length) bad.push(`static FAQ has ${page.length} questions, FAQPage JSON-LD has ${ld.length}`);
page.forEach(([q, a], i) => { if (!ld[i] || ld[i][0] !== q) bad.push(`question ${i + 1} differs: "${q}" vs "${ld[i] && ld[i][0]}"`); else if (ld[i][1] !== a) bad.push(`answer ${i + 1} differs (${q})`); });
if (bad.length) { console.log("::error file=index.html::FAQ parity: " + bad.join("; ")); process.exit(1); }
console.log(`FAQ parity ok: ${page.length} questions in the page and in the FAQPage JSON-LD`);
