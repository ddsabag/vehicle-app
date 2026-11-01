// What the bots spend on the Claude API this credit cycle (ops; Dudu 1.11.2026 21:16 UTC: the $100 a month credit, renewed on the 17th, and
// a router alert at 80%). claude.mjs calls record() after every reply it gets (ask, and each finished batch request at half price), so every
// bot on the shared helper is counted without code of its own. The total lives on branch ai-usage in usage.enc.json:
//   s: the running total, AES-GCM with a key derived from ANTHROPIC_API_KEY (only a bot that holds the key reads it back to add to it);
//   p: the same, sealed with the seo-data public key, for the threads (decrypt.mjs in the project folder).
// The repo is public: no cost, count or model ever reaches a log. A bot without GITHUB_TOKEN/GITHUB_REPOSITORY or without write access,
// a write that loses five races, or a rotated key (the old total cannot be read: the cycle starts again from zero) leaves the count low,
// never the bot broken: record() never throws. Workers (luchit-reviews) are not counted here: well under $1 a month, inside the 20% margin.
// Prices per million tokens (platform docs, 1.11.2026): cache writes 1.25x input, cache reads as listed, a batch request half price.
//   price(model, usage, {batch})   USD of one reply
//   cycle(now)                     the start of the credit cycle ("YYYY-MM-17")
//   record(model, usage, opt)      add one reply to the total; at 80% of AI_CAP_USD (default 100) the router gets ai:spend once a cycle
//   node ai-usage.mjs --selftest   offline
import crypto from "node:crypto";
import fs from "node:fs";

export const PRICES = {   // input, output, cache read
  "claude-opus-5-5": [4, 20, 0.2], "claude-sonnet-5-5": [2, 10, 0.2], "claude-haiku-5-5": [0.1, 0.5, 0.01],
};
const FALLBACK = PRICES["claude-opus-5-5"];   // an unknown model counts at the highest price, so the alert never comes late
export function price(model, u = {}, { batch = false } = {}) {
  const [i, o, r] = PRICES[String(model || "").replace(/\[.*\]$/, "")] || FALLBACK;
  const usd = ((u.input_tokens || 0) * i + (u.cache_creation_input_tokens || 0) * i * 1.25 + (u.cache_read_input_tokens || 0) * r + (u.output_tokens || 0) * o) / 1e6;
  return batch ? usd / 2 : usd;
}
export function cycle(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 17));
  if (now.getUTCDate() < 17) d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
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
export function add(old, { usd, bot, now = new Date(), cap = 100 }) {
  const c = cycle(now), t = old && old.cycle === c ? old : { cycle: c, usd: 0, calls: 0, by: {}, told: [] };
  const before = t.usd;
  t.usd = Math.round((t.usd + usd) * 1e6) / 1e6; t.calls++; t.by[bot] = Math.round(((t.by[bot] || 0) + usd) * 1e6) / 1e6; t.at = now.toISOString();
  const crossed = before < 0.8 * cap && t.usd >= 0.8 * cap && !t.told.includes(80) ? 80 : 0;
  if (crossed) t.told.push(80);
  return { t, crossed, fresh: t.usd === Math.round(usd * 1e6) / 1e6 && t.calls === 1 };
}

const BRANCH = "ai-usage", FILE = "usage.enc.json";
export async function record(model, u, { batch = false, env = process.env, fetcher = fetch, now = new Date() } = {}) {
  try {
    const usd = price(model, u, { batch }), tok = env.GITHUB_TOKEN, repo = env.GITHUB_REPOSITORY, key = env.ANTHROPIC_API_KEY;
    if (!usd || !tok || !repo || !key) return { ok: false, why: "not counted here" };
    const api = `https://api.github.com/repos/${repo}`, H = { authorization: "Bearer " + tok, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
    const cap = +(env.AI_CAP_USD || 100), bot = String(env.GITHUB_WORKFLOW || "local").slice(0, 60);
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
      const { t, crossed } = add(old, { usd, bot, now, cap });
      const body = JSON.stringify({ v: 1, s: lock(t, key), ...(pem ? { p: seal(t, pem) } : {}) });
      const p = await fetcher(`${api}/contents/${FILE}`, { method: "PUT", headers: H,
        body: JSON.stringify({ message: "AI usage", branch: BRANCH, content: Buffer.from(body).toString("base64"), ...(sha ? { sha } : {}) }) });
      if (p.ok) {
        if (crossed) try { const r = await import("./alert.mjs");
          await r.alert("day", "ai:spend", `💳 <b>קרדיט ה-Claude API: הבוטים השתמשו ב-80% מהתקרה החודשית</b>\nהמחזור מתחדש ב-17 לחודש. כשנגמר הקרדיט הבוטים ממשיכים בלי Claude, כמו לפני.`, "", { today: "loud" });
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
  ok(cycle(new Date("2026-11-16T23:00Z")) === "2026-10-17" && cycle(new Date("2026-11-17T00:00Z")) === "2026-11-17" && cycle(new Date("2027-01-03T00:00Z")) === "2026-12-17", "the cycle starts on the 17th");
  ok(unlock(lock({ a: 1 }, "k1"), "k1").a === 1 && unlock(lock({ a: 1 }, "k1"), "k2") === null && unlock("junk", "k") === null, "the total opens only with the same key");
  let r = add(null, { usd: 79, bot: "A", now: new Date("2026-11-02T00:00Z") });
  ok(r.t.usd === 79 && r.crossed === 0 && r.t.by.A === 79, "first reply of a cycle");
  r = add(r.t, { usd: 2, bot: "B", now: new Date("2026-11-03T00:00Z") });
  ok(r.crossed === 80 && r.t.usd === 81 && r.t.by.B === 2 && r.t.calls === 2, "crossing 80% tells once");
  r = add(r.t, { usd: 5, bot: "B", now: new Date("2026-11-04T00:00Z") }); ok(r.crossed === 0 && r.t.usd === 86, "not again in the same cycle");
  r = add(r.t, { usd: 1, bot: "A", now: new Date("2026-11-17T01:00Z") }); ok(r.t.cycle === "2026-11-17" && r.t.usd === 1 && r.t.told.length === 0, "a new cycle starts from zero");
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
  let x = await record("claude-sonnet-5-5", { input_tokens: 1000, output_tokens: 500 }, { env, fetcher: fake });
  ok(x.ok && calls.includes("POST /git/refs") && calls.filter(c => c.startsWith("PUT")).length === 2, "first count: the branch is made, a lost race is read again");
  const t = unlock(JSON.parse(files.f).s, "sk-test");
  ok(t && Math.abs(t.usd - 0.007) < 1e-9 && t.by["Reviews monitor"] > 0 && JSON.parse(files.f).p && !/0\.007|Reviews/.test(files.f), "the total is stored locked, with a sealed copy for the threads, nothing readable");
  x = await record("claude-haiku-5-5", { input_tokens: 1000 }, { env, fetcher: fake }); ok(x.ok && unlock(JSON.parse(files.f).s, "sk-test").calls === 2, "the next reply adds to it");
  ok((await record("claude-haiku-5-5", { input_tokens: 1 }, { env: {}, fetcher: fake })).ok === false, "no token or key: not counted, no throw");
  ok((await record("claude-haiku-5-5", { input_tokens: 1 }, { env, fetcher: async () => { throw new Error("down"); } })).ok === false, "GitHub down: no throw");
  console.log(bad ? `${bad} failed` : "selftest ok"); process.exit(bad ? 1 : 0);
}
