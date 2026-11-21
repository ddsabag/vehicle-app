// The site footer, one source for every page (8.11.2026, Dudu "מאשר" to the CEO thread's layout): the brand line and the social
// pages, three groups of links (בדיקת רכב, לוחית, מידע משפטי), the 20 common models (since 11.11.2026 behind "דגמים נפוצים", a <details> that opens; the footer was 1,100 px tall on a phone), and the page's own data-source
// line with the copyright. pages.mjs (and landing.mjs through it), magazine.mjs and magazine-data.mjs call siteFooter(); index.html,
// business/, privacy.html, accessibility/, terms/ and 404 carry the same markup (apply-footer.mjs writes it into the checked-in pages).
// Colours are the footer's own tokens, so it reads the same on pages with different palettes, in both themes; every link is >= 44 px tall.
export const SOC = "<a href=\"https://www.tiktok.com/@luchit.app\" target=\"_blank\" rel=\"noopener me\" data-soc=\"tiktok\" aria-label=\"לוחית בטיקטוק\" title=\"לוחית בטיקטוק\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><path fill=\"currentColor\" d=\"M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z\"/></svg></a><a href=\"https://www.instagram.com/luchit.app/\" target=\"_blank\" rel=\"noopener me\" data-soc=\"instagram\" aria-label=\"לוחית באינסטגרם\" title=\"לוחית באינסטגרם\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><rect x=\"3\" y=\"3\" width=\"18\" height=\"18\" rx=\"5\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"12\" cy=\"12\" r=\"4.2\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\"/><circle cx=\"17.3\" cy=\"6.7\" r=\"1.3\" fill=\"currentColor\"/></svg></a><a href=\"https://www.facebook.com/profile.php?id=61595507021640\" target=\"_blank\" rel=\"noopener me\" data-soc=\"facebook\" aria-label=\"לוחית בפייסבוק\" title=\"לוחית בפייסבוק\"><svg viewBox=\"0 0 24 24\" width=\"18\" height=\"18\" aria-hidden=\"true\" focusable=\"false\"><path fill=\"currentColor\" d=\"M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z\"/></svg></a>";
export const MODELS = [["corolla-413/", "טויוטה קורולה"], ["picanto-885/", "קיה פיקנטו"], ["mazda3-588/", "מזדה 3"], ["sportage-416/", "קיה ספורטאז׳"], ["octavia-676/", "סקודה אוקטביה"], ["tucson-253/", "יונדאי טוסון"], ["outlander-590/", "מיצובישי אאוטלנדר"], ["i10-845/", "יונדאי i10"], ["i20-845/", "יונדאי i20"], ["yaris-672/", "טויוטה יאריס"], ["mazda2-139/", "מזדה 2"], ["rav4-413/", "טויוטה RAV4"], ["ioniq-481/", "יונדאי איוניק"], ["ibiza-778/", "סיאט איביזה"], ["kona-481/", "יונדאי קונה"], ["i30-253/", "יונדאי i30"], ["elantra-481/", "יונדאי אלנטרה"], ["focus-730/", "פורד פוקוס"], ["civic-155/", "הונדה סיוויק"], ["qashqai-637/", "ניסאן קשקאי"]];
export const DISCLAIMER = 'המידע מגיע מהמאגרים הפתוחים של משרד התחבורה ב-<a href="https://data.gov.il/" target="_blank" rel="noopener">data.gov.il</a>, ואינו מחליף נסח רישום רשמי או בדיקה במכון מורשה. לוחית אינה קשורה למשרד התחבורה או לגוף ממשלתי.';
export const FOOTER_CSS = `.ft{--ft-fg:#151a24;--ft-mu:#4a5465;--ft-ln:#dfe4ec;--ft-ac:#2457c5;max-width:1080px;margin:28px auto 0;padding:18px 16px 24px;border-top:1px solid var(--ft-ln);font-size:.9rem;line-height:1.5;color:var(--ft-mu);box-sizing:border-box;text-align:start}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .ft{--ft-fg:#e9edf3;--ft-mu:#aab3c3;--ft-ln:#2b3444;--ft-ac:#7ea3f2}}
:root[data-theme="dark"] .ft{--ft-fg:#e9edf3;--ft-mu:#aab3c3;--ft-ln:#2b3444;--ft-ac:#7ea3f2}
.ft a{color:var(--ft-fg);text-decoration:none}.ft a:hover{color:var(--ft-ac);text-decoration:underline}.ft a:focus-visible,.ft summary:focus-visible{outline:3px solid var(--ft-ac);outline-offset:2px;border-radius:4px}
.ft-top{display:grid;gap:14px}
.ft-brand{display:flex;flex-wrap:wrap;align-items:center;column-gap:12px}.ft-brand b{flex:1;color:var(--ft-fg);font-size:1.15rem}.ft-brand p{order:3;flex-basis:100%;margin:0;max-width:40ch}
.ft .soc{display:flex;gap:0;margin:0;margin-inline-end:-10px}.ft .soc a{display:inline-flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;color:var(--ft-mu);padding:0}.ft .soc a:hover{color:var(--ft-ac)}
.ft-cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 12px;border-top:1px solid var(--ft-ln);padding-top:12px}
.ft h2{margin:0;font-size:.75rem;font-weight:700;color:var(--ft-mu);line-height:1.4;letter-spacing:.01em}
.ft ul{list-style:none;margin:0;padding:0}.ft li{margin:0;padding:0}
.ft-cols li a,.ft-mdl li a{display:flex;align-items:center;min-height:44px;font-size:.875rem;font-weight:500;line-height:1.25}
.ft-mdl{margin-top:8px;border-top:1px solid var(--ft-ln)}
.ft-mdl summary{display:flex;align-items:center;justify-content:space-between;min-height:48px;cursor:pointer;list-style:none;color:var(--ft-fg);font-weight:600;font-size:.875rem}.ft-mdl summary::-webkit-details-marker{display:none}
.ft-mdl summary::after{content:"";width:8px;height:8px;border:solid var(--ft-mu);border-width:0 2px 2px 0;transform:rotate(45deg);margin:0 6px 4px}.ft-mdl[open] summary::after{transform:rotate(-135deg);margin-bottom:-4px}
.ft-mdl ul{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 16px;padding-bottom:8px}.ft-mdl li a{font-weight:400;color:var(--ft-mu)}
.ft-legal{margin:0;border-top:1px solid var(--ft-ln);padding-top:12px;font-size:.78rem;line-height:1.55}.ft-legal>span{display:block}.ft-legal>span+span{margin-top:4px}.ft-legal a{display:inline;min-height:0;color:var(--ft-ac);text-decoration:underline}
@media (min-width:760px){.ft{padding-top:24px}.ft-top{grid-template-columns:minmax(0,1.1fr) minmax(0,3fr);gap:32px}.ft-brand{align-content:start}.ft-cols{border-top:0;padding-top:0}.ft-mdl ul{grid-template-columns:repeat(5,minmax(0,1fr))}.ft-legal{display:flex;justify-content:space-between;gap:24px}.ft-legal>span+span{margin-top:0;white-space:nowrap}}`;
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
<details class="ft-mdl" id="ftModels"><summary>דגמים נפוצים</summary><ul aria-label="דגמים נפוצים">${MODELS.map(([p, t]) => a("model/" + p, t)).join("")}</ul></details>
<p class="ft-legal"><span class="ft-l">${disclaimer}</span><span>© ${year} לוחית</span></p>
</footer>`;
}

// The site header, one source as the footer (review 12.11 F5: legal and business pages had no header, or a smaller one): the logo with the
// name and the "לבדיקת רכב" button. pages.mjs and landing.mjs write the same markup; apply-header.mjs writes it into the pages kept by hand.
// It brings its own style and colours (the pages' palettes differ), the same rules the generated pages carry in their heads.
export const HEADER_CSS = `header.top{background:linear-gradient(180deg,#e2ecfd,#fff);border-bottom:1px solid #e3e7ee}header.top .in{max-width:720px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px}header.top .brand{display:flex;align-items:center;gap:10px;color:#151a24;text-decoration:none}header.top img{border-radius:22%}header.top .nm{display:flex;flex-direction:column;line-height:1.15}header.top b{font-size:1.45rem;font-weight:800}header.top small{font-size:.78rem;font-weight:600;color:#5d6676}header.top .chk{display:inline-flex;align-items:center;min-height:44px;box-sizing:border-box;background:#2556c8;color:#fff;border-radius:10px;padding:9px 14px;font-weight:700;font-size:.9rem;text-decoration:none;white-space:nowrap}header.top a:focus-visible{outline:3px solid #2457c5;outline-offset:2px}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) header.top{background:linear-gradient(180deg,#182338,#121722);border-color:#2b3444}:root:not([data-theme="light"]) header.top .brand{color:#fff}:root:not([data-theme="light"]) header.top small{color:#8d98ad}:root:not([data-theme="light"]) header.top a:focus-visible{outline-color:#7ea3f2}}
:root[data-theme="dark"] header.top{background:linear-gradient(180deg,#182338,#121722);border-color:#2b3444}:root[data-theme="dark"] header.top .brand{color:#fff}:root[data-theme="dark"] header.top small{color:#8d98ad}`;
// style false: the generated pages, whose heads carry these rules (and the magazine's own colours after them)
export function siteHeader({ base = "https://luchit.app/", style = true } = {}) {
  return `${style ? `<style>${HEADER_CSS}</style>` : ""}<header class="top"><div class="in"><a class="brand" href="${base}"><img src="${base}icon-512.png" alt="" width="44" height="44"><span class="nm"><b>לוחית</b><small>בדיקת רכב לפי מספר רישוי</small></span></a><a class="chk" href="${base}">לבדיקת רכב</a></div></header>`;
}

// The plate field of the site's forms looks like the app's yellow plate, with the blue IL strip (review 12.11 F9). The strip is drawn in
// the field's background, so the forms' markup stays as it is. It stays yellow in both themes, as the app's.
const IL = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="34" height="60" viewBox="0 0 34 60"><rect width="34" height="60" fill="#1d4ea8"/><text x="17" y="50" font-family="Arial,sans-serif" font-size="12" font-weight="700" fill="#fff" text-anchor="middle">IL</text></svg>`).replace(/'/g, "%27");
export const PF_INPUT = `form.pf input{flex:1;min-width:0;box-sizing:border-box;min-height:54px;font-family:inherit;font-size:1.35rem;font-weight:700;padding:6px 10px 6px 44px;border:3px solid #0b0b0b;border-radius:9px;background:#f6c500 url("${IL}") left center/34px 100% no-repeat;color:#111;direction:ltr;text-align:center;letter-spacing:.05em}form.pf input::placeholder{color:rgba(0,0,0,.42);font-size:1.05rem;font-weight:600}form.pf input:focus-visible{outline:3px solid #2457c5;outline-offset:2px}`;
