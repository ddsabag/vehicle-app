// Cloudflare Web Analytics page count for the static pages (models, brands, topics, magazine, guide), and no Play line on iPhone.
// Same token and opt-out as the home page: nothing loads inside the Android app or after "analyticsOff" was set in the settings.
(function () {
  // Dudu's website plan of 23.10: no Google Play pointers on iPhone or iPad. The app page hides its own the same way (IS_IOS in index.html);
  // here the one Play line under the header of every static page (p.gp) is hidden. Googlebot (an Android user agent) still sees it.
  try {
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)) {
      var st = document.createElement("style"); st.textContent = "p.gp{display:none}"; document.head.appendChild(st);
    }
  } catch (e) {}
  if (window.AndroidApp) return;
  // a campaign link that lands on one of these pages (utm_source=newsletter on a magazine article) is kept for the visit, as the home page keeps
  // its own (FT in index.html), so the car checks that follow on the home page count under that source. First link wins; no identifier
  try {
    var q = new URLSearchParams(location.search), clean = function (k, n) { return (q.get(k) || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, n); };
    var alias = {fb: "facebook", ig: "instagram", yt: "youtube", wa: "whatsapp", li: "linkedin", tt: "tiktok", mail: "newsletter", email: "newsletter"};
    var k = (q.get("utm_source") || "").toLowerCase().replace(/[^a-z]/g, "").slice(0, 12), src = alias[k] || k;
    if (src && src !== "share" && src !== "luchitapp" && !sessionStorage.getItem("ft")) sessionStorage.setItem("ft", JSON.stringify({s: src, m: clean("utm_medium", 12) || "web", c: clean("utm_campaign", 24)}));
  } catch (e) {}
  // the Play links on these pages carry their page type (utm_campaign=model_page, magazine); a visitor who came from a campaign keeps it, so an
  // install from here counts under that source (deep audit 22.11, M59): source, medium and campaign from the arrival, the page type as content
  try {
    var ft = JSON.parse(sessionStorage.getItem("ft") || "null");
    if (ft && ft.s) for (var as = document.querySelectorAll('a[href*="play.google.com/store/apps/details"]'), i = 0; i < as.length; i++) {
      var u = new URL(as[i].href), r = new URLSearchParams(u.searchParams.get("referrer") || ""), page = r.get("utm_campaign") || "";
      var n = new URLSearchParams({utm_source: ft.s, utm_medium: ft.m || "web", utm_campaign: ft.c || page});
      if (page) n.set("utm_content", page);
      u.searchParams.set("referrer", n.toString()); as[i].href = u.toString();
    }
  } catch (e) {}
  try { if (location.protocol !== "https:" || localStorage.getItem("analyticsOff") === "1") return; } catch (e) { return; }
  var s = document.createElement("script");
  s.defer = true;
  s.src = "https://static.cloudflareinsights.com/beacon.min.js";
  s.setAttribute("data-cf-beacon", '{"token":"9bb0e756882c478a808d95596e0deade"}');
  document.head.appendChild(s);
})();
