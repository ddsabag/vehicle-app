// mail-dns.mjs: reads luchit.app's public mail records (MX, SPF, DMARC, DKIM for Cloudflare and Brevo) for the ops thread, through two
// public resolvers. DNS only: nothing private is read or printed (a long DKIM key prints as its length, a Brevo verification code as present).
//   Inspect datasets workflow, script mail-dns.mjs
import { Resolver } from "node:dns/promises";
const D = "luchit.app";
const ROWS = [["MX", D], ["TXT", D], ["TXT", "_dmarc." + D], ["CNAME", "brevo1._domainkey." + D], ["CNAME", "brevo2._domainkey." + D],
  ["TXT", "brevo1._domainkey." + D], ["TXT", "brevo2._domainkey." + D], ["TXT", "mail._domainkey." + D], ["TXT", "cf2024-1._domainkey." + D]];
const show = (kind, v) => kind === "TXT" && /^brevo-code:/.test(v) ? "brevo-code:(present)" : v.length > 120 ? `${v.slice(0, 40)}… (${v.length} chars)` : v;
for (const server of ["1.1.1.1", "8.8.8.8"]) {
  const r = new Resolver({ timeout: 5000, tries: 2 }); r.setServers([server]);
  console.log(`== resolver ${server}`);
  for (const [kind, name] of ROWS) {
    let out;
    try {
      out = kind === "MX" ? (await r.resolveMx(name)).sort((a, b) => a.priority - b.priority).map(m => `${m.priority} ${m.exchange}`)
        : kind === "CNAME" ? await r.resolveCname(name) : (await r.resolveTxt(name)).map(x => x.join(""));
    } catch (e) { out = [`(${e.code || e.message})`]; }
    console.log(`${kind.padEnd(5)} ${name}: ${out.map(v => show(kind, v)).join(" | ")}`);
  }
}
