// Ship tail, GA4 part (ship-tail.yml): makes sure the GA4 property has every custom dimension and key event listed in analytics/ga4-admin.json,
// through the Google Analytics Admin API v1beta (scope analytics.edit). It only creates what is missing: nothing that exists is ever archived,
// deleted, renamed or changed, so a second run creates nothing. A 403 means the service account is not an Editor yet: a result, not a failure.
// The key is SHIP_SA_JSON, a service account only this workflow uses: the reporting key (GA_SERVICE_ACCOUNT_JSON) stays a Viewer, because
// jobs that install pip packages hold it.
// Node 20, node: builtins only. Commands:
//   node ga4-admin.mjs [config]     SHIP_SA_JSON, MODE (on|dry), GA_PROPERTY_ID (optional cross-check) -> outputs result (base64url JSON), code
//   node ga4-admin.mjs selftest     offline (mocked fetch, virtual clock, captured output)
// The key and the access token never reach stdout, the step outputs or the job summary. The result output is base64url: the runner masks
// every line of a multi-line key ("{" and "}" too) and drops any job output that contains one.
import fs from "node:fs";
import crypto from "node:crypto";

const ADMIN = "https://analyticsadmin.googleapis.com", TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/analytics.edit";
const CONFIG = new URL("../../analytics/ga4-admin.json", import.meta.url);
export const SECRET = "SHIP_SA_JSON", BUDGET_MS = 5 * 60000;   // the job's timeout-minutes (8) leaves room for setup
const EDITOR = { why: "לחשבון השירות של Ship tail אין תפקיד Editor בנכס GA4", next: `GA4 ← Admin ← Property access management: להוסיף את המייל של חשבון השירות (הסוד ${SECRET}) בתפקיד Editor` };

const IO = {
  env: process.env, fetch: (u, o) => fetch(u, o), now: () => Date.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), deadline: 0,
  out: s => process.stdout.write(s + "\n"),
  output: (k, v) => { if (IO.env.GITHUB_OUTPUT) fs.appendFileSync(IO.env.GITHUB_OUTPUT, `${k}=${v}\n`); },
  summary: md => { if (IO.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, md + "\n"); },
};
const J = s => { try { return JSON.parse(s); } catch { return null; } };
export const pack = o => Buffer.from(JSON.stringify(o)).toString("base64url");
class Fail extends Error { constructor(code, why, next = "", status = 0) { super(why); this.code = code; this.why = why; this.next = next; this.status = status; } }

// ---- config ----
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;   // GA4 parameter and event names
export function loadConfig(text) {
  const c = J(text), errs = [];
  if (!c || typeof c !== "object") return { property: "", dims: [], keys: [], errs: ["not JSON"] };
  if (!/^\d{6,12}$/.test(String(c.property || ""))) errs.push("property must be the numeric GA4 property id");
  const dims = (c.customDimensions || []).map(d => ({ parameterName: d.parameterName, displayName: d.displayName || d.parameterName,
    description: String(d.description || "").slice(0, 150), scope: d.scope || "EVENT" }));
  const keys = (c.keyEvents || []).map(k => ({ eventName: k.eventName, countingMethod: k.countingMethod || "ONCE_PER_EVENT" }));
  for (const d of dims) {
    if (!NAME.test(d.parameterName || "")) errs.push("bad parameterName " + d.parameterName);
    if (!/^[A-Za-z][A-Za-z0-9_ ]{0,81}$/.test(d.displayName)) errs.push("bad displayName " + d.displayName);
    if (d.scope !== "EVENT") errs.push(`${d.parameterName}: only EVENT scope is handled here`);
  }
  for (const k of keys) {
    if (!NAME.test(k.eventName || "")) errs.push("bad eventName " + k.eventName);
    if (!["ONCE_PER_EVENT", "ONCE_PER_SESSION"].includes(k.countingMethod)) errs.push(`${k.eventName}: bad countingMethod`);
  }
  const dup = a => a.filter((x, i) => a.indexOf(x) !== i);
  for (const x of dup(dims.map(d => d.parameterName))) errs.push("duplicate parameterName " + x);
  for (const x of dup(dims.map(d => d.displayName))) errs.push("duplicate displayName " + x);
  return { property: String(c.property || ""), dims, keys, errs };
}

// ---- HTTP: 5xx, 429 and network errors are tried up to 4 times, 2/4/8 s apart; any other status comes back at once ----
// Every try and wait fits inside IO.deadline, so the step reports before the job's timeout.
async function call(method, url, { headers = {}, body } = {}) {
  for (let i = 0; ; i++) {
    const left = IO.deadline ? IO.deadline - IO.now() : Infinity;
    if (left < 1000) return { status: 0, ok: false, text: "network: out of time" };
    let res;
    const c = new AbortController(), t = setTimeout(() => c.abort(), Math.min(60000, left));
    try {
      const r = await IO.fetch(url, { method, headers, body, signal: c.signal });
      res = { status: r.status, ok: r.ok, text: await r.text(), retryAfter: +(r.headers?.get?.("retry-after") || 0) };
    } catch (e) { res = { status: 0, ok: false, text: "network: " + (e?.name === "AbortError" ? "timeout" : String(e?.message || e).slice(0, 80)) }; }
    finally { clearTimeout(t); }
    if ((res.status && res.status < 500 && res.status !== 429) || i === 3) return res;
    const wait = res.retryAfter > 0 && res.retryAfter <= 30 ? res.retryAfter * 1000 : 2000 * 2 ** i;
    if (IO.deadline && IO.deadline - IO.now() < wait + 1000) return res;
    await IO.sleep(wait);
  }
}
export function jwt(sa, scope, now = IO.now()) {
  const b64 = x => Buffer.from(x).toString("base64url"), iat = Math.floor(now / 1000);
  const head = b64(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64(JSON.stringify({ iss: sa.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  return `${head}.${claim}.${crypto.createSign("RSA-SHA256").update(`${head}.${claim}`).sign(sa.private_key, "base64url")}`;
}
async function accessToken(sa) {
  let assertion;
  try { assertion = jwt(sa, SCOPE); } catch { throw new Fail("error", `המפתח בסוד ${SECRET} לא תקין`, "להדביק מחדש את מפתח ה-JSON של חשבון השירות"); }
  const r = await call("POST", TOKEN_URL, { headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() });
  const t = r.ok && J(r.text)?.access_token;
  if (!t) throw new Fail("error", `ההתחברות ל-Google לא הצליחה (${r.status || "אין חיבור"})`, r.status === 400 || r.status === 401 ? "להדביק מחדש את מפתח ה-JSON של חשבון השירות" : "להריץ שוב", r.status);
  return t;
}

// ---- Admin API: the only calls this script can make ----
// GET and POST (create) on the two collections; a PATCH (rename), DELETE or :archive is refused before it leaves the machine.
export function allowed(method, url, property) {
  let u; try { u = new URL(url); } catch { return false; }
  const raw = url.startsWith(ADMIN + "/") ? url.slice(ADMIN.length).split("?")[0] : "";
  return u.origin === ADMIN && raw === u.pathname && (method === "GET" || method === "POST")
    && new RegExp(`^/v1beta/properties/${property}/(customDimensions|keyEvents)$`).test(raw);
}
function adminFail(r) {
  const msg = String(J(r.text)?.error?.message || r.text || "").replace(/\s+/g, " ").slice(0, 160);
  if (/has not been used in project|SERVICE_DISABLED|API .*is disabled/i.test(msg))
    return new Fail("api-off", "ה-API של GA4 Admin כבוי בפרויקט של חשבון השירות", "להפעיל את Google Analytics Admin API ב-Google Cloud Console, בפרויקט של חשבון השירות", r.status);
  if (r.status === 401 || r.status === 403) return new Fail("needs-editor", EDITOR.why, EDITOR.next, r.status);
  return new Fail("error", `GA4 Admin API החזיר ${r.status || "אין חיבור"}: ${msg || "בלי פירוט"}`, "להריץ שוב", r.status);
}
async function admin(ctx, method, coll, json) {
  const url = `${ADMIN}/v1beta/properties/${ctx.property}/${coll}`;
  if (!allowed(method, url.split("?")[0], ctx.property)) throw new Fail("error", `refused: ${method} ${coll}`, "", -1);
  return call(method, url, { headers: { authorization: "Bearer " + ctx.token, ...(json ? { "content-type": "application/json" } : {}) }, body: json ? JSON.stringify(json) : undefined });
}
async function list(ctx, coll) {
  const all = [];
  let page = "";
  for (let i = 0; i < 10; i++) {
    const r = await admin(ctx, "GET", `${coll}?pageSize=200${page ? "&pageToken=" + encodeURIComponent(page) : ""}`);
    if (!r.ok) throw adminFail(r);
    const j = J(r.text) || {};
    all.push(...(j[coll] || []));
    if (!(page = j.nextPageToken)) break;
  }
  return all;
}

// ---- the GA4 step ----
export async function ensure(configText = fs.readFileSync(CONFIG, "utf8")) {
  const env = IO.env, mode = env.MODE === "on" ? "on" : "dry";
  IO.deadline = IO.now() + BUDGET_MS;
  const R = { code: "", mode, created: [], missing: [], failed: [], why: "", next: "" };
  const cfg = loadConfig(configText);
  if (cfg.errs.length) { IO.out("::error::analytics/ga4-admin.json: " + cfg.errs.join("; ")); return { ...R, code: "error", why: "analytics/ga4-admin.json: " + cfg.errs.join("; ") }; }
  // the secret GA_PROPERTY_ID (weekly report) and the file must name the same property, or nothing is touched
  if (env.GA_PROPERTY_ID && String(env.GA_PROPERTY_ID).trim() !== cfg.property) {
    IO.out("::warning::the GA_PROPERTY_ID secret and analytics/ga4-admin.json name different properties: nothing touched");
    return { ...R, code: "mismatch", why: "מספר הנכס בסוד GA_PROPERTY_ID שונה מזה שב-analytics/ga4-admin.json", next: "לתקן את אחד מהם; לא נעשה שינוי" };
  }
  const raw = String(env[SECRET] || "").trim();
  if (!raw) { IO.out(`::notice::${SECRET} is not set: the GA4 step is skipped`); return { ...R, code: "nosecret" }; }
  // set but not a key (cut short, base64, quoted): an error, so a setup that looks done does not skip forever
  const sa = J(raw);
  if (!sa?.client_email || !sa?.private_key) {
    IO.out(`::error::${SECRET} is set but is not a service-account JSON key`);
    return { ...R, code: "error", why: `הסוד ${SECRET} מוגדר אבל אינו מפתח JSON של חשבון שירות`, next: `להדביק בסוד ${SECRET} את כל קובץ ה-JSON של המפתח, כמו שהורד` };
  }
  const ctx = { property: cfg.property };
  try {
    ctx.token = await accessToken(sa);
    const dims = await list(ctx, "customDimensions"), keys = await list(ctx, "keyEvents");
    const has = new Set(dims.map(d => `${d.scope}:${d.parameterName}`)), hasKey = new Set(keys.map(k => k.eventName));
    const todo = [...cfg.dims.filter(d => !has.has(`${d.scope}:${d.parameterName}`)).map(d => ["customDimensions", d.parameterName, d]),
      ...cfg.keys.filter(k => !hasKey.has(k.eventName)).map(k => ["keyEvents", k.eventName, k])];
    R.missing = todo.map(([c, n]) => (c === "keyEvents" ? "key event " : "") + n);
    IO.out(`ga4: ${cfg.dims.length - todo.filter(t => t[0] === "customDimensions").length}/${cfg.dims.length} custom dimensions and ` +
      `${cfg.keys.length - todo.filter(t => t[0] === "keyEvents").length}/${cfg.keys.length} key events already there`);
    if (!todo.length) return { ...R, code: "ok" };
    if (mode !== "on") { IO.out("dry run: would create " + R.missing.join(", ")); return { ...R, code: "dry" }; }
    for (const [coll, name, body] of todo) {
      const r = await admin(ctx, "POST", coll, body);
      if (r.ok || r.status === 409) { R.created.push(name); continue; }   // 409: created meanwhile, which is the goal
      const f = adminFail(r);
      if (f.code !== "error") throw f;   // a 403 or a disabled API stops here: the next item would get the same answer
      R.failed.push(`${name} (${r.status || "no answer"})`);
    }
    IO.out(`created: ${R.created.join(", ") || "-"}${R.failed.length ? `; failed: ${R.failed.join(", ")}` : ""}`);
    if (R.failed.length) return { ...R, code: "error", why: `GA4 לא יצר ${R.failed.join(", ")}`, next: "לבדוק את הלוג של Ship tail" };
    return { ...R, code: "created" };
  } catch (e) {
    const f = e instanceof Fail ? e : new Fail("error", "תקלה בסקריפט: " + String(e?.message || e).slice(0, 120), "לבדוק את הלוג של Ship tail");
    IO.out(`${f.code === "error" ? "::error::" : "::notice::"}GA4 ${f.code}: ${f.why}`);
    return { ...R, code: f.code, why: f.why, next: f.next };
  }
}

// ---- CLI ----
export async function cli(argv) {
  if (argv[0] === "selftest") return selftest();
  let text;
  try { text = fs.readFileSync(argv[0] || CONFIG, "utf8"); } catch { IO.out("::error::config not readable"); return 1; }
  const R = await ensure(text);
  IO.output("result", pack(R));
  IO.output("code", R.code);
  IO.summary([`### Ship tail: GA4 (${R.mode})`, "", `- result: **${R.code}**${R.why ? `: ${R.why}` : ""}`,
    R.missing.length ? `- missing: ${R.missing.join(", ")}` : "", R.created.length ? `- created: ${R.created.join(", ")}` : ""].filter(Boolean).join("\n"));
  return 0;
}

// ---- selftest (offline) ----
async function selftest() {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const saved = { ...IO };
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = privateKey.export({ type: "pkcs8", format: "pem" });
  const SA = { type: "service_account", client_email: "reader@luchit-test.iam.gserviceaccount.com", private_key: PEM };
  const TOKEN = "ya29.SECRET-GA4-TOKEN-q1w2e3", PROP = "123456789";
  const CFG = JSON.stringify({ property: PROP, customDimensions: [{ parameterName: "kind" }, { parameterName: "n" }, { parameterName: "plan" }],
    keyEvents: [{ eventName: "upgrade_open" }] });
  function world(o = {}) {
    const W = { calls: [], printed: [], outputs: {}, sums: [], clock: Date.UTC(2026, 9, 18, 6), fail: { ...(o.fail || {}) },
      dims: structuredClone(o.dims ?? [{ name: "x/1", parameterName: "kind", displayName: "kind", scope: "EVENT" }]), keys: structuredClone(o.keys ?? []) };
    const res = (status, body, headers = {}) => new Response(JSON.stringify(body ?? {}), { status, headers });
    const take = op => { const q = W.fail[op]; if (q && q.length) { const s = q.shift(); return typeof s === "object" ? res(s.status, { error: { message: s.msg } }) : res(s, { error: { message: "scripted " + s } }); } return null; };
    W.fetch = async (url, opt = {}) => {
      const method = opt.method || "GET", u = new URL(url);
      W.calls.push({ method, url, body: opt.body, at: W.clock });
      W.clock += (o.took || 0) * 60000;   // minutes each request takes
      if (url === TOKEN_URL) return take("token") || res(200, { access_token: TOKEN });
      if (opt.headers?.authorization !== "Bearer " + TOKEN) return res(401, {});
      const coll = u.pathname.split("/").pop();
      if (method === "GET") {
        const e = take("list"); if (e) return e;
        const arr = coll === "customDimensions" ? W.dims : W.keys, start = +(u.searchParams.get("pageToken") || 0), size = o.page || 200;
        return res(200, { [coll]: arr.slice(start, start + size), ...(start + size < arr.length ? { nextPageToken: String(start + size) } : {}) });
      }
      if (method === "POST") {
        const e = take("create"); if (e) return e;
        const b = J(opt.body);
        if (coll === "customDimensions") W.dims.push({ ...b, name: "x/" + (W.dims.length + 1) }); else W.keys.push({ ...b, name: "k/" + (W.keys.length + 1) });
        return res(200, b);
      }
      return res(400, {});
    };
    return W;
  }
  const ENV = { [SECRET]: JSON.stringify(SA, null, 2), MODE: "on" };   // pretty-printed, as Google hands it out
  const run = async (o = {}, env = {}, cfg = CFG) => {
    const W = world(o);
    Object.assign(IO, { env: { ...ENV, ...env }, fetch: W.fetch, now: () => W.clock, sleep: async ms => { W.clock += ms; }, deadline: 0,
      out: s => W.printed.push(s), output: (k, v) => { W.outputs[k] = v; }, summary: s => W.sums.push(s) });
    W.t0 = W.clock;
    W.R = await ensure(cfg);
    W.posts = W.calls.filter(c => c.method === "POST" && c.url !== TOKEN_URL);
    return W;
  };
  try {
    const [h, c, s] = jwt(SA, SCOPE, Date.UTC(2026, 9, 18)).split("."), cl = J(Buffer.from(c, "base64url").toString());
    ok(J(Buffer.from(h, "base64url").toString()).alg === "RS256" && cl.scope === SCOPE && cl.aud === TOKEN_URL && cl.exp - cl.iat === 3600
      && crypto.createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")), "jwt shape and signature");

    // idempotence: only the missing ones are created; the second run against the result creates nothing
    let W = await run();
    ok(W.R.code === "created" && W.R.created.join() === "n,plan,upgrade_open" && W.posts.length === 3, "creates only what is missing " + JSON.stringify(W.R));
    ok(J(W.posts[0].body).scope === "EVENT" && J(W.posts[0].body).displayName === "n" && J(W.posts[2].body).countingMethod === "ONCE_PER_EVENT", "create bodies");
    const W2 = await run({ dims: W.dims, keys: W.keys });
    ok(W2.R.code === "ok" && W2.posts.length === 0, "second run: nothing to do");
    W = await run({ dims: [{ parameterName: "kind", displayName: "Lookup kind (renamed by hand)", scope: "EVENT" }, { parameterName: "n", displayName: "n", scope: "EVENT" },
      { parameterName: "plan", displayName: "plan", scope: "EVENT" }], keys: [{ eventName: "upgrade_open", countingMethod: "ONCE_PER_SESSION" }] });
    ok(W.R.code === "ok" && W.posts.length === 0, "an existing entry with another display name or counting method is left as it is");
    W = await run({ dims: [{ parameterName: "plan", scope: "USER" }], page: 1 }, {});
    ok(W.R.created.join() === "kind,n,plan,upgrade_open", "USER-scoped plan does not count as the EVENT one");
    W = await run({ dims: Array.from({ length: 5 }, (_, i) => ({ parameterName: ["a", "b", "kind", "n", "plan"][i], scope: "EVENT" })), keys: [{ eventName: "upgrade_open" }], page: 2 });
    ok(W.R.code === "ok" && W.calls.filter(x => x.method === "GET" && x.url.includes("customDimensions")).length === 3, "pages are followed");

    // 403: Viewer can list but not create -> needs-editor, reported, not a failure; it stops at the first refusal
    W = await run({ fail: { create: [{ status: 403, msg: "The caller does not have permission" }] } });
    ok(W.R.code === "needs-editor" && W.posts.length === 1 && /Editor/.test(W.R.why) && !W.printed.some(l => l.startsWith("::error::")), "403 on create -> needs-editor " + JSON.stringify(W.R));
    W = await run({ fail: { list: [{ status: 403, msg: "The caller does not have permission" }] } });
    ok(W.R.code === "needs-editor" && W.posts.length === 0, "403 on list -> needs-editor");
    W = await run({ fail: { list: [{ status: 403, msg: "Google Analytics Admin API has not been used in project 1 before or it is disabled" }] } });
    ok(W.R.code === "api-off", "API disabled");

    // never archive, delete or rename: the guard refuses every such call, and a run only ever GETs and POSTs to the two collections
    for (const [m, p] of [["PATCH", `customDimensions/x1`], ["DELETE", "customDimensions/x1"], ["POST", "customDimensions/x1:archive"], ["PATCH", "keyEvents/k1"],
      ["DELETE", "keyEvents/k1"], ["POST", "customMetrics"], ["PUT", "customDimensions"], ["POST", "customDimensions/../x"], ["GET", "dataStreams"]]) {
      ok(!allowed(m, `${ADMIN}/v1beta/properties/${PROP}/${p}`, PROP), `allowed() refuses ${m} ${p}`);
    }
    ok(!allowed("POST", `${ADMIN}/v1beta/properties/999/customDimensions`, PROP), "allowed() refuses another property");
    W = await run({ dims: [] });
    ok(W.calls.every(x => x.url === TOKEN_URL || (["GET", "POST"].includes(x.method) && allowed(x.method, x.url.split("?")[0], PROP))), "a run only lists and creates");

    // dry: lists, creates nothing
    W = await run({}, { MODE: "dry" });
    ok(W.R.code === "dry" && W.posts.length === 0 && W.R.missing.join() === "n,plan,key event upgrade_open", "dry: nothing created " + JSON.stringify(W.R));
    // retry on 5xx and 429, not on 400
    W = await run({ fail: { create: [503, 429] } });
    ok(W.R.code === "created" && W.posts.length === 5, "retry: 503 and 429 then created");
    W = await run({ fail: { create: [{ status: 400, msg: "Display name already exists" }] } });
    ok(W.R.code === "error" && W.R.failed.length === 1 && W.R.created.length === 2 && W.posts.length === 3, "a 400 fails that item only");
    W = await run({ fail: { create: [{ status: 409, msg: "exists" }] } });
    ok(W.R.code === "created", "409 counts as there");
    // inputs
    W = await run({}, { [SECRET]: "" });
    ok(W.R.code === "nosecret" && W.calls.length === 0 && W.printed.filter(l => l.startsWith("::notice::")).length === 1, "no secret: one notice, no calls");
    // set but broken (cut short, quoted, base64): an error with the fix, never a quiet skip; Google is not called
    for (const bad of ["{not json", '"' + JSON.stringify(SA).replace(/"/g, '\\"') + '"', Buffer.from(JSON.stringify(SA)).toString("base64")]) {
      W = await run({}, { [SECRET]: bad });
      ok(W.R.code === "error" && W.calls.length === 0 && W.R.why.includes(SECRET) && W.printed.some(l => l.startsWith("::error::")), "broken key -> error: " + bad.slice(0, 12));
    }
    // the step keeps to its deadline: each request takes 2 minutes and creates fail with 503; it stops in time and reports
    W = await run({ took: 2, fail: { create: Array(40).fill(503) } });
    ok(W.R.code === "error" && W.calls.every(c => c.at < W.t0 + BUDGET_MS), "deadline: every request starts inside the budget " + JSON.stringify(W.R).slice(0, 120));
    // the result output survives the runner's masking of a multi-line key: no line of the key file in it
    W = await run();
    await cli([]);
    const keyLines = ENV[SECRET].split("\n").map(l => l.trim()).filter(Boolean);
    ok(W.outputs.result && !keyLines.some(l => W.outputs.result.includes(l)) && J(Buffer.from(W.outputs.result, "base64url").toString())?.code, "result output: base64url, no line of the key");
    W = await run({}, { GA_PROPERTY_ID: "987654321" });
    ok(W.R.code === "mismatch" && W.calls.length === 0, "property mismatch: nothing touched");
    W = await run({}, { GA_PROPERTY_ID: PROP });
    ok(W.R.code === "created", "property cross-check passes");
    const bad = loadConfig('{"property":"1","customDimensions":[{"parameterName":"9x"},{"parameterName":"a","scope":"USER"}],"keyEvents":[{"eventName":"e","countingMethod":"X"}]}').errs.join();
    ok(/property/.test(bad) && /bad parameterName 9x/.test(bad) && /only EVENT/.test(bad) && /bad countingMethod/.test(bad), "config validation " + bad);

    // the real file: valid, and every entry is something the app sends (index.html) and a report reads
    const root = new URL("../../", import.meta.url), read = p => { try { return fs.readFileSync(new URL(p, root), "utf8"); } catch { return ""; } };
    const real = loadConfig(read("analytics/ga4-admin.json")), html = read("index.html"), wrangler = read("worker/live/wrangler.toml");
    ok(real.errs.length === 0 && real.dims.length >= 14, "analytics/ga4-admin.json is valid " + real.errs);
    ok(wrangler.includes(`GA_PROPERTY_ID = "${real.property}"`), "property = worker/live/wrangler.toml GA_PROPERTY_ID");
    for (const d of real.dims) ok(new RegExp(`[{,]\\s*${d.parameterName}\\s*[:},]`).test(html), `index.html sends parameter ${d.parameterName}`);
    for (const k of real.keys) ok(html.includes(`track("${k.eventName}"`), `index.html sends event ${k.eventName}`);
    const reports = read("analytics/ga.py") + read("analytics/experiments.py") + read("worker/live/worker.js");
    for (const p of ["kind", "dur", "partial", "make", "model", "fuel", "term", "tab", "from", "via", "exp", "exp_v"])
      ok(real.dims.some(d => d.parameterName === p) && (reports.includes(`customEvent:${p}`) || reports.includes(`"${p}"`)), `report parameter ${p} is listed`);

    // secrets never printed
    for (const [o, env] of [[{}, {}], [{ fail: { create: [403] } }, {}], [{ fail: { token: [400] } }, {}], [{}, { MODE: "dry" }]]) {
      W = await run(o, env);
      await cli.call(null, []).catch(() => 0);   // the CLI path writes outputs and the summary from the real file
      const all = [...W.printed, ...Object.values(W.outputs), ...W.sums, JSON.stringify(W.R)].join("\n");
      ok(![PEM.split("\n")[3], TOKEN, "PRIVATE KEY", SA.client_email].some(x => all.includes(x)), "secrets stay out of the output " + JSON.stringify(o));
    }
  } catch (e) { fails.push("crashed: " + (e?.stack || e)); }
  Object.assign(IO, saved);
  for (const f of fails) IO.out("FAIL " + f);
  IO.out(fails.length ? `selftest: ${fails.length} failed` : "selftest: all passed");
  return fails.length ? 1 : 0;
}

if (process.argv[1] && process.argv[1].endsWith("ga4-admin.mjs")) process.exit(await cli(process.argv.slice(2)));
