// Search Console snapshot for the SEO work: 28-day queries/pages, sitemap status and URL Inspection of every sitemap URL.
// The JSON is encrypted with .github/seo-data.pub.pem (RSA-OAEP wrapped AES-256-GCM key), because the repo is public;
// only the holder of the private key (kept outside the repo) can read it. Writes out/seo-data.enc.json.
import crypto from "node:crypto";
import fs from "node:fs";
import { putMetric } from "./flash.mjs";
const SITE = "sc-domain:luchit.app", API = "https://www.googleapis.com/webmasters/v3/sites/" + encodeURIComponent(SITE);
const sa = JSON.parse(process.env.GA_SERVICE_ACCOUNT_JSON || "null");
if (!sa) { console.log("no service account secret"); process.exit(1); }
const b64 = b => Buffer.from(b).toString("base64url");
async function token() {
  const now = Math.floor(Date.now() / 1000), head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/webmasters.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }) });
  if (!r.ok) throw new Error("auth " + r.status);
  return (await r.json()).access_token;
}
const t = await token(), H = { authorization: "Bearer " + t, "content-type": "application/json" };
const errors = [];
async function call(url, body) {
  let r; try { r = await fetch(url, { ...(body ? { method: "POST", body: JSON.stringify(body) } : {}), headers: H, signal: AbortSignal.timeout(30000) }); }
  catch (e) { errors.push(`${e.name} ${url.slice(-60)}`); return null; }
  if (!r.ok) { const e = `${r.status} ${url.slice(-60)}: ${(await r.text()).slice(0, 300)}`; errors.push(e); return null; }
  return r.json();
}
const iso = d => d.toISOString().slice(0, 10);
const end = iso(new Date(Date.now() - 864e5)), start = iso(new Date(Date.now() - 29 * 864e5));
const sa_q = async dims => (await call(API + "/searchAnalytics/query", { startDate: start, endDate: end, dimensions: dims, rowLimit: 5000, dataState: "all" }))?.rows || [];
const out = { generated: new Date().toISOString(), range: [start, end] };
out.byDate = await sa_q(["date"]);
out.byQuery = await sa_q(["query"]);
out.byPage = await sa_q(["page"]);
out.byQueryPage = await sa_q(["query", "page"]);
out.byDevice = await sa_q(["device"]);
out.sitemaps = (await call(API + "/sitemaps"))?.sitemap || [];
// URL Inspection: every sitemap URL (quota 2,000/day, 600/min per property)
const xml = await (await fetch("https://luchit.app/sitemap.xml")).text();
const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
const extra = (process.env.EXTRA_URLS || "").split(",").map(s => s.trim()).filter(Boolean);
out.inspection = [];
const list = [...urls, ...extra], started = Date.now(); let next = 0;
const worker = async () => {
  while (next < list.length && Date.now() - started < 12 * 60 * 1000) {
    const u = list[next++];
    const j = await call("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", { inspectionUrl: u, siteUrl: SITE, languageCode: "he" });
    const s = j?.inspectionResult?.indexStatusResult;
    out.inspection.push(s ? { url: u, verdict: s.verdict, coverage: s.coverageState, indexing: s.indexingState, fetch: s.pageFetchState, robots: s.robotsTxtState,
      lastCrawl: s.lastCrawlTime, crawledAs: s.crawledAs, googleCanonical: s.googleCanonical, userCanonical: s.userCanonical, referrers: s.referringUrls, sitemaps: s.sitemap } : { url: u, error: true });
    if (out.inspection.length % 25 === 0) console.log("inspected", out.inspection.length, "of", list.length);
  }
};
await Promise.all([worker(), worker(), worker(), worker()]);
out.notInspected = list.length - out.inspection.length;
out.errors = errors;
const cov = {}; for (const i of out.inspection) cov[i.coverage || "error"] = (cov[i.coverage || "error"] || 0) + 1;
console.log("rows: queries", out.byQuery.length, "pages", out.byPage.length, "inspected", out.inspection.length, "errors", errors.length);
console.log("coverage (labels only):", JSON.stringify(cov));
const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
const data = Buffer.concat([c.update(JSON.stringify(out)), c.final()]);
const pub = fs.readFileSync(".github/seo-data.pub.pem", "utf8");
const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
fs.mkdirSync("out", { recursive: true });
fs.writeFileSync("out/seo-data.enc.json", JSON.stringify({ v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
// public-safe aggregate for the live dashboard targets: how many sitemap URLs Google reports as indexed (verdict PASS), out of those inspected
// definition: "indexed" = URLs whose URL Inspection API verdict is PASS (Google's index state as of the last crawl). The Search Console
// Pages report counts the same thing but is refreshed only every few days, so it can show a lower number for a while.
const cnt = f => out.inspection.filter(f).length;
await putMetric("index", { indexed: cnt(i => i.verdict === "PASS"), crawledNotIndexed: cnt(i => /^נסרק|^Crawled/.test(i.coverage || "")), unknown: cnt(i => /לא ידועה|unknown to Google/i.test(i.coverage || "")), inspected: out.inspection.length, total: list.length, source: "URL Inspection API" });
