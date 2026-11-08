// The site footer, one source for every page (8.11.2026, Dudu "מאשר" to the CEO thread's layout): the brand line and the social
// pages, three groups of links (בדיקת רכב, לוחית, מידע משפטי), the 20 common models as a visible grid, and the page's own data-source
// line with the copyright. pages.mjs (and landing.mjs through it), magazine.mjs and magazine-data.mjs call siteFooter(); index.html,
// business/, privacy.html, accessibility/, terms/ and 404 carry the same markup (apply-footer.mjs writes it into the checked-in pages).
// Colours are the footer's own tokens, so it reads the same on pages with different palettes, in both themes; every link is >= 44 px tall.
export const SOC = "<a href=\"https://www.tiktok.com/@luchit.app\" target=\"_blank\" rel=\"noopener me\" data-soc=\"tiktok\" aria-label=\"לוחית בטיקטוק\" title=\"לוחית בטיקטוק\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><path fill=\"currentColor\" d=\"M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z\"/></svg></a><a href=\"https://www.instagram.com/luchit.app/\" target=\"_blank\" rel=\"noopener me\" data-soc=\"instagram\" aria-label=\"לוחית באינסטגרם\" title=\"לוחית באינסטגרם\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"4.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"17.3\" cy=\"6.7\" r=\"1.3\" fill=\"currentColor\"/></svg></a><a href=\"https://www.facebook.com/profile.php?id=61595507021640\" target=\"_blank\" rel=\"noopener me\" data-soc=\"facebook\" aria-label=\"לוחית בפייסבוק\" title=\"לוחית בפייסבוק\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><path fill=\"currentColor\" d=\"M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z\"/></svg></a>";
export const MODELS = [["corolla-413/", "טויוטה קורולה"], ["picanto-885/", "קיה פיקנטו"], ["mazda3-588/", "מזדה 3"], ["sportage-416/", "קיה ספורטאז׳"], ["octavia-676/", "סקודה אוקטביה"], ["tucson-253/", "יונדאי טוסון"], ["outlander-590/", "מיצובישי אאוטלנדר"], ["i10-845/", "יונדאי i10"], ["i20-845/", "יונדאי i20"], ["yaris-672/", "טויוטה יאריס"], ["mazda2-139/", "מזדה 2"], ["rav4-413/", "טויוטה RAV4"], ["ioniq-481/", "יונדאי איוניק"], ["ibiza-778/", "סיאט איביזה"], ["kona-481/", "יונדאי קונה"], ["i30-253/", "יונדאי i30"], ["elantra-481/", "יונדאי אלנטרה"], ["focus-730/", "פורד פוקוס"], ["civic-155/", "הונדה סיוויק"], ["qashqai-637/", "ניסאן קשקאי"]];
export const DISCLAIMER = 'המידע מגיע מהמאגרים הפתוחים של משרד התחבורה ב-<a href="https://data.gov.il/" target="_blank" rel="noopener">data.gov.il</a>, ואינו מחליף נסח רישום רשמי או בדיקה במכון מורשה. לוחית אינה קשורה למשרד התחבורה או לגוף ממשלתי.';
export const FOOTER_CSS = `.ft{--ft-fg:#151a24;--ft-mu:#4a5465;--ft-ln:#dfe4ec;--ft-ac:#2457c5;max-width:1080px;margin:28px auto 0;padding:20px 16px 28px;border-top:1px solid var(--ft-ln);font-size:.9rem;line-height:1.6;color:var(--ft-mu);box-sizing:border-box;text-align:start}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ft{--ft-fg:#e9edf3;--ft-mu:#aab3c3;--ft-ln:#2b3444;--ft-ac:#7ea3f2}}
:root[data-theme="dark"] .ft{--ft-fg:#e9edf3;--ft-mu:#aab3c3;--ft-ln:#2b3444;--ft-ac:#7ea3f2}
.ft a{color:var(--ft-ac);text-decoration:none}.ft a:hover{text-decoration:underline}.ft a:focus-visible{outline:3px solid var(--ft-ac);outline-offset:2px;border-radius:4px}
.ft-top{display:grid;gap:20px}.ft-brand b{display:block;color:var(--ft-fg);font-size:1.15rem}.ft-brand p{margin:2px 0 6px;max-width:32ch}
.ft .soc{display:flex;gap:4px;margin:0;margin-inline-start:-12px}.ft .soc a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;color:var(--ft-fg);padding:0}
.ft-cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 20px}
.ft h2{margin:0 0 2px;font-size:.8rem;font-weight:700;color:var(--ft-fg);line-height:1.4}
.ft ul{list-style:none;margin:0;padding:0}.ft li{margin:0;padding:0}
.ft-cols li a,.ft-mdl li a{display:inline-flex;align-items:center;min-height:44px;font-weight:600}
.ft-mdl{margin-top:16px;border-top:1px solid var(--ft-ln);padding-top:14px}
.ft-mdl ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px}.ft-mdl li a{font-weight:400}
.ft-legal{margin:12px 0 0;border-top:1px solid var(--ft-ln);padding-top:12px;font-size:.8rem;line-height:1.55}.ft-legal>span{display:block}.ft-legal a{display:inline;min-height:0}
@media (min-width:760px){.ft-top{grid-template-columns:minmax(0,1.1fr) minmax(0,3fr);gap:32px}.ft-cols{grid-template-columns:repeat(3,minmax(0,1fr))}.ft-mdl ul{grid-template-columns:repeat(5,minmax(0,1fr))}.ft-legal{display:flex;justify-content:space-between;gap:24px}}`;
const year = 2026;
// base: "" for pages beside index.html (relative links, as its footer), "/" for the static pages, the SITE url for generated pages
export function siteFooter({ base = "/", disclaimer = DISCLAIMER, app = false } = {}) {
  const a = (p, t) => `<li><a href="${base}${p}">${t}</a></li>`;
  // the footer brings its own style, so the pages keep their heads as they are (magazine*.mjs rebuild pages.mjs's head from its source)
  return `<style>${FOOTER_CSS}</style><footer class="ft">
<div class="ft-top">
<div class="ft-brand"><b>לוחית</b><p>בדיקת רכב לפי מספר רישוי, מהנתונים הפתוחים של משרד התחבורה.</p><div class="soc" id="soc" aria-label="לוחית ברשתות">${SOC}</div></div>
<nav class="ft-cols" aria-label="קישורים באתר" id="mdlLink">
<div><h2>בדיקת רכב</h2><ul>${a("check/", "מה אפשר לבדוק")}${a("guide/buy-used-car/", "מדריך לקונה")}${a("model/", "דגמים נפוצים בישראל")}</ul></div>
<div><h2>לוחית</h2><ul>${a("magazine/", "מגזין")}${a("business/", "לעסקים")}<li><a href="mailto:support@luchit.app">יצירת קשר</a></li></ul></div>
<div><h2>מידע משפטי</h2><ul>${a("terms/", "תנאי שימוש")}${a("privacy.html", "מדיניות פרטיות")}${a("accessibility/", "הצהרת נגישות")}</ul></div>
</nav>
</div>
<section class="ft-mdl" aria-label="דגמים נפוצים" id="ftModels"><h2>דגמים נפוצים</h2><ul>${MODELS.map(([p, t]) => a("model/" + p, t)).join("")}</ul></section>
<p class="ft-legal"><span class="ft-l">${disclaimer}</span><span>© ${year} לוחית</span></p>
</footer>`;
}
