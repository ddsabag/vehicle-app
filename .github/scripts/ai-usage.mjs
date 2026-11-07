// What the bots spend on the Claude API this credit cycle (ops; Dudu 1.11.2026 21:16 UTC: a router alert at 80% of the credit; 22:50 UTC:
// the Console shows a promotional credit, $71.84 of $100 left, expiring 20.11.2026, so the cycle follows the grant, see GRANTS). claude.mjs calls record() after every reply it gets (ask, and each finished batch request at half price), so every
// bot on the shared helper is counted without code of its own. The total lives on branch ai-usage in usage.enc.json:
//   s: the running total, AES-GCM with a key derived from ANTHROPIC_API_KEY (only a bot that holds the key reads it back to add to it);
//   p: the same, sealed with the seo-data public key, for the threads (decrypt.mjs in the project folder).
// The repo is public: no cost, count or model ever reaches a log. A bot without GITHUB_TOKEN/GITHUB_REPOSITORY or without write access,
// a write that loses five races, or a rotated key (the old total cannot be read: the cycle starts again from zero) leaves the count low,
// never the bot broken: record() never throws. Workers (luchit-reviews) are not counted here: well under $1 a month, inside the 20% margin.
// Prices per million tokens (platform docs, 1.11.2026): cache writes 1.25x input, cache reads as listed, a batch request half price.
// Server web search: $10 per 1,000 searches (usage.server_tool_use.web_search_requests; a batch's summed usage carries it flat as
// web_search_requests), never halved, so the count is not low (credits thread 7.11.2026: competitor check, settlements, the specs pilot).
//   price(model, usage, {batch})   USD of one reply
//   cycle(now)                     the credit cycle's id: a grant's id while it runs, else "YYYY-MM-20" (monthly from the 20th)
//   budget(now, env)               {cycle, cap, until}: a grant's dollars left when it was entered, else AI_CAP_USD (default 100)
//   record(model, usage, opt)      add one reply to the total; at 80% of the cycle's cap the router gets ai:spend once a cycle
//   remaining(opt)                 {cycle, used, cap, left, until} read back with the key (for a bot sizing a big run, e.g. data's last deep
//                                  audit on 18.11), or null; never print it in a public log
//   node ai-usage.mjs --selftest   offline
import crypto from "node:crypto";
import fs from "node:fs";

export const PRICES = {   // input, output, cache read
  "claude-opus-5-5": [4, 20, 0.2], "claude-sonnet-5-5": [2, 10, 0.2], "claude-haiku-5-5": [0.1, 0.5, 0.01],
};
export const SEARCH_USD = 0.01;   // one server web search
const FALLBACK = PRICES["claude-opus-5-5"];   // an unknown model counts at the highest price, so the alert never comes late
export function price(model, u = {}, { batch = false } = {}) {
  const [i, o, r] = PRICES[String(model || "").replace(/\[.*\]$/, "")] || FALLBACK;
  const usd = ((u.input_tokens || 0) * i + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.cache_read_input_tokens || 0) * r + (u.output_tokens || 0) * o) / 1e6;
  const search = ((u.server_tool_use && u.server_tool_use.web_search_requests) || u.web_search_requests || 0) * SEARCH_USD;
  return (batch ? usd / 2 : usd) + search;
}
// A known credit grant: from = when its balance was read (left = what the Console showed then, so spend before it is already inside),
// until = when it expires. Dudu 1.11.2026 22:50 UTC: "$71.84 of $100.00 ... Expires on 11/20/2026". A new grant: add a line here.
// A re-base on a Console balance (credits thread 7.11.2026: the count missed web search fees and the specs pilot): add a line with a new
// id, from = when Dudu read the balance, left = that balance, the same until. The line with the latest from that has begun wins, so the
// cycle starts again from zero there (calls between that time and the commit are left out: commit it soon after the read).
export const GRANTS = [{ id: "g-2026-11-01", from: "2026-11-01T22:50:00Z", until: "2026-11-20T00:00:00Z", left: 71.84 },
  { id: "g-2026-11-07", from: "2026-11-07T08:20:00Z", until: "2026-11-20T00:00:00Z", left: 47.2 }];   // re-base: Dudu 7.11 08:20 UTC, Console "נשאר 47.2$" (data thread)
const grantAt = (now, list = GRANTS) => list.filter(g => now >= new Date(g.from) && now < new Date(g.until)).sort((a, b) => new Date(b.from) - new Date(a.from))[0];
export function cycle(now = new Date(), list = GRANTS) {
  const g = grantAt(now, list); if (g) return g.id;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 20));
  if (now.getUTCDate() < 20) d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
}
export function budget(now = new Date(), env = process.env, list = GRANTS) {
  const g = grantAt(now, list);
  if (g) return { cycle: g.id, cap: g.left, until: g.until };
  const c = cycle(now), u = new Date(c + "T00:00:00Z"); u.setUTCMonth(u.getUTCMonth() + 1);
  return { cycle: c, cap: +(env.AI_CAP_USD || 100), until: u.toISOString() };
}
const keyOf = k => crypto.createHmac("sha256", String(k)).update("luchit-ai-usage").digest();
export function lock(obj, k) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", keyOf(k), iv), d = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString("base64")).join(".");
}
export function unlock(s, k) {
  try { const [iv, tag, d] = String(s).split(".").map(x => Buffer.from(x, "base64")); const c = crypto.createDecipheriv("aes-256-gcm", keyOf(k), iv); c.setAuthTag(tag);
    return JSON.parse(Buffer.concat([c.update(d), c.final()]).toString("utf8")); } catch { return null; }
}
function seal(obj, pem) {
  const k = crypto.randomBytes(32), iv = crypto.randomBytes(12), ci = crypto.createCipheriv("aes-256-gcm", k, iv), data = Buffer.concat([ci.update(JSON.stringify(obj)), ci.final()]);
  const ek = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, k);
  return { v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: ci.getAuthTag().toString("base64"), data: data.toString("base64") };
}

// the new total from the old one (pure, for the selftest): a new cycle starts from zero; crossed = 80 when this reply crossed 80% of the cap
export function add(old, { usd, bot, now = new Date(), cap = 100, until = "" }) {
  const c = cycle(now), t = old && old.cycle === c ? old : { cycle: c, usd: 0, calls: 0, by: {}, told: [] };
  t.cap = cap; t.until = until;
  const before = t.usd;
  t.usd = Math.round((t.usd + usd) * 1e6) / 1e6; t.calls++; t.by[bot] = Math.round(((t.by[bot] || 0) + usd) * 1e6) / 1e6; t.at = now.toISOString();
  const crossed = before < 0.8 * cap && t.usd >= 0.8 * cap && !t.told.includes(80) ? 80 : 0;
  if (crossed) t.told.push(80);
  return { t, crossed, fresh: t.usd === Math.round(usd * 1e6) / 1e6 && t.calls === 1 };
}

const BRANCH = "ai-usage", FILE = "usage.enc.json";
const ilDay = iso => { const d = new Date(new Date(iso) - 1); return `${d.getUTCDate()}.${d.getUTCMonth() + 1}`; };   // the last day the credit still works
export async function remaining({ env = process.env, fetcher = fetch, now = new Date() } = {}) {
  try {
    const tok = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY, key = env.ANTHROPIC_API_KEY; if (!tok || !repo || !key) return null;
    const g = await fetcher(`https://api.github.com/repos/${repo}/contents/${FILE}?ref=${BRANCH}`, { headers: { authorization: "Bearer " + tok, accept: "application/vnd.github+json" } });
    const b = budget(now, env);
    if (g.status === 404) return { cycle: b.cycle, used: 0, cap: b.cap, left: b.cap, until: b.until };
    if (!g.ok) return null;
    const t = unlock(JSON.parse(Buffer.from((await g.json()).content, "base64").toString("utf8")).s, key);
    const used = t && t.cycle === b.cycle ? t.usd : 0;
    return { cycle: b.cycle, used, cap: b.cap, left: Math.round((b.cap - used) * 100) / 100, until: b.until };
  } catch { return null; }
}
export async function record(model, u, { batch = false, env = process.env, fetcher = fetch, now = new Date() } = {}) {
  try {
    const usd = price(model, u, { batch }), tok = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY, key = env.ANTHROPIC_API_KEY;
    if (!usd || !tok || !repo || !key) return { ok: false, why: "not counted here" };
    const api = `https://api.github.com/repos/${repo}`, H = { authorization: "Bearer " + tok, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const { cap, until } = budget(now, env), bot = String(env.GITHUB_WORKFLOW || "local").slice(0, 60);
    let pem = ""; try { pem = fs.readFileSync(new URL("../seo-data.pub.pem", import.meta.url), "utf8"); } catch {}
    for (let i = 0; i < 5; i++) {
      const g = await fetcher(`${api}/contents/${FILE}?ref=${BRANCH}`, { headers: H });
      let sha, old = null;
      if (g.ok) { const j = await g.json(); sha = j.sha; try { old = unlock(JSON.parse(Buffer.from(j.content, "base64").toString("utf8")).s, key); } catch {} }
      else if (g.status === 404) {   // first count ever: the branch starts from main's first commit, with this file only
        const m = await fetcher(`${api}/git/ref/heads/${BRANCH}`, { headers: H });
        if (m.status === 404) {
          const main = await (await fetcher(`${api}/git/ref/heads/main`, { headers: H })).json();
          await fetcher(`${api}/git/refs`, { method: "POST", headers: H, body: JSON.stringify({ ref: "refs/heads/" + BRANCH, sha: main.object.sha }) });
        }
      } else return { ok: false, why: "read " + g.status };
      const { t, crossed } = add(old, { usd, bot, now, cap, until });
      const body = JSON.stringify({ v: 1, s: lock(t, key), ...(pem ? { p: seal(t, pem) } : {}) });
      const p = await fetcher(`${api}/contents/${FILE}`, { method: "PUT", headers: H,
        body: JSON.stringify({ message: "AI usage", branch: BRANCH, content: Buffer.from(body).toString("base64"), ...(sha ? { sha } : {}) }) });
      if (p.ok) {
        if (crossed) try { const r = await import("./alert.mjs");
          await r.alert("day", "ai:spend", `💳 <b>קרדיט ה-Claude API: הבוטים השתמשו ב-80% מהקרדיט של המחזור</b>\nהמחזור נגמר ב-${ilDay(until)}. כשנגמר הקרדיט הבוטים ממשיכים בלי Claude, כמו לפני.`, "", { today: "loud" });
        } catch { /* the threads still read the total */ }
        return { ok: true, crossed };
      }
      if (![409, 422].includes(p.status)) return { ok: false, why: "write " + p.status };   // 409/422: another bot wrote first, read again
      await new Promise(r => setTimeout(r, 300 + Math.random() * 1200));
    }
    return { ok: false, why: "lost the race five times" };
  } catch (e) { return { ok: false, why: "error " + String(e && e.message || e).slice(0, 60) }; }
}

if (process.argv[1] && process.argv[1].endsWith("ai-usage.mjs") && process.argv.includes("--selftest")) {
  let bad = 0; const ok = (c, m) => { console.log((c ? "ok   " : "FAIL ") + m); if (!c) bad++; };
  ok(Math.abs(price("claude-haiku-5-5", { input_tokens: 1e6, output_tokens: 1e6 }) - 0.6) < 1e-9 && Math.abs(price("claude-opus-5-5", { input_tokens: 1e6 }, { batch: true }) - 2) < 1e-9
    && Math.abs(price("claude-sonnet-5-5", { cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }) - 2.7) < 1e-9, "prices: input, output, cache write and read, batch at half");
  ok(price("claude-new-x", { input_tokens: 1e6 }) === 4 && price("claude-opus-5-5[1m]", { output_tokens: 1e6 }) === 20, "an unknown model counts at the top price");
  ok(Math.abs(price("claude-sonnet-5-5", { input_tokens: 1e6, server_tool_use: { web_search_requests: 5 } }) - 2.05) < 1e-9
    && Math.abs(price("claude-sonnet-5-5", { input_tokens: 1e6, web_search_requests: 5 }, { batch: true }) - 1.05) < 1e-9
    && Math.abs(price("claude-haiku-5-5", { server_tool_use: { web_search_requests: 1000 } }) - 10) < 1e-9, "web search: $10 per 1,000, in a reply and in a batch sum, never halved");
  const G1 = GRANTS[0];   // the 1.11 grant, as a fixture: later re-base lines do not change these checks
  { const L = [G1, { id: "g-2026-11-07", from: "2026-11-07T10:00:00Z", until: "2026-11-20T00:00:00Z", left: 60.5 }];
    const a = budget(new Date("2026-11-07T09:59Z"), {}, L), z = budget(new Date("2026-11-07T10:00Z"), {}, L);
    ok(a.cycle === "g-2026-11-01" && a.cap === 71.84 && z.cycle === "g-2026-11-07" && z.cap === 60.5 && cycle(new Date("2026-11-19T23:00Z"), L) === "g-2026-11-07"
      && budget(new Date("2026-11-21T00:00Z"), {}, L).cycle === "2026-11-20", "a re-base line: the latest begun grant wins, from zero; after until the month " + JSON.stringify([a, z])); }
  ok(cycle(new Date("2026-11-01T22:00Z"), [G1]) === "2026-10-20" && cycle(new Date("2026-11-01T22:50Z"), [G1]) === "g-2026-11-01" && cycle(new Date("2026-11-19T23:59Z"), [G1]) === "g-2026-11-01"
    && cycle(new Date("2026-11-20T00:00Z"), [G1]) === "2026-11-20" && cycle(new Date("2027-01-03T00:00Z"), [G1]) === "2026-12-20", "the grant to 20.11, then monthly from the 20th");
  let b = budget(new Date("2026-11-05T00:00Z"), {}); ok(b.cap === 71.84 && b.until === "2026-11-20T00:00:00.000Z".replace(".000", "") , "the grant's cap is what was left on 1.11 " + JSON.stringify(b));
  b = budget(new Date("2026-12-01T00:00Z"), { AI_CAP_USD: "80" }); ok(b.cap === 80 && b.cycle === "2026-11-20" && b.until.startsWith("2026-12-20"), "after the grant: AI_CAP_USD, until the next 20th");
  ok(ilDay("2026-11-20T00:00:00Z") === "19.11", "the alert names the last day the credit works");
  ok(unlock(lock({ a: 1 }, "k1"), "k1").a === 1 && unlock(lock({ a: 1 }, "k1"), "k2") === null && unlock("junk", "k") === null, "the total opens only with the same key");
  let r = add(null, { usd: 57, bot: "A", now: new Date("2026-11-02T00:00Z"), cap: 71.84 });
  ok(r.crossed === 0 && add(r.t, { usd: 0.5, bot: "A", now: new Date("2026-11-02T01:00Z"), cap: 71.84 }).crossed === 80, "80% of the grant's $71.84 is about $57.5");
  r = add(null, { usd: 79, bot: "A", now: new Date("2026-12-02T00:00Z") });
  ok(r.t.usd === 79 && r.crossed === 0 && r.t.by.A === 79, "first reply of a cycle");
  r = add(r.t, { usd: 2, bot: "B", now: new Date("2026-12-03T00:00Z") });
  ok(r.crossed === 80 && r.t.usd === 81 && r.t.by.B === 2 && r.t.calls === 2, "crossing 80% tells once");
  r = add(r.t, { usd: 5, bot: "B", now: new Date("2026-12-04T00:00Z") }); ok(r.crossed === 0 && r.t.usd === 86, "not again in the same cycle");
  r = add(r.t, { usd: 1, bot: "A", now: new Date("2026-12-20T01:00Z") }); ok(r.t.cycle === "2026-12-20" && r.t.usd === 1 && r.t.told.length === 0, "a new cycle starts from zero");
  // record against a fake GitHub: a lost race, then the write
  const files = {}, calls = []; let race = 1;
  const fake = async (url, o = {}) => { calls.push((o.method || "GET") + " " + url.replace(/.*\/repos\/[^/]+\/[^/]+/, ""));
    if (url.includes("/contents/") && !o.method) return files.f ? { ok: true, json: async () => ({ sha: "s1", content: Buffer.from(files.f).toString("base64") }) } : { ok: false, status: 404 };
    if (url.endsWith("/git/ref/heads/ai-usage")) return { ok: false, status: 404 };
    if (url.endsWith("/git/ref/heads/main")) return { ok: true, json: async () => ({ object: { sha: "m" } }) };
    if (url.endsWith("/git/refs")) return { ok: true, status: 201 };
    if (o.method === "PUT") { if (race-- > 0) return { ok: false, status: 409 }; files.f = Buffer.from(JSON.parse(o.body).content, "base64").toString("utf8"); return { ok: true }; }
    return { ok: false, status: 500 }; };
  const env = { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r", ANTHROPIC_API_KEY: "sk-test", GITHUB_WORKFLOW: "Reviews monitor" };
  const NOW = new Date("2026-11-05T00:00Z");
  let x = await record("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500 }, { env, fetcher: fake, now: NOW });
  ok(x.ok && calls.includes("POST /git/refs") && calls.filter(c => c.startsWith("PUT")).length === 2, "first count: the branch is made, a lost race is read again");
  const t = unlock(JSON.parse(files.f).s, "sk-test");
  ok(t && Math.abs(t.usd - 0.007) < 1e-9 && t.by["Reviews monitor"] > 0 && JSON.parse(files.f).p && !/0\.007|Reviews/.test(files.f), "the total is stored locked, with a sealed copy for the threads, nothing readable");
  x = await record("claude-haiku-5-5", { input_tokens: 1000 }, { env, fetcher: fake, now: NOW }); ok(x.ok && unlock(JSON.parse(files.f).s, "sk-test").calls === 2, "the next reply adds to it");
  const left = await remaining({ env, fetcher: fake, now: NOW });
  ok(left && left.cycle === "g-2026-11-01" && left.cap === 71.84 && left.left === Math.round((71.84 - left.used) * 100) / 100 && left.used > 0, "remaining reads the cycle back " + JSON.stringify(left));
  ok(await remaining({ env: {}, fetcher: fake }) === null && (await remaining({ env, fetcher: fake, now: new Date("2026-11-25T00:00Z") })).used === 0, "no key: null; a new cycle: nothing used yet");
  ok((await record("claude-haiku-5-5", { input_tokens: 1 }, { env: {}, fetcher: fake })).ok === false, "no token or key: not counted, no throw");
  ok((await record("claude-haiku-5-5", { input_tokens: 1 }, { env, fetcher: async () => { throw new Error("down"); } })).ok === false, "GitHub down: no throw");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
