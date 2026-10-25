// Campaign snapshot for the weekly content kit (Dudu approved 25.10, item 4 of reports/זרימת-נתונים-בין-הבוטים-2026-10-25.md): which topic
// (camp, the ?c= of a go/ link or utm_campaign) on which network (via / src) brought people, over the last 7 and 28 Israel days:
//   opens     app opens by a tagged link (link_open kind campaign) and site landings (link_landing), by network and topic
//   checks    site car checks by the visit's network and topic (what the visit did after it landed)
//   installs  new app users by the store link's source and campaign (firstUserSource / firstUserCampaignName)
//   topics    the three above summed per topic, best first, over 7 and 28 days
//   rows      the kit's shape (ideas.mjs --camp): one row per topic and network, last 7 days: opens, landings, checks
// The numbers are private and the repo is public, so the JSON is encrypted like seo-data (.github/seo-data.pub.pem, RSA-OAEP wrapped
// AES-256-GCM key) and only states and row counts are printed. Writes out/camp-data.enc.json; the workflow puts it on branch camp-data.
// Read it: node seo-key/decrypt.mjs camp-data.enc.json > camp-data.json (private key outside the repo), then ideas.mjs reads it like --gsc.
// Node 20, node: builtins only. Commands:
//   node camp-data.mjs              GA_SERVICE_ACCOUNT_JSON
//   node camp-data.mjs selftest     offline: shapes, sums, ranking, encryption round trip, nothing numeric printed
import crypto from "node:crypto";
import fs from "node:fs";

const J = s => { try { return JSON.parse(s); } catch { return null; } };
const PROPERTY = (() => { try { return String(J(fs.readFileSync(new URL("../../analytics/ga4-admin.json", import.meta.url), "utf8")).property || ""); } catch { return ""; } })();
const IO = { fetch: (u, o) => fetch(u, o), now: () => Date.now(), out: s => process.stdout.write(s + "\n") };
const ilDay = t => new Date(t).toLocaleDateString("en-CA", { timeZone: "Asia/Jerusalem" });
const addDays = (s, n) => new Date(Date.parse(s + "T12:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const tagged = v => v && v !== "(not set)" && v !== "(direct)" && v !== "(none)" && v !== "(organic)";
const low = v => String(v || "").toLowerCase();

async function gaToken(sa) {
  const b64 = x => Buffer.from(x).toString("base64url"), now = Math.floor(IO.now() / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/analytics.readonly", aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3000 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url");
  const r = await IO.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }), signal: AbortSignal.timeout(30000) });
  const j = J(await r.text());
  return r.ok && j?.access_token ? j.access_token : null;
}

// the two windows end yesterday (an Israel day: the property keeps Israel time); dateRange index 0 = 7 days, 1 = 28 days
export function ranges(now) {
  const end = addDays(ilDay(now), -1);
  return { d7: [addDays(end, -6), end], d28: [addDays(end, -27), end] };
}
const only = names => ({ filter: { fieldName: "eventName", inListFilter: { values: names } } });
export function queries(R) {
  const dateRanges = [{ startDate: R.d7[0], endDate: R.d7[1], name: "d7" }, { startDate: R.d28[0], endDate: R.d28[1], name: "d28" }];
  return {
    opens: { dateRanges, dimensions: ["platform", "eventName", "customEvent:kind", "customEvent:via", "customEvent:src", "customEvent:camp"].map(name => ({ name })),
      metrics: [{ name: "eventCount" }, { name: "totalUsers" }], dimensionFilter: only(["link_open", "link_landing"]), limit: 5000 },
    checks: { dateRanges, dimensions: [{ name: "customEvent:src" }, { name: "customEvent:camp" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [only(["car_lookup"]), { filter: { fieldName: "platform", stringFilter: { value: "web" } } }] } }, limit: 5000 },
    installs: { dateRanges, dimensions: [{ name: "firstUserSource" }, { name: "firstUserCampaignName" }], metrics: [{ name: "newUsers" }],
      dimensionFilter: { filter: { fieldName: "platform", stringFilter: { value: "Android" } } }, limit: 5000 },
  };
}

// rows of a GA4 report with two named date ranges -> [{ ...dims, d7: [metrics], d28: [metrics] }]
export function fold(rows, names) {
  const m = new Map();
  for (const r of rows || []) {
    const v = r.dimensionValues.map(x => x.value), w = v.pop() === "d28" ? "d28" : "d7", key = v.join("\u0001");
    const o = m.get(key) || Object.fromEntries([...names.map((n, i) => [n, v[i]]), ["d7", null], ["d28", null]]);
    o[w] = r.metricValues.map(x => Number(x.value) || 0); m.set(key, o);
  }
  return [...m.values()].map(o => ({ ...o, d7: o.d7 || o.d28.map(() => 0), d28: o.d28 || o.d7.map(() => 0) }));
}

// per topic: app opens + site landings, site checks, installs, over 7 and 28 days, and the networks that carried it; best (7-day opens, then 28) first
export function topics(S) {
  const T = new Map(), t = camp => { const k = low(camp); if (!T.has(k)) T.set(k, { camp: k, opens: [0, 0], appOpens: [0, 0], landings: [0, 0], checks: [0, 0], installs: [0, 0], via: {} }); return T.get(k); };
  for (const o of S.opens) {
    if (!tagged(o.camp)) continue;
    if (o.eventName === "link_open" && o.kind !== "campaign") continue;   // a shared report or comparison, not a campaign topic
    const x = t(o.camp), net = low(tagged(o.via) ? o.via : o.src) || "?";
    x.opens[0] += o.d7[0]; x.opens[1] += o.d28[0];
    (o.eventName === "link_open" ? x.appOpens : x.landings)[0] += o.d7[0]; (o.eventName === "link_open" ? x.appOpens : x.landings)[1] += o.d28[0];
    x.via[net] = (x.via[net] || 0) + o.d28[0];
  }
  for (const c of S.checks) if (tagged(c.camp)) { const x = t(c.camp); x.checks[0] += c.d7[0]; x.checks[1] += c.d28[0]; }
  for (const i of S.installs) if (tagged(i.firstUserCampaignName) && low(i.firstUserSource) !== "google-play") { const x = t(i.firstUserCampaignName); x.installs[0] += i.d7[0]; x.installs[1] += i.d28[0]; }
  return [...T.values()].sort((a, b) => b.opens[0] - a.opens[0] || b.opens[1] - a.opens[1] || b.installs[1] - a.installs[1] || (a.camp < b.camp ? -1 : 1));
}

// the kit's own shape (content-factory/ideas.mjs --camp, 25.10): one row per topic and network for the last 7 days. opens = app opens by a
// campaign link (link_open kind campaign), landings = site landings with that topic, checks = site car checks of visits with that topic
export function kitRows(S) {
  const M = new Map(), r = (camp, via) => { const k = low(camp) + "\u0001" + via; if (!M.has(k)) M.set(k, { camp: low(camp), via, opens: 0, landings: 0, checks: 0 }); return M.get(k); };
  for (const o of S.opens) {
    if (!tagged(o.camp) || !o.d7[0]) continue;
    if (o.eventName === "link_open") { if (o.kind === "campaign") r(o.camp, low(tagged(o.via) ? o.via : o.src) || "?").opens += o.d7[0]; }
    else r(o.camp, low(tagged(o.src) ? o.src : o.via) || "?").landings += o.d7[0];
  }
  for (const c of S.checks) if (tagged(c.camp) && c.d7[0]) r(c.camp, low(c.src) || "?").checks += c.d7[0];
  return [...M.values()].sort((a, b) => b.opens + b.landings - a.opens - a.landings || b.checks - a.checks || (a.camp < b.camp ? -1 : 1));
}

export function encrypt(obj, pub) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  const ek = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
  return { v: 1, ek: ek.toString("base64"), iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

async function main() {
  const sa = J(process.env.GA_SERVICE_ACCOUNT_JSON || "");
  if (!sa?.client_email || !sa?.private_key || !PROPERTY) { IO.out("camp data: no service account or property"); return 1; }
  const tok = await gaToken(sa);
  if (!tok) { IO.out("camp data: GA4 sign-in failed"); return 1; }
  const R = ranges(IO.now()), Q = queries(R), errors = [], S = {};
  const NAMES = { opens: ["platform", "eventName", "kind", "via", "src", "camp"], checks: ["src", "camp"], installs: ["firstUserSource", "firstUserCampaignName"] };
  for (const [k, body] of Object.entries(Q)) {
    try {
      const r = await IO.fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${PROPERTY}:runReport`, { method: "POST",
        headers: { authorization: "Bearer " + tok, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) });
      const j = J(await r.text());
      if (!r.ok || !j) { errors.push(`${k} ${r.status}`); S[k] = []; continue; }
      S[k] = fold(j.rows, NAMES[k]);
    } catch (e) { errors.push(`${k} ${e.name}`); S[k] = []; }
  }
  const out = { generated: ilDay(IO.now()), generatedAt: new Date(IO.now()).toISOString(), range: { start: R.d7[0], end: R.d7[1] }, rows: kitRows(S), ranges: R, metrics: { opens: ["events", "users"], checks: ["events"], installs: ["newUsers"] },
    note: "d7 / d28 hold [metrics] for the last 7 / 28 Israel days ending yesterday; topics sums them per camp: [7 days, 28 days]", ...S, topics: topics(S), errors };
  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync("out/camp-data.enc.json", JSON.stringify(encrypt(out, fs.readFileSync(".github/seo-data.pub.pem", "utf8"))));
  IO.out(`camp data ${R.d7[1]}: rows opens ${S.opens.length}, checks ${S.checks.length}, installs ${S.installs.length}, topics ${out.topics.length}; errors ${errors.length ? errors.join(", ") : "none"}`);
  return errors.length === Object.keys(Q).length ? 1 : 0;   // a partial snapshot is still published (errors says what is missing)
}

function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const R = ranges(Date.parse("2026-10-25T21:00:00Z"));
  ok(R.d7[0] === "2026-10-18" && R.d7[1] === "2026-10-24" && R.d28[0] === "2026-09-27", "ranges " + JSON.stringify(R));
  const Q = queries(R);
  ok(Q.opens.dateRanges.map(d => d.name).join() === "d7,d28" && Q.opens.dimensions.length === 6, "queries");
  const row = (dims, mets, w) => ({ dimensionValues: [...dims, w].map(value => ({ value })), metricValues: mets.map(v => ({ value: String(v) })) });
  const opens = fold([row(["Android", "link_open", "campaign", "facebook", "", "Market"], [5, 4], "d7"), row(["Android", "link_open", "campaign", "facebook", "", "Market"], [9, 7], "d28"),
    row(["web", "link_landing", "campaign", "", "tiktok", "market"], [3, 3], "d28"), row(["Android", "link_open", "plate", "img", "", "(not set)"], [8, 6], "d7"),
    row(["web", "link_landing", "campaign", "", "facebook", "one_line"], [2, 2], "d7"), row(["web", "link_landing", "campaign", "", "facebook", "one_line"], [2, 2], "d28")],
    ["platform", "eventName", "kind", "via", "src", "camp"]);
  ok(opens.length === 4 && opens[0].d7[0] === 5 && opens[0].d28[0] === 9 && opens.find(o => o.src === "tiktok").d7[0] === 0, "fold " + JSON.stringify(opens));
  const checks = fold([row(["facebook", "one_line"], [6], "d7"), row(["facebook", "one_line"], [11], "d28")], ["src", "camp"]);
  const installs = fold([row(["facebook", "market"], [2], "d28"), row(["google-play", "(not set)"], [40], "d28"), row(["google-play", "market"], [9], "d28")], ["firstUserSource", "firstUserCampaignName"]);
  const T = topics({ opens, checks, installs });
  ok(T.length === 2 && T[0].camp === "market" && T[0].opens.join() === "5,12" && T[0].appOpens.join() === "5,9" && T[0].landings.join() === "0,3", "topics market " + JSON.stringify(T[0]));
  ok(T[0].installs.join() === "0,2" && T[0].via.facebook === 9 && T[0].via.tiktok === 3, "installs and networks " + JSON.stringify(T[0]));
  ok(T[1].camp === "one_line" && T[1].checks.join() === "6,11", "checks " + JSON.stringify(T[1]));
  const K = kitRows({ opens, checks, installs });
  ok(K.length === 2 && K[0].camp === "market" && K[0].via === "facebook" && K[0].opens === 5 && K[0].landings === 0, "kit rows market " + JSON.stringify(K));
  ok(K[1].camp === "one_line" && K[1].via === "facebook" && K[1].landings === 2 && K[1].checks === 6, "kit rows one_line " + JSON.stringify(K[1]));
  const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), pubPem = kp.publicKey.export({ type: "spki", format: "pem" });
  const e = encrypt({ topics: T }, pubPem), key = crypto.privateDecrypt({ key: kp.privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, Buffer.from(e.ek, "base64"));
  const d = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(e.iv, "base64")); d.setAuthTag(Buffer.from(e.tag, "base64"));
  ok(JSON.parse(Buffer.concat([d.update(Buffer.from(e.data, "base64")), d.final()])).topics[0].camp === "market", "encryption round trip");
  ok(!JSON.stringify(e).includes("market"), "the file holds no clear text");
  ok(fs.existsSync(new URL("../seo-data.pub.pem", import.meta.url)), "the public key is in the repo");
  ok(/^\d+$/.test(PROPERTY), "property from analytics/ga4-admin.json");
  IO.out(fails.length ? fails.map(f => "FAIL " + f).join("\n") + `\nselftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = process.argv[2] === "selftest" ? selftest() : await main();
