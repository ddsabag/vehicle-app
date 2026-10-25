#!/usr/bin/env node
// Social publish: posts the weekly content kit to the Facebook Page and the Instagram business account of לוחית through Meta's Graph API.
// The queue is the public branch "social-queue", written by content-factory/enqueue.mjs from a kit that passed the content lint:
//   kits/<YYYY-MM-DD>/autopost.json  items {id, type image|carousel|reel|story, at (UTC ISO), targets [facebook, instagram], files, cover?, caption,
//                                    caption_facebook?, caption_instagram? (a network's own wording, e.g. a clickable link on Facebook),
//                                    needs_live? (an app version, e.g. "1.37": the item shows UI that ships in it)}
//                                    reminders? [{id, at, text, link?, needs_live?, until?}]: a Telegram line to the owner at that time (or,
//                                    with needs_live, once that version is live), until `until` (default at + LATE_MS), for what only a
//                                    person can do (TikTok: its API posts privately only, so the browser extension schedules it)
//   kits/<YYYY-MM-DD>/<media>        the kit's PNG/JPG/MP4 files, unchanged
//   state.json                       what was published: per "<kit>/<item>/<target>" status, ids, link, times, error (no caption text)
// Each run publishes every item whose time has come, at most LATE_MS late, to each target not done yet, and writes state.json after every
// target (the workflow commits it back, also when the run fails). An item later than LATE_MS is marked missed and reported, never posted late.
// Before a publish it looks at the account's latest posts: a post with the same caption from the last DEDUPE_MS means an earlier run published
// it and died before saving state, so it is recorded as done and not posted twice.
// An item with needs_live waits until Google Play shows that version (or a later one) fully rolled out (100%) on the production track: a
// read with the Ship tail key SHIP_SA_JSON (a throwaway edit, deleted at once and never committed). Not live at its time = held and checked again every run;
// still not live LATE_MS after its time = missed and reported, so content never promotes a screen users cannot get yet.
// Two tokens, each optional; a network whose token is missing or refused is reported and the other one still publishes:
//   META_PUBLISH_TOKEN  Facebook: the לוחית Page's own token (from a long-lived user token of the app "Luchit Publisher"; it does not expire),
//                       or a user / system-user token that manages the Page. Its Page-linked Instagram account is used when there is no
//                       IG_PUBLISH_TOKEN: images reach Instagram as the CDN address of an unpublished, temporary Page photo, reels as bytes.
//   IG_PUBLISH_TOKEN    Instagram alone (Instagram business login, graph.instagram.com; no Facebook Page needed). Valid 60 days and
//                       refreshed here once a week. When a refresh hands back a different string it is kept in state.json sealed
//                       (AES-256-GCM, key derived from IG_PUBLISH_TOKEN), so the GitHub secret never has to change; a new secret
//                       starts over. No successful refresh for IG_ALARM_MS = one alert a day. Instagram fetches the media from the
//                       public queue branch: images as the JPEG copy enqueue.mjs writes next to each PNG (<name>.ig.jpg; Instagram
//                       takes JPEG only), reels as they are.
// Stories carry no stickers (the API has none). Every link in a caption must answer (final status below 400) right before the post goes
// out; a dead link holds the post (one alert) and it is tried again every run until LATE_MS. Each item that went up sends one Telegram
// line with its links ("עלה סטורי", "עלתה קרוסלה"...).
//   node social-publish.mjs run        QUEUE=<checkout of social-queue>; DRY_RUN=1 = read-only calls, no posts, nothing recorded
//   node social-publish.mjs check      each token reaches its account; one Telegram line; step summary
//   node social-publish.mjs selftest   offline, mocked Graph and clock
// Optional: META_PAGE_ID (when the token sees more than one Page), GRAPH_VERSION (default v24.0), SHIP_SA_JSON (items with needs_live),
// GITHUB_REPOSITORY (the public queue's repository, for Instagram media addresses).
// Tokens are never printed: they travel only in request bodies, in the query string of reads (never logged) and in the rupload
// Authorization header.
import crypto from "node:crypto";
import { msg, heError } from "./tg-text.mjs";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

export const LATE_MS = 6 * 36e5;          // GitHub cron drifts up to ~40 min; a post more than 6 h late is stale for a weekly plan
export const DEDUPE_MS = 3 * 864e5;
export const MAX_TRIES = 3;
const VERSION = process.env.GRAPH_VERSION || "v24.0";
const GRAPH = `https://graph.facebook.com/${VERSION}`;
const IG_GRAPH = `https://graph.instagram.com/${VERSION}`;
export const IG_REFRESH_MS = 7 * 864e5, IG_ALARM_MS = 45 * 864e5;   // refresh weekly; no successful refresh for 45 of the 60 days = alert
const QUEUE_BRANCH = "social-queue";
// the JPEG copy of a queued image that Instagram gets (enqueue.mjs writes it); a JPEG is its own copy
export const igFile = f => /\.jpe?g$/i.test(f) ? f : f.replace(/\.png$/i, ".ig.jpg");
const rawUrl = (kit, f) => `https://raw.githubusercontent.com/${IO.env.GITHUB_REPOSITORY || "ddsabag/vehicle-app"}/${QUEUE_BRANCH}/kits/${kit}/${encodeURIComponent(f)}`;
const TYPES = ["image", "carousel", "reel", "story"];
const TARGETS = ["facebook", "instagram"];
const NAMES = { image: "פוסט", carousel: "קרוסלה", reel: "ריל", story: "סטורי", facebook: "פייסבוק", instagram: "אינסטגרם" };

// ---- injectable IO (selftest replaces it) ----
export const IO = {
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  log: (...a) => console.log(...a),
  env: process.env,
};

// ---- Graph ----
class GraphError extends Error {
  constructor(msg, info = {}) { super(msg); Object.assign(this, info); }
}
const scrub = s => String(s).replace(/(access_token=|OAuth |Bearer )[^&\s"']+/g, "$1***");
async function graph(method, p, params = {}, { token, form, timeout = 60000, base = GRAPH } = {}) {
  const u = new URL(p.startsWith("http") ? p : base + p);
  let body;
  if (method === "GET") { for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); u.searchParams.set("access_token", token); }
  else if (form) { form.set("access_token", token); body = form; }
  else { const f = new URLSearchParams(); for (const [k, v] of Object.entries(params)) f.set(k, typeof v === "object" ? JSON.stringify(v) : String(v)); f.set("access_token", token); body = f; }
  let last;
  for (let a = 0; a < 3; a++) {
    let r, j;
    try {
      r = await IO.fetch(u, { method, body, signal: AbortSignal.timeout(timeout) });
      j = await r.json().catch(() => ({}));
    } catch (e) { last = new GraphError(`${method} ${u.pathname}: ${scrub(e.message)}`, { transient: true }); await IO.sleep(2000 * (a + 1)); continue; }
    if (r.ok && !j.error) return j;
    const e = j.error || {};
    last = new GraphError(`${method} ${u.pathname}: ${scrub(e.message || "HTTP " + r.status)}${e.code ? ` (code ${e.code}${e.error_subcode ? "/" + e.error_subcode : ""})` : ""}`,
      { code: e.code, sub: e.error_subcode, auth: e.code === 190 || e.code === 102 || e.type === "OAuthException" && [10, 200, 190].includes(e.code), transient: r.status >= 500 || e.is_transient || [1, 2, 4, 17, 32, 341, 368].includes(e.code) });
    if (!last.transient) break;
    await IO.sleep(4000 * (a + 1));
  }
  throw last;
}
const blobOf = (file, type) => new Blob([fs.readFileSync(file)], { type });
const mime = f => ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".mp4": "video/mp4" }[path.extname(f).toLowerCase()] || "application/octet-stream");

// ---- accounts ----
// Two kinds of token work: a Page token (no business portfolio needed: taken from a long-lived user token, it does not expire; /me is the
// Page) or a user / system-user token that lists the Pages it manages (/me/accounts). Instagram calls use the same token.
export async function accounts(token) {
  const want = IO.env.META_PAGE_ID;
  const me = await graph("GET", "/me", { fields: "id,name,instagram_business_account{id,username}" }, { token }).catch(e => { if (e.auth) throw e; return null; });
  if (me?.id) {   // a user token has no instagram_business_account field, so only a Page token gets here
    if (want && me.id !== want) throw new GraphError(`the token is of Page ${me.id}, META_PAGE_ID says ${want}`);
    const ig = me.instagram_business_account || null;
    return { page: { id: me.id, name: me.name, token }, ig: ig ? { id: ig.id, username: ig.username } : null, userToken: token, kind: "page" };
  }
  const pages = (await graph("GET", "/me/accounts", { fields: "id,name,access_token,instagram_business_account{id,username}", limit: "50" }, { token })).data || [];
  if (!pages.length) throw new GraphError("the token sees no Facebook Page (it must be the Page's own token, or a user token that manages the Page)", { auth: true });
  const page = want ? pages.find(p => p.id === want) : pages.length === 1 ? pages[0] : pages.find(p => /לוחית|luchit/i.test(p.name));
  if (!page) throw new GraphError(`more than one Page and none chosen: set META_PAGE_ID to one of ${pages.map(p => p.id).join(", ")}`);
  const ig = page.instagram_business_account || null;
  return { page: { id: page.id, name: page.name, token: page.access_token || token }, ig: ig ? { id: ig.id, username: ig.username } : null, userToken: token, kind: "user" };
}
// A secret pasted with a line break, spaces or quotes around it still works, and so does one pasted with more around it (e.g. the whole
// Graph API Explorer answer of me/accounts): the token is taken out of it (the לוחית Page's, when there are several).
const MESSY = /[\s"'{}:,]/;
export function secretInfo(name) {
  const raw = String(IO.env[name] || ""), t = raw.trim().replace(/^(["'])(.*)\1$/s, "$2").trim();
  if (!MESSY.test(t)) return { token: t, how: t === raw ? "clean" : "trimmed" };
  let found = [];
  try {
    const walk = o => { if (o && typeof o === "object") { if (typeof o.access_token === "string") found.push(o); Object.values(o).forEach(walk); } };
    walk(JSON.parse(t));
  } catch { found = [...t.matchAll(/"access_token"\s*:\s*"([^"]+)"/g)].map(m => ({ access_token: m[1] })); }
  if (!found.length) found = [...new Set(t.match(/\b(?:EAA|IG)[A-Za-z0-9_-]{40,}/g) || [])].map(x => ({ access_token: x }));
  const pick = found.length === 1 ? found[0] : found.find(o => /לוחית|luchit/i.test(o.name || ""));
  return pick && !MESSY.test(pick.access_token) ? { token: pick.access_token, how: "extracted" } : { token: t, how: "messy" };
}
export const secret = name => secretInfo(name).token;
// what a refused token looks like, without showing it: length, the usual prefix, stray characters
const shape = (name, prefix) => { const { token: t, how } = secretInfo(name);
  return `${t.length} תווים, ${t.startsWith(prefix) ? `מתחיל ב-${prefix} כמו שצריך` : `לא מתחיל ב-${prefix}`}` +
    ({ messy: ", יש בו רווחים, מירכאות או סימנים שלא שייכים לטוקן", extracted: " (נלקח מתוך טקסט ארוך יותר שהודבק)", trimmed: " (רווחים או מירכאות בקצוות הוסרו)" }[how] || ""); };
// Both networks from the tokens that exist: {page, ig: {id, username, token, base, login}, errs: {facebook?, instagram?}}
// igToken: the Instagram token to use (igToken(state): the refreshed one sealed in state.json, else the secret)
export async function connect({ igToken: igT = secret("IG_PUBLISH_TOKEN") } = {}) {
  const fbT = secret("META_PUBLISH_TOKEN"), A = { page: null, ig: null, errs: {} };
  if (fbT) {
    try { const a = await accounts(fbT); A.page = a.page; if (a.ig && !igT) A.ig = { ...a.ig, token: a.userToken, base: GRAPH, login: false }; }
    catch (e) { A.errs.facebook = e; }
  }
  if (igT) {
    try {
      const me = await graph("GET", "/me", { fields: "user_id,username" }, { token: igT, base: IG_GRAPH });
      A.ig = { id: String(me.user_id || me.id), username: me.username, token: igT, base: IG_GRAPH, login: true };
    } catch (e) { A.errs.instagram = e; }
  }
  return A;
}

// ---- the Instagram token: weekly refresh, a new string sealed in state.json ----
const iso = t => new Date(t).toISOString();
const igKey = t => crypto.createHash("sha256").update("luchit-ig-seal-v1\n" + t).digest();
const igFp = t => crypto.createHash("sha256").update("luchit-ig-fp-v1\n" + t).digest("hex").slice(0, 12);
export function seal(key, text) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv("aes-256-gcm", key, iv), b = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString("base64");
}
export function unseal(key, b64) {
  try {
    const r = Buffer.from(String(b64), "base64"), d = crypto.createDecipheriv("aes-256-gcm", key, r.subarray(0, 12));
    d.setAuthTag(r.subarray(12, 28)); return Buffer.concat([d.update(r.subarray(28)), d.final()]).toString("utf8");
  } catch { return null; }
}
export function igToken(state) {
  const base = secret("IG_PUBLISH_TOKEN"), s = state?.ig;
  if (!base) return null;
  return (s?.fp === igFp(base) && s.tok && unseal(igKey(base), s.tok)) || base;
}
// once every IG_REFRESH_MS (and not within 6 h of a failed try); the first refresh comes a week after the bot first sees a secret,
// so a token younger than the 24 h Instagram requires is never sent. Returns the token to use now.
export async function refreshIg(Q, now) {
  const base = secret("IG_PUBLISH_TOKEN");
  if (!base) return null;
  if (Q.state.ig?.fp !== igFp(base)) { Q.state.ig = { fp: igFp(base), since: iso(now) }; Q.save(); }   // a new secret: start over
  const s = Q.state.ig, cur = igToken(Q.state), last = Date.parse(s.refreshed || s.since);
  if (now - last < IG_REFRESH_MS || (s.tried && now - Date.parse(s.tried) < 6 * 36e5)) return cur;
  try {
    const j = await graph("GET", "https://graph.instagram.com/refresh_access_token", { grant_type: "ig_refresh_token" }, { token: cur });
    if (!j.access_token) throw new GraphError("Instagram answered without a token");
    if (j.access_token !== cur) s.tok = seal(igKey(base), j.access_token);
    Object.assign(s, { refreshed: iso(now) }); delete s.tried; delete s.err;
    if (j.expires_in) s.expires = iso(now + j.expires_in * 1000);
    Q.save(); IO.log("Instagram token refreshed");
    return j.access_token;
  } catch (e) {
    Object.assign(s, { tried: iso(now), err: String(e.message).slice(0, 200) }); Q.save();
    IO.log(`Instagram token refresh failed: ${e.message}`);
    if (e.auth || now - last > IG_ALARM_MS)
      await tell("day", "social:fail:token-instagram", say("today", "חידוש הטוקן של אינסטגרם נכשל",
        `${heError(e.message).split("\n")[0]} הטוקן הנוכחי תקף עד ${s.expires ? s.expires.slice(0, 10) : "60 יום מהיצירה"}, ועד אז הפרסום ממשיך.`, HINT.instagram, e.message) + link(runUrl()), runUrl());
    return cur;
  }
}
const HINT = {
  facebook: "צריך ליצור טוקן חדש לעמוד לפי הפרומפט (סעיף ב) ולשמור אותו ב-GitHub בשם META_PUBLISH_TOKEN.",
  instagram: "צריך ליצור טוקן חדש לאינסטגרם לפי הפרומפט (סעיף ג) ולשמור אותו ב-GitHub בשם IG_PUBLISH_TOKEN.",
};

// ---- Facebook ----
async function fbPhoto(A, file, { caption, published }) {
  const f = new FormData();
  f.set("source", blobOf(file, mime(file)), path.basename(file));
  if (caption) f.set("message", caption);
  f.set("published", published ? "true" : "false");
  if (!published) f.set("temporary", "true");
  return graph("POST", `/${A.page.id}/photos`, {}, { token: A.page.token, form: f, timeout: 120000 });
}
async function cdnUrl(A, file) {   // a public JPEG address for Instagram: an unpublished, temporary Page photo
  const { id } = await fbPhoto(A, file, { published: false });
  const j = await graph("GET", `/${id}`, { fields: "images" }, { token: A.page.token });
  const img = (j.images || []).slice().sort((a, b) => b.width - a.width)[0];
  if (!img?.source) throw new GraphError(`no image address for ${path.basename(file)}`);
  return img.source;
}
async function fbReel(A, file, caption) {
  const start = await graph("POST", `/${A.page.id}/video_reels`, { upload_phase: "start" }, { token: A.page.token });
  const bytes = fs.readFileSync(file);
  const up = await IO.fetch(start.upload_url || `https://rupload.facebook.com/video-upload/${VERSION}/${start.video_id}`, {
    method: "POST", body: bytes, signal: AbortSignal.timeout(300000),
    headers: { Authorization: `OAuth ${A.page.token}`, offset: "0", file_size: String(bytes.length) } });
  const uj = await up.json().catch(() => ({}));
  if (!up.ok || uj.success === false) throw new GraphError(`reel upload to Facebook failed: HTTP ${up.status} ${scrub(JSON.stringify(uj.debug_info || uj.error || ""))}`, { transient: up.status >= 500 });
  await graph("POST", `/${A.page.id}/video_reels`, { upload_phase: "finish", video_id: start.video_id, video_state: "PUBLISHED", description: caption }, { token: A.page.token });
  let link = "";
  for (let i = 0; i < 20 && !link; i++) {   // the permalink appears once processing ends; the post is live either way
    await IO.sleep(15000);
    const s = await graph("GET", `/${start.video_id}`, { fields: "permalink_url,status" }, { token: A.page.token }).catch(() => ({}));
    if (s.status?.video_status === "error") throw new GraphError(`Facebook could not process the reel: ${scrub(JSON.stringify(s.status))}`);
    if (s.permalink_url) link = s.permalink_url.startsWith("http") ? s.permalink_url : "https://www.facebook.com" + s.permalink_url;
  }
  return { id: start.video_id, link: link || `https://www.facebook.com/${A.page.id}/videos/${start.video_id}` };
}
export async function publishFacebook(A, item, dir) {
  const files = item.files.map(f => path.join(dir, f));
  if (item.type === "image") {
    const j = await fbPhoto(A, files[0], { caption: item.caption, published: true });
    return { id: j.post_id || j.id, link: `https://www.facebook.com/${j.post_id || j.id}` };
  }
  if (item.type === "carousel") {
    const ids = [];
    for (const f of files) ids.push((await fbPhoto(A, f, { published: false })).id);
    const p = { message: item.caption };
    ids.forEach((id, i) => { p[`attached_media[${i}]`] = { media_fbid: id }; });
    const j = await graph("POST", `/${A.page.id}/feed`, p, { token: A.page.token });
    return { id: j.id, link: `https://www.facebook.com/${j.id}` };
  }
  if (item.type === "reel") return fbReel(A, files[0], item.caption);
  if (item.type === "story") {
    const { id } = await fbPhoto(A, files[0], { published: false });
    const j = await graph("POST", `/${A.page.id}/photo_stories`, { photo_id: id }, { token: A.page.token });
    return { id: j.post_id || id, link: `https://www.facebook.com/${A.page.id}` };
  }
  throw new GraphError(`unknown type ${item.type}`);
}

// ---- Instagram ----
const igGraph = (A, method, p, params = {}, o = {}) => graph(method, p, params, { ...o, token: A.ig.token, base: A.ig.base });
async function igReady(A, id, maxMs) {
  const t0 = IO.now();
  for (;;) {
    const s = await igGraph(A, "GET", `/${id}`, { fields: "status_code,status" });
    if (s.status_code === "FINISHED" || s.status_code === "PUBLISHED") return;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new GraphError(`Instagram could not process the media: ${s.status_code} ${scrub(s.status || "")}`);
    if (IO.now() - t0 > maxMs) throw new GraphError(`Instagram still processing after ${Math.round(maxMs / 6e4)} min`, { transient: true });
    await IO.sleep(item_wait(s.status_code));
  }
}
const item_wait = code => code === "IN_PROGRESS" ? 10000 : 5000;
async function igContainer(A, params) { return igGraph(A, "POST", `/${A.ig.id}/media`, params); }
async function igFinish(A, creation) {
  const j = await igGraph(A, "POST", `/${A.ig.id}/media_publish`, { creation_id: creation });
  const m = await igGraph(A, "GET", `/${j.id}`, { fields: "permalink" }).catch(() => ({}));
  return { id: j.id, link: m.permalink || `https://www.instagram.com/${A.ig.username || ""}` };
}
export async function publishInstagram(A, item, dir) {
  if (!A.ig) throw new GraphError("no Instagram account (IG_PUBLISH_TOKEN, or one linked to the Page)");
  const files = item.files.map(f => path.join(dir, f)), kit = path.basename(dir);
  // an image's public address: the queue's JPEG copy (Instagram login) or a temporary Page photo (Instagram linked to the Page)
  const imgUrl = async file => {
    if (!A.ig.login) return cdnUrl(A, file);
    const jpg = igFile(path.basename(file));
    if (!fs.existsSync(path.join(dir, jpg))) throw new GraphError(`${jpg} is missing in the queue: queue the kit again with enqueue.mjs`);
    return rawUrl(kit, jpg);
  };
  if (item.type === "image") {
    const c = await igContainer(A, { image_url: await imgUrl(files[0]), caption: item.caption });
    await igReady(A, c.id, 5 * 6e4); return igFinish(A, c.id);
  }
  if (item.type === "carousel") {
    const kids = [];
    for (const f of files) { const c = await igContainer(A, { image_url: await imgUrl(f), is_carousel_item: "true" }); kids.push(c.id); }
    for (const k of kids) await igReady(A, k, 5 * 6e4);
    const c = await igContainer(A, { media_type: "CAROUSEL", children: kids.join(","), caption: item.caption });
    await igReady(A, c.id, 5 * 6e4); return igFinish(A, c.id);
  }
  if (item.type === "reel" && A.ig.login) {   // Instagram login has no resumable upload: Instagram fetches the file from the public queue
    const p = { media_type: "REELS", video_url: rawUrl(kit, item.files[0]), caption: item.caption, share_to_feed: "true" };
    if (item.cover) p.cover_url = await imgUrl(path.join(dir, item.cover));
    const c = await igContainer(A, p);
    await igReady(A, c.id, 15 * 6e4); return igFinish(A, c.id);
  }
  if (item.type === "reel") {
    const p = { media_type: "REELS", upload_type: "resumable", caption: item.caption, share_to_feed: "true" };
    if (item.cover) p.cover_url = await cdnUrl(A, path.join(dir, item.cover));
    const c = await igContainer(A, p);
    const bytes = fs.readFileSync(files[0]);
    const up = await IO.fetch(c.uri || `https://rupload.facebook.com/ig-api-upload/${VERSION}/${c.id}`, {
      method: "POST", body: bytes, signal: AbortSignal.timeout(300000),
      headers: { Authorization: `OAuth ${A.ig.token}`, offset: "0", file_size: String(bytes.length) } });
    const uj = await up.json().catch(() => ({}));
    if (!up.ok || uj.success === false) throw new GraphError(`reel upload to Instagram failed: HTTP ${up.status} ${scrub(JSON.stringify(uj.debug_info || uj.error || ""))}`, { transient: up.status >= 500 });
    await igReady(A, c.id, 15 * 6e4); return igFinish(A, c.id);
  }
  if (item.type === "story") {
    const c = await igContainer(A, { media_type: "STORIES", image_url: await imgUrl(files[0]) });
    await igReady(A, c.id, 5 * 6e4); return igFinish(A, c.id);
  }
  throw new GraphError(`unknown type ${item.type}`);
}

// a post with this caption already on the account (an earlier run published it, then died before saving state)
const norm = s => String(s || "").replace(/\s+/g, " ").trim();
export async function alreadyPosted(A, target, caption) {
  if (!norm(caption)) return null;
  const since = IO.now() - DEDUPE_MS;
  try {
    if (target === "facebook") {
      const j = await graph("GET", `/${A.page.id}/posts`, { fields: "id,message,created_time,permalink_url", limit: "15" }, { token: A.page.token });
      const hit = (j.data || []).find(p => norm(p.message) === norm(caption) && Date.parse(p.created_time) >= since);
      return hit ? { id: hit.id, link: hit.permalink_url || `https://www.facebook.com/${hit.id}` } : null;
    }
    const j = await igGraph(A, "GET", `/${A.ig.id}/media`, { fields: "id,caption,timestamp,permalink", limit: "15" });
    const hit = (j.data || []).find(p => norm(p.caption) === norm(caption) && Date.parse(p.timestamp) >= since);
    return hit ? { id: hit.id, link: hit.permalink } : null;
  } catch { return null; }   // a failed lookup must not block the post; state.json still guards the normal case
}

// ---- app version live in Google Play (items with needs_live) ----
const vparts = v => String(v).split(".").map(Number);
export const vcmp = (a, b) => { const x = vparts(a), y = vparts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; } return 0; };
// the newest version fully rolled out (100%) on the production track ("" when none)
export async function liveVersion() {
  const raw = String(IO.env.SHIP_SA_JSON || "").trim();
  if (!raw) throw new Error("SHIP_SA_JSON is not set, so Google Play cannot be read");
  let sa; try { sa = JSON.parse(raw); } catch { throw new Error("SHIP_SA_JSON is not a service-account JSON key"); }
  const { jwt, PKG } = await import("./play-alpha.mjs");
  const tr = await IO.fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt(sa, "https://www.googleapis.com/auth/androidpublisher", IO.now()) }).toString(),
    signal: AbortSignal.timeout(30000) });
  const tok = tr.ok ? (await tr.json().catch(() => ({}))).access_token : "";
  if (!tok) throw new Error(`Google sign-in failed (${tr.status})`);
  // a staged rollout (20% first, Release watch takes it to 100% after 48 h) is not "live" yet: only a COMPLETED release counts. tracks.releases.list
  // does not say how far a rollout got, so a throwaway edit is opened to read the track and deleted again (never committed, changes nothing)
  const P = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PKG}/edits`, H = { authorization: "Bearer " + tok };
  const e = await IO.fetch(P, { method: "POST", headers: H, signal: AbortSignal.timeout(30000) });
  const id = e.ok ? (await e.json().catch(() => ({}))).id : "";
  if (!id) throw new Error(`Google Play answered ${e.status}`);
  let r; try { r = await IO.fetch(`${P}/${id}/tracks/production`, { headers: H, signal: AbortSignal.timeout(30000) }); }
  finally { await IO.fetch(`${P}/${id}`, { method: "DELETE", headers: H, signal: AbortSignal.timeout(30000) }).catch(() => {}); }
  if (!r.ok) throw new Error(`Google Play answered ${r.status}`);
  const pub = ((await r.json().catch(() => ({}))).releases || []).filter(x => x.status === "completed")
    .map(x => String(x.name || "").match(/\d+\.\d+(?:\.\d+)?/)?.[0]).filter(Boolean).sort(vcmp);
  return pub.at(-1) || "";
}

// ---- queue ----
export function loadQueue(q) {
  const kits = [];
  const root = path.join(q, "kits");
  for (const d of fs.existsSync(root) ? fs.readdirSync(root).sort() : []) {
    const f = path.join(root, d, "autopost.json");
    if (!fs.existsSync(f)) continue;
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    kits.push({ name: d, dir: path.join(root, d), items: validate(j, path.join(root, d), { queue: true }), reminders: validateReminders(j) });
  }
  const sf = path.join(q, "state.json");
  const state = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : { v: 1, posts: {} };
  return { kits, state, save: () => fs.writeFileSync(sf, JSON.stringify(state, null, 1) + "\n") };
}
export function validate(j, dir, { queue = false } = {}) {
  const out = [];
  for (const it of j.items || []) {
    const bad = m => { throw new Error(`autopost.json item ${it.id || "?"}: ${m}`); };
    if (!/^[a-z0-9-]{1,40}$/.test(it.id || "")) bad("id must be a-z, 0-9 or -");
    if (!TYPES.includes(it.type)) bad(`type must be one of ${TYPES.join(", ")}`);
    if (!Array.isArray(it.targets) || !it.targets.length || it.targets.some(t => !TARGETS.includes(t))) bad(`targets must be from ${TARGETS.join(", ")}`);
    if (!Number.isFinite(Date.parse(it.at)) || !/(Z|[+-]\d\d:\d\d)$/.test(it.at)) bad("at must be an ISO time with a zone");
    const n = (it.files || []).length;
    if (!n || (it.type === "carousel" ? n < 2 || n > 10 : n !== 1)) bad(it.type === "carousel" ? "a carousel needs 2-10 files" : "needs exactly one file");
    for (const f of [...it.files, ...(it.cover ? [it.cover] : [])]) if (f.includes("/") || f.includes("\\") || !fs.existsSync(path.join(dir, f))) bad(`file ${f} is missing`);
    if (queue && it.targets.includes("instagram"))
      for (const f of it.type === "reel" ? (it.cover ? [it.cover] : []) : it.files)
        if (!fs.existsSync(path.join(dir, igFile(f)))) bad(`${igFile(f)} (the JPEG copy for Instagram) is missing: queue the kit with enqueue.mjs`);
    if (it.needs_live !== undefined && !/^\d+\.\d+(\.\d+)?$/.test(String(it.needs_live))) bad("needs_live must be an app version such as 1.37");
    if (it.type === "reel" ? !/\.mp4$/i.test(it.files[0]) : it.files.some(f => !/\.(png|jpe?g)$/i.test(f))) bad("wrong file type for " + it.type);
    for (const t of it.targets) {
      const c = it[`caption_${t}`] ?? it.caption;
      if (it.type !== "story" && !norm(c)) bad(`a caption is required (${t})`);
      if (String(c || "").length > 2200) bad(`caption longer than 2,200 characters (${t}; Instagram's limit)`);
      if ((String(c || "").match(/#[^\s#]+/g) || []).length > 30) bad(`more than 30 hashtags (${t}; Instagram's limit)`);
    }
    out.push(it);
  }
  return out;
}

export function validateReminders(j) {
  const out = [];
  for (const r of j.reminders || []) {
    const bad = m => { throw new Error(`autopost.json reminder ${r.id || "?"}: ${m}`); };
    if (!/^[a-z0-9-]{1,40}$/.test(r.id || "")) bad("id must be a-z, 0-9 or -");
    if (!Number.isFinite(Date.parse(r.at)) || !/(Z|[+-]\d\d:\d\d)$/.test(r.at)) bad("at must be an ISO time with a zone");
    if (!norm(r.text) || String(r.text).length > 1500) bad("text is required (at most 1,500 characters)");
    if (r.link !== undefined && !/^https:\/\/\S+$/.test(r.link)) bad("link must be an https address");
    if (r.needs_live !== undefined && !/^\d+\.\d+(\.\d+)?$/.test(String(r.needs_live))) bad("needs_live must be an app version such as 1.37");
    if (r.until !== undefined && !(/(Z|[+-]\d\d:\d\d)$/.test(r.until) && Date.parse(r.until) > Date.parse(r.at))) bad("until must be an ISO time with a zone, after at");
    out.push(r);
  }
  return out;
}

// ---- links in a caption: each must answer before the post goes out ----
export const captionLinks = c => [...new Set((String(c || "").match(/(?:https?:\/\/|\b(?:www\.)?luchit\.app\/)[^\s"'<>()]*/gi) || [])
  .map(u => u.replace(/[.,!?:;]+$/, "")).map(u => /^https?:/i.test(u) ? u : "https://" + u))];
// Gates read before anything goes out (25.10, Dudu "כולם" on the bot-links table):
//   the site answers: a post sends people to luchit.app, so while the home page does not answer every due item waits (retried every run,
//   missed after LATE_MS like any late item)
//   no halted rollout: while the alert router has a prod:halt item from the last HALT_MS (Production stopped a rollout on a new crash),
//   items that promote an app version (needs_live) wait; other items still go out
export const HALT_MS = 72 * 36e5;
export async function gates() {
  const site = await linkOk("https://luchit.app/");
  let halt = "";
  try {
    const r = await IO.fetch(`https://raw.githubusercontent.com/${IO.env.GITHUB_REPOSITORY || "ddsabag/vehicle-app"}/alert-state/state.json`, { signal: AbortSignal.timeout(15000) });
    const items = r.ok ? (await r.json())?.items || {} : {};
    halt = Object.entries(items).find(([k, it]) => k.startsWith("prod:halt") && IO.now() - Date.parse(it?.last) < HALT_MS)?.[0] || "";
  } catch {}   // unreadable state = no known halt (Production's own alert already rang)
  return { site, halt };
}
async function linkOk(u) {
  try { const r = await IO.fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "luchit-social-publish" } }); return r.status < 400; }
  catch { return false; }
}

// ---- Telegram (alert router, legacy = direct send) ----
// every message in the shared shape (tg-text.mjs): classification line, a short Hebrew sentence, what to do; English API text folded
const esc = t => String(t ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const say = (kind, title, text, what = "", raw = "") => msg({ kind, area: "marketing", title: "פרסום אוטומטי: " + title, text, what, raw });
const link = u => (u ? `\n🔗 ${esc(u)}` : "");
async function telegram(text, silent = false) {
  const e = IO.env;
  if (!e.TELEGRAM_BOT_TOKEN || !e.TELEGRAM_CHAT_ID) { IO.log("no Telegram credentials:\n" + text); return false; }
  try {
    const r = await IO.fetch(`https://api.telegram.org/bot${e.TELEGRAM_BOT_TOKEN}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: e.TELEGRAM_CHAT_ID, text, parse_mode: "HTML", disable_web_page_preview: true, disable_notification: silent }), signal: AbortSignal.timeout(20000) });
    IO.log("telegram " + r.status); return r.ok;
  } catch (x) { IO.log("telegram failed " + x.message); return false; }
}
async function tell(level, key, text, link = "", today = "loud") {
  if (IO.env.SOCIAL_SELFTEST) { IO.log(`[tell ${level} ${key}] ${text}`); return; }
  if (!IO.env.TELEGRAM_BOT_TOKEN) { IO.log("no Telegram credentials:\n" + text); return; }
  let router = null; try { router = await import("./alert.mjs"); } catch {}
  if (router) await router.alert(level, key, text, link, { today, legacy: () => telegram(text, today === "silent") });
  else await telegram(text, today === "silent");
}

// ---- run ----
export async function run(qdir) {
  const dry = !!IO.env.DRY_RUN;
  const Q = loadQueue(qdir), now = IO.now(), summary = [];
  const igT = dry ? igToken(Q.state) : await refreshIg(Q, now);   // every run, so the token stays fresh in weeks with nothing queued
  let live = null;
  const isLive = async need => {   // Google Play is read once per run, and only when something due waits for a version
    if (!live) live = await liveVersion().then(v => ({ v }), e => ({ err: e.message }));
    return !!live.v && vcmp(live.v, need) >= 0;
  };
  for (const k of Q.kits) for (const r of k.reminders) {   // reminders need no Meta token
    const key = `${k.name}/${r.id}/telegram`, at = Date.parse(r.at), until = r.until ? Date.parse(r.until) : at + LATE_MS;
    if (Q.state.posts[key]?.status || at > now) continue;
    if (now > until) { summary.push(`missed ${key}`); if (!dry) { Q.state.posts[key] = { status: "missed", at: iso(now) }; Q.save(); } continue; }
    if (r.needs_live && !(await isLive(r.needs_live))) { summary.push(`held ${key}: waits for ${r.needs_live} in Google Play`); continue; }
    summary.push(`remind ${key}`);
    if (dry) continue;
    await tell("day", `social:remind:${k.name}-${r.id}`, msg({ kind: "today", area: "marketing", title: "תזכורת", text: esc(r.text), what: "מה שכתוב למעלה." }) + link(r.link), r.link || "");
    Q.state.posts[key] = { status: "done", at: iso(now) }; Q.save();
  }
  const due = [];
  for (const k of Q.kits) for (const it of k.items) for (const t of it.targets) {
    const key = `${k.name}/${it.id}/${t}`, s = Q.state.posts[key];
    if (s && ["done", "missed", "failed", "unsure"].includes(s.status)) continue;
    const at = Date.parse(it.at);
    if (at > now) continue;
    due.push({ k, it, t, key, late: now - at });
  }
  IO.log(`queue: ${Q.kits.length} kit(s), ${due.length} target(s) due${dry ? " (dry run)" : ""}`);
  if (!due.length) return { published: 0, summary };
  if (!secret("META_PUBLISH_TOKEN") && !igT) { IO.log("neither META_PUBLISH_TOKEN nor IG_PUBLISH_TOKEN is set: nothing published"); return { published: 0, summary, noToken: true }; }
  const A = await connect({ igToken: igT });
  for (const [t, e] of Object.entries(A.errs)) {   // that network's items wait for the next run; the other network still publishes
    const n = due.filter(d => d.t === t).length;
    IO.log(`${t} not connected: ${e.message}`);
    if (n && !dry) await tell("day", `social:fail:token-${t}`, say("urgent", `החיבור ל${NAMES[t]} לא עובד`,
      `${n === 1 ? "פרסום אחד מחכה" : `${n} פרסומים מחכים`} שם. ${heError(e.message).split("\n")[0]}`, HINT[t], e.message) + link(runUrl()), runUrl());
  }
  if (!A.page && !A.ig && Object.keys(A.errs).length) throw Object.values(A.errs)[0];
  const G = await gates();
  if (!G.site) {
    summary.push("held: luchit.app does not answer");
    if (!dry) await tell("summary", "social:held:site", say("info", "הפרסומים מחכים", "האתר לא ענה, ופוסט עכשיו היה שולח אנשים לאתר שלא עובד. הבוט ינסה שוב בהרצה הבאה.", "", "luchit.app"), runUrl(), "silent");
    return { published: 0, summary };
  }
  let published = 0;
  const posted = [], links = new Map();
  const deadLink = async c => { for (const u of captionLinks(c)) { if (!links.has(u)) links.set(u, await linkOk(u)); if (!links.get(u)) return u; } return ""; };
  for (const d of due) {
    const { k, t, key } = d, it = { ...d.it, caption: d.it[`caption_${t}`] ?? d.it.caption }, st = Q.state.posts[key] || { tries: 0 };
    if (!dry) Q.state.posts[key] = st;   // a dry run records nothing
    const label = `${NAMES[it.type]} של ${ilDay(it.at)} ב${NAMES[t]}`, ref = `ערכה ${k.name}, פריט ${it.id}`;
    if (it.needs_live && G.halt && d.late <= LATE_MS) {
      summary.push(`held ${key}: the Production rollout is halted (${G.halt})`);
      if (!dry && !st.halted) { st.halted = new Date(now).toISOString(); Q.save();
        await tell("summary", `social:held:${k.name}-${it.id}`, say("info", `ה${label} מחכה`, "הוא מקדם גרסה של האפליקציה, וההפצה שלה נעצרה בגלל קריסה חדשה. הוא ייצא כשההפצה תחזור, עד שש שעות אחרי הזמן שנקבע.", "", ref), runUrl(), "silent"); }
      continue;
    }
    const waits = !!it.needs_live && !(await isLive(it.needs_live));
    if (d.late > LATE_MS) {
      Object.assign(st, { status: "missed", at: new Date(now).toISOString(), ...(waits ? { err: `waited for ${it.needs_live} in Google Play` } : {}) });
      if (!dry) Q.save();
      summary.push(`missed ${key}${waits ? ` (waited for ${it.needs_live})` : ""}`);
      if (!dry) await tell("day", `social:missed:${k.name}-${it.id}`, say("info", `ה${label} לא יפורסם`, waits
        ? `הוא מראה מסכים מגרסה ${it.needs_live}, והיא עוד לא זמינה בגוגל פליי.`
        : "הוא לא יצא בזמן, ואחרי שש שעות של איחור הבוט כבר לא מפרסם.", waits ? "אם רוצים אותו, לבקש בשרשור הערכה השבועית לתזמן אותו מחדש." : "", ref) + link(runUrl()), runUrl());
      continue;
    }
    if (waits) {
      const why = live.err ? `לא הצלחתי לבדוק את גוגל פליי (${live.err})` : `בגוגל פליי עדיין ${live.v || "אין גרסה"} ולא ${it.needs_live}`;
      summary.push(`held ${key}: waits for ${it.needs_live} in Google Play (${live.v || live.err || "none"})`);
      if (!dry && !st.held) {
        st.held = new Date(now).toISOString(); Q.save();
        await tell("day", `social:held:${k.name}-${it.id}`, say("info", `ה${label} מחכה לגרסה ${it.needs_live}`,
          `${esc(why)}. הוא מראה מסכים מהגרסה הזו, אז הוא ייצא רק כשהיא זמינה, עד שש שעות אחרי הזמן שנקבע.`, "", ref) + link(runUrl()), runUrl());
      }
      continue;
    }
    if (!(t === "facebook" ? A.page : A.ig)) {
      if (A.errs[t]) { summary.push(`waiting ${key}: ${t} not connected`); continue; }   // a refused or unreachable token: retried next run
      const why = t === "facebook" ? "META_PUBLISH_TOKEN is not set" : "no Instagram account (IG_PUBLISH_TOKEN is not set and none is linked to the Page)";
      summary.push(`failed ${key}: ${why}`);
      if (dry) continue;
      Object.assign(st, { status: "failed", err: why }); Q.save();
      await tell("day", `social:fail:notoken-${t}`, say("urgent", `ה${label} לא פורסם`, `אין חיבור ל${NAMES[t]}.`, HINT[t], ref) + link(runUrl()), runUrl());
      continue;
    }
    if (it.type === "story" && st.tries > 0) {   // no caption to look for: a story that may already be up is not posted again
      Object.assign(st, { status: "unsure" }); Q.save(); summary.push(`unsure ${key}`);
      await tell("day", `social:unsure:${k.name}-${it.id}`, say("today", `לא ברור אם ה${label} עלה`, "הניסיון הקודם נקטע באמצע.", `להציץ בחשבון ב${NAMES[t]}. אם הוא לא שם, לכתוב בשרשור הערכה השבועית.`, ref) + link(runUrl()), runUrl());
      continue;
    }
    if (dry) { summary.push(`would publish ${key}`); IO.log(`dry: would publish ${key} (${it.files.join(", ")})`); continue; }
    const dead = await deadLink(it.caption);
    if (dead) {   // the post waits for its link; tried again every run until LATE_MS
      summary.push(`waiting ${key}: link ${dead} does not answer`);
      if (!st.linkWarned) {
        st.linkWarned = iso(now); Q.save();
        await tell("day", `social:fail:link-${k.name}-${it.id}`, say("today", `ה${label} מחכה לקישור שעובד`,
          `הקישור ${esc(dead)} לא נפתח כרגע. הבוט בודק שוב כל רבע שעה ומפרסם כשהקישור חוזר, עד שש שעות אחרי הזמן שנקבע.`, "לפתוח את הקישור. אם הוא לא עובד גם אצלך, לכתוב לי בשרשור \"תפעול, בוטים ומייל\".", ref) + link(runUrl()), runUrl());
      }
      continue;
    }
    const prev = st.tries > 0 ? await alreadyPosted(A, t, it.caption) : null;
    if (prev) { Object.assign(st, { status: "done", id: prev.id, link: prev.link, at: new Date(IO.now()).toISOString(), note: "found on the account" }); Q.save(); summary.push(`done ${key} (found)`); continue; }
    st.tries++; st.last = new Date(IO.now()).toISOString(); Q.save();
    try {
      const r = t === "facebook" ? await publishFacebook(A, it, k.dir) : await publishInstagram(A, it, k.dir);
      Object.assign(st, { status: "done", id: r.id, link: r.link, at: new Date(IO.now()).toISOString() }); delete st.err; Q.save();
      published++; summary.push(`done ${key} ${r.link}`); posted.push({ k, it, t, link: r.link });
      IO.log(`published ${key}: ${r.link}`);
    } catch (e) {
      st.err = String(e.message).slice(0, 300); Q.save();
      IO.log(`failed ${key}: ${e.message}`);
      if (e.auth) {   // nothing was posted: this network stops for the run, its items wait; the other network goes on
        st.tries--; Q.save();
        A.errs[t] = e; if (t === "facebook") A.page = null; else A.ig = null;
        summary.push(`waiting ${key}: ${t} refused the token`);
        await tell("day", `social:fail:token-${t}`, say("urgent", `${NAMES[t]} דחה את הטוקן`, "הפרסומים שם מחכים עד שיהיה טוקן חדש.", HINT[t], e.message) + link(runUrl()), runUrl());
        continue;
      }
      if (st.tries >= MAX_TRIES) {
        st.status = "failed"; Q.save(); summary.push(`failed ${key}: ${e.message}`);
        await tell("day", `social:fail:${k.name}-${it.id}`, say("today", `ה${label} לא פורסם`, `${MAX_TRIES} ניסיונות נכשלו. ${heError(e.message).split("\n")[0]}`,
          "לכתוב לי בשרשור \"תפעול, בוטים ומייל\". אם הפוסט חשוב, אפשר להעלות אותו ידנית מהערכה.", `${ref}: ${e.message}`) + link(runUrl()), runUrl());
      } else summary.push(`retry ${key}: ${e.message}`);
    }
  }
  const done = summary.filter(s => s.startsWith("done ")).length;
  // one Telegram line per item that went up in this run, with its links
  const UP = { image: "עלה פוסט", carousel: "עלתה קרוסלה", reel: "עלה סרטון (ריל)", story: "עלה סטורי" };
  for (const id of [...new Set(posted.map(p => `${p.k.name}/${p.it.id}`))]) {
    const ps = posted.filter(p => `${p.k.name}/${p.it.id}` === id), { k, it } = ps[0];
    await tell("day", `social:done:${k.name}-${it.id}-${ps.map(p => p.t).join("+")}`,
      msg({ kind: "done", area: "marketing", title: `${UP[it.type]} (${esc(it.id)})`, text: ps.map(p => `${NAMES[p.t]}: ${esc(p.link)}`).join("\n") }), "", "silent");
  }
  IO.log(`published ${published}, recorded ${done}`);
  return { published, summary };
}

export async function check() {
  if (!secret("META_PUBLISH_TOKEN") && !secret("IG_PUBLISH_TOKEN")) throw new Error("neither META_PUBLISH_TOKEN nor IG_PUBLISH_TOKEN is set (GitHub: Settings > Secrets and variables > Actions)");
  const sf = IO.env.QUEUE && path.join(IO.env.QUEUE, "state.json");
  const state = sf && fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {};
  const A = await connect({ igToken: igToken(state) });
  const lim = A.ig ? await igGraph(A, "GET", `/${A.ig.id}/content_publishing_limit`, { fields: "quota_usage,config" }).catch(() => null) : null;
  // the Page token must not expire: a short one (not taken from an extended user token) would stop the bot within hours
  const dbg = A.page ? (await graph("GET", "/debug_token", { input_token: A.page.token }, { token: A.page.token }).catch(() => null))?.data : null;
  const exp = !dbg ? "" : dbg.expires_at === 0 ? "הטוקן של העמוד לא פג" : `הטוקן של העמוד פג ב-${iso(dbg.expires_at * 1000).slice(0, 16).replace("T", " ")} UTC: צריך ליצור טוקן מטוקן מוארך (Extend Access Token)`;
  const q = lim?.data?.[0], err = t => A.errs[t] ? `לא מחובר (${A.errs[t].message}). הטוקן: ${t === "facebook" ? shape("META_PUBLISH_TOKEN", "EAA") : shape("IG_PUBLISH_TOKEN", "IG")}` : null;
  const lines = [
    `פייסבוק: ${A.page ? `העמוד ${A.page.name}` : err("facebook") || "אין טוקן (META_PUBLISH_TOKEN)"}`,
    `אינסטגרם: ${A.ig ? `@${A.ig.username}${A.ig.login ? " (טוקן נפרד)" : " (דרך העמוד)"}` : err("instagram") || "אין טוקן (IG_PUBLISH_TOKEN) ואין חשבון שמקושר לעמוד"}`,
    exp,
    q ? `מכסת פרסום באינסטגרם: ${q.quota_usage} מתוך ${q.config?.quota_total ?? "?"} ב-24 שעות` : "",
    state.ig?.refreshed ? `הטוקן של אינסטגרם חודש ב-${state.ig.refreshed.slice(0, 10)}` : ""].filter(Boolean);
  const ok = !Object.keys(A.errs).length && !!(A.page || A.ig) && !(dbg && dbg.expires_at !== 0);
  IO.log(lines.join("\n"));
  await tell("summary", "social:check", say(ok ? "info" : "today", ok ? "החיבור לפייסבוק ולאינסטגרם עובד" : "יש בעיה בחיבור לפייסבוק או לאינסטגרם",
    esc(lines.join("\n")), ok ? "" : "לכתוב לי בשרשור \"תפעול, בוטים ומייל\"."), "", "silent");
  return { ok, A };
}
const runUrl = () => IO.env.RUN_URL || "";
const ilDay = at => { const d = new Date(at); return isNaN(d) ? "" : new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "numeric", month: "numeric" }).format(d); };

// ---- selftest ----
async function selftest() {
  const os = await import("node:os");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "social-selftest-"));
  const kit = path.join(tmp, "kits", "2026-10-22");
  fs.mkdirSync(kit, { recursive: true });
  for (const f of ["dealer-post.png", "carousel-01.png", "carousel-02.png", "reel.mp4", "reel-cover.jpg", "story-02.png",
    "dealer-post.ig.jpg", "carousel-01.ig.jpg", "carousel-02.ig.jpg", "story-02.ig.jpg"]) fs.writeFileSync(path.join(kit, f), "x");
  const T = s => Date.parse(s);
  fs.writeFileSync(path.join(kit, "autopost.json"), JSON.stringify({ items: [
    { id: "dealer", type: "image", at: "2026-10-25T06:30:00Z", targets: ["facebook", "instagram"], files: ["dealer-post.png"], caption: "פוסט לסוחרים", caption_facebook: "פוסט לסוחרים luchit.app/go/fb" },
    { id: "carousel", type: "carousel", at: "2026-10-26T18:30:00Z", targets: ["facebook", "instagram"], files: ["carousel-01.png", "carousel-02.png"], caption: "קרוסלה" },
    { id: "reel", type: "reel", at: "2026-10-29T18:30:00Z", targets: ["facebook", "instagram"], files: ["reel.mp4"], cover: "reel-cover.jpg", caption: "ריל" },
    { id: "story", type: "story", at: "2026-10-27T06:15:00Z", targets: ["instagram"], files: ["story-02.png"] },
  ], reminders: [{ id: "tiktok", at: "2026-10-25T06:00:00Z", text: "להדביק בתוסף את פרומפט הטיקטוק של ערכה 2", link: "https://www.tiktok.com/tiktokstudio" }] }));
  const calls = [], sent = [];
  let clock = T("2026-10-25T06:40:00Z"), failNext = 0, igPosts = [], linkStatus = 200, siteStatus = 200, alertState = null;
  const J = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  IO.fetch = async (u, o = {}) => {
    const s = String(u), m = o.method || "GET", p = new URL(s).pathname.replace(/^\/v[\d.]+/, "");
    calls.push(`${m} ${p}`);
    if (s.includes("api.telegram.org")) return J({ ok: true });
    if (new URL(s).host === "luchit.app") return J({}, new URL(s).pathname === "/" ? siteStatus : linkStatus);
    if (s.includes("/alert-state/state.json")) return alertState ? J(alertState) : J({}, 404);
    if (failNext && m === "POST" && p.endsWith("/media_publish")) { failNext--; return J({ error: { message: "temporary", code: 2, is_transient: true } }, 500); }
    if (p === "/me/accounts") return J({ data: [{ id: "111", name: "לוחית", access_token: "PAGE", instagram_business_account: { id: "222", username: "luchit.app" } }] });
    if (m === "POST" && o.body?.get) sent.push({ message: o.body.get("message"), caption: o.body.get("caption") });
    if (m === "POST" && p === "/111/photos") return J({ id: "ph" + calls.length, post_id: "111_" + calls.length });
    if (m === "GET" && /^\/ph\d+$/.test(p)) return J({ images: [{ width: 720, source: "https://cdn/x720.jpg" }, { width: 1080, source: "https://cdn/x1080.jpg" }] });
    if (m === "POST" && p === "/111/feed") return J({ id: "111_feed" });
    if (m === "POST" && p === "/111/video_reels") return J(o.body.get("upload_phase") === "start" ? { video_id: "v1", upload_url: "https://rupload.facebook.com/video-upload/v24.0/v1" } : { success: true });
    if (s.startsWith("https://rupload.facebook.com/")) { if (!String(o.headers.Authorization).startsWith("OAuth ")) return J({}, 401); return J({ success: true }); }
    if (m === "GET" && p === "/v1") return J({ permalink_url: "/reel/v1", status: { video_status: "ready" } });
    if (m === "POST" && p === "/222/media") return J({ id: "c" + calls.length, uri: "https://rupload.facebook.com/ig-api-upload/v24.0/c" + calls.length });
    if (m === "GET" && /^\/c\d+$/.test(p)) return J({ status_code: "FINISHED" });
    if (m === "POST" && p === "/222/media_publish") { const id = "m" + calls.length; igPosts.push({ id, caption: o.body.get("creation_id") }); return J({ id }); }
    if (m === "GET" && /^\/m\d+$/.test(p)) return J({ permalink: "https://www.instagram.com/p/" + p.slice(1) });
    if (m === "GET" && p === "/222/media") return J({ data: [] });
    if (m === "GET" && p === "/111/posts") return J({ data: [] });
    if (m === "GET" && p === "/222/content_publishing_limit") return J({ data: [{ quota_usage: 1, config: { quota_total: 100 } }] });
    return J({ error: { message: "unexpected " + m + " " + p } }, 400);
  };
  IO.now = () => clock; IO.sleep = async () => {}; const logs = []; IO.log = (...a) => logs.push(a.join(" "));
  IO.env = { META_PUBLISH_TOKEN: "SECRET-TOKEN", SOCIAL_SELFTEST: "1" };
  let n = 0, fail = 0; const ck = (c, m) => { n++; if (!c) { fail++; console.log("  ✗ " + m); } };
  const st = () => JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8")).posts;

  let r = await run(tmp);
  ck(r.published === 2, `first run publishes the dealer post twice (FB + IG), got ${r.published}`);
  ck(logs.filter(l => l.includes("[tell day social:done:2026-10-22-dealer-facebook+instagram]") && l.includes("עלה פוסט (dealer)") && l.includes("פייסבוק: https://") && l.includes("אינסטגרם: https://")).length === 1, "one Telegram line for the item, with both links");
  ck(logs.some(l => l.includes("[tell day social:remind:2026-10-22-tiktok]") && l.includes("פרומפט הטיקטוק")) && st()["2026-10-22/tiktok/telegram"]?.status === "done", "the TikTok reminder goes out once at its time");
  ck(calls.includes("GET /go/fb"), "the link in the Facebook caption was checked before the post");
  ck(st()["2026-10-22/dealer/facebook"].status === "done" && st()["2026-10-22/dealer/instagram"].status === "done", "dealer post marked done on both");
  ck(sent.some(b => b.message === "פוסט לסוחרים luchit.app/go/fb") && sent.some(b => b.caption === "פוסט לסוחרים"), "each network gets its own caption");
  ck(!st()["2026-10-22/carousel/facebook"], "the carousel is not due yet");
  ck(!logs.join("\n").includes("SECRET-TOKEN") && !calls.join(" ").includes("SECRET"), "the token never appears in logs or paths");
  ck(calls.includes("GET /ph2") || calls.some(c => /^GET \/ph\d+$/.test(c)), "Instagram image went through a Page photo address");
  logs.length = 0; calls.length = 0; r = await run(tmp);
  ck(r.published === 0 && !calls.some(c => c.startsWith("POST")), "a second run posts nothing again");
  ck(!logs.some(l => l.includes("social:remind")), "the reminder is not sent twice");

  clock = T("2026-10-26T18:45:00Z"); failNext = 1; calls.length = 0;
  r = await run(tmp);
  ck(st()["2026-10-22/carousel/facebook"].status === "done", "carousel on Facebook done");
  ck(calls.includes("POST /111/feed") && calls.filter(c => c === "POST /111/photos").length === 2 + 2, "Facebook carousel: 2 unpublished photos + feed post; Instagram: 2 photo addresses");
  ck(st()["2026-10-22/carousel/instagram"].status === "done" && st()["2026-10-22/carousel/instagram"].tries === 1, "a transient publish error is retried inside the call");

  clock = T("2026-10-27T06:20:00Z"); r = await run(tmp);
  ck(st()["2026-10-22/story/instagram"].status === "done", "story published");

  clock = T("2026-10-29T18:35:00Z"); calls.length = 0; r = await run(tmp);
  ck(st()["2026-10-22/reel/facebook"].link === "https://www.facebook.com/reel/v1", "Facebook reel link from permalink_url");
  ck(calls.filter(c => c.startsWith("POST /video-upload") || c.startsWith("POST /ig-api-upload")).length === 2, "reel bytes uploaded once to each network");
  ck(st()["2026-10-22/reel/instagram"].status === "done", "Instagram reel done");

  // missed: an item more than LATE_MS late is never posted
  const k2 = path.join(tmp, "kits", "2026-10-15"); fs.mkdirSync(k2); fs.writeFileSync(path.join(k2, "a.png"), "x");
  fs.writeFileSync(path.join(k2, "autopost.json"), JSON.stringify({ items: [{ id: "old", type: "image", at: "2026-10-20T06:30:00Z", targets: ["facebook"], files: ["a.png"], caption: "ישן" }] }));
  calls.length = 0; r = await run(tmp);
  ck(st()["2026-10-15/old/facebook"].status === "missed" && !calls.some(c => c.startsWith("POST /111")), "a stale item is marked missed, not posted");

  // dedupe: a retry finds the earlier post on the account
  const k3 = path.join(tmp, "kits", "2026-10-30"); fs.mkdirSync(k3); fs.writeFileSync(path.join(k3, "b.png"), "x"); fs.writeFileSync(path.join(k3, "b.ig.jpg"), "x");
  fs.writeFileSync(path.join(k3, "autopost.json"), JSON.stringify({ items: [{ id: "dup", type: "image", at: "2026-10-29T18:00:00Z", targets: ["instagram"], files: ["b.png"], caption: "כבר עלה" }] }));
  const s0 = JSON.parse(fs.readFileSync(path.join(tmp, "state.json"), "utf8")); s0.posts["2026-10-30/dup/instagram"] = { tries: 1, err: "died" }; fs.writeFileSync(path.join(tmp, "state.json"), JSON.stringify(s0));
  const realFetch = IO.fetch;
  IO.fetch = async (u, o = {}) => new URL(String(u)).pathname.endsWith("/222/media") && (o.method || "GET") === "GET"
    ? J({ data: [{ id: "m9", caption: "כבר  עלה", timestamp: "2026-10-29T18:05:00Z", permalink: "https://www.instagram.com/p/m9" }] }) : realFetch(u, o);
  calls.length = 0; r = await run(tmp);
  ck(st()["2026-10-30/dup/instagram"].status === "done" && st()["2026-10-30/dup/instagram"].id === "m9" && !calls.includes("POST /222/media_publish"), "a retry that finds the post on the account does not post again");
  IO.fetch = realFetch;

  // a dead link holds the post with one alert; it goes out once the link answers
  const k7 = path.join(tmp, "kits", "2026-10-29"); fs.mkdirSync(k7); fs.writeFileSync(path.join(k7, "g.png"), "x");
  fs.writeFileSync(path.join(k7, "autopost.json"), JSON.stringify({ items: [{ id: "link", type: "image", at: "2026-10-29T18:30:00Z", targets: ["facebook"], files: ["g.png"], caption: "בדיקה https://luchit.app/go/fb?c=test." }] }));
  // the site does not answer: nothing goes out, one quiet line, retried next run
  siteStatus = 503; logs.length = 0; calls.length = 0; r = await run(tmp);
  ck(!st()["2026-10-29/link/facebook"]?.status && r.summary.includes("held: luchit.app does not answer") && logs.some(l => l.includes("social:held:site")) && !calls.includes("POST /111/photos"), "site down: posts wait");
  siteStatus = 200;
  linkStatus = 503; logs.length = 0; calls.length = 0; r = await run(tmp);
  ck(!st()["2026-10-29/link/facebook"]?.status && logs.some(l => l.includes("social:fail:link-2026-10-29-link") && l.includes("https://luchit.app/go/fb?c=test")) && !calls.includes("POST /111/photos"), "a dead link: the post waits, one alert");
  logs.length = 0; r = await run(tmp);
  ck(!logs.some(l => l.includes("social:fail:link")), "no second link alert");
  // a halted Production rollout holds items that promote an app version; others still go out
  ck((await (async () => { alertState = { items: { "prod:halt:130": { last: new Date(clock - 36e5).toISOString() } } }; const g = await gates(); alertState = null; return g.halt === "prod:halt:130"; })()), "a recent prod:halt is read");
  ck((await (async () => { alertState = { items: { "prod:halt:130": { last: new Date(clock - HALT_MS - 1).toISOString() } } }; const g = await gates(); alertState = null; return g.halt === ""; })()), "an old prod:halt is not");
  linkStatus = 200; r = await run(tmp);
  ck(st()["2026-10-29/link/facebook"]?.status === "done", "the link answers again: the post goes out");
  ck(captionLinks("ראו luchit.app/go/ig?c=a, וגם https://play.google.com/store/apps/details?id=x. ו-@luchit.app").join(" ") === "https://luchit.app/go/ig?c=a https://play.google.com/store/apps/details?id=x", "caption links: bare luchit.app paths and full URLs, no handles, no trailing punctuation");

  // a dry run writes nothing
  const k4 = path.join(tmp, "kits", "2026-10-31"); fs.mkdirSync(k4); fs.writeFileSync(path.join(k4, "c.png"), "x");
  fs.writeFileSync(path.join(k4, "autopost.json"), JSON.stringify({ items: [{ id: "dry", type: "image", at: "2026-10-29T18:30:00Z", targets: ["facebook"], files: ["c.png"], caption: "יבש" }] }));
  IO.env.DRY_RUN = "1"; calls.length = 0; r = await run(tmp); delete IO.env.DRY_RUN;
  ck(!calls.some(c => c.startsWith("POST")) && !st()["2026-10-31/dry/facebook"], "a dry run posts and records nothing");

  // needs_live: held (one alert) until Google Play shows the version at 100% on production; missed when it never comes
  const crypto = await import("node:crypto");
  const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const k6 = path.join(tmp, "kits", "2026-11-02"); fs.mkdirSync(k6); fs.writeFileSync(path.join(k6, "e.png"), "x"); fs.writeFileSync(path.join(k6, "f.png"), "x");
  fs.writeFileSync(path.join(k6, "autopost.json"), JSON.stringify({ items: [
    { id: "gated", type: "image", at: "2026-10-29T18:30:00Z", targets: ["facebook"], files: ["e.png"], caption: "גרסה", needs_live: "1.37" },
    { id: "never", type: "image", at: "2026-10-29T18:30:00Z", targets: ["facebook"], files: ["f.png"], caption: "לעולם לא", needs_live: "1.40" } ],
    reminders: [{ id: "tt", at: "2026-10-29T18:00:00Z", until: "2026-10-31T18:00:00Z", text: "טיקטוק אחרי הגרסה", needs_live: "1.37" }] }));
  let releases = [{ name: "127 (1.37)", status: "inProgress", userFraction: 0.2 }, { name: "123 (1.36)", status: "completed" }];
  IO.fetch = async (u, o = {}) => {
    const s = String(u);
    if (s.startsWith("https://oauth2.googleapis.com/")) { calls.push("POST google-token"); return J({ access_token: "GOOGLE-TOKEN" }); }
    if (s.startsWith("https://androidpublisher.googleapis.com/")) {
      if (o.method === "POST") { calls.push("POST play-edit"); return J({ id: "E1" }); }
      if (o.method === "DELETE") { calls.push("DELETE play-edit " + s.endsWith("/edits/E1")); return J({}); }
      calls.push("GET play-releases " + (o.headers?.authorization === "Bearer GOOGLE-TOKEN" && s.endsWith("/edits/E1/tracks/production"))); return J({ releases }); }
    return realFetch(u, o);
  };
  const gated = () => st()["2026-11-02/gated/facebook"] || {};
  logs.length = 0; calls.length = 0; r = await run(tmp);
  ck(!gated().status && gated().held && logs.some(l => l.includes("social:held:2026-11-02-gated")) && !calls.includes("POST google-token"), "no Play key: held with one alert, Play not called");
  IO.env.SHIP_SA_JSON = JSON.stringify({ client_email: "ship@x.iam.gserviceaccount.com", private_key: privateKey });
  logs.length = 0; calls.length = 0; clock = T("2026-10-29T19:00:00Z"); r = await run(tmp);
  ck(!gated().status && !logs.some(l => l.includes("social:held")) && calls.includes("GET play-releases true"), "1.37 at 20% of users: still held, no second alert");
  ck(calls.includes("DELETE play-edit true") && !calls.some(c => c.includes(":commit")), "the edit opened to read the track is deleted, never committed");
  ck(calls.filter(c => c === "POST google-token").length === 1, "Google Play is read once per run");
  releases = [{ name: "127 (1.37)", status: "completed" }];
  clock = T("2026-10-29T21:00:00Z"); r = await run(tmp);
  ck(gated().status === "done" && !st()["2026-11-02/never/facebook"]?.status, "1.37 at 100%: the gated post goes out, the 1.40 one still waits");
  ck(st()["2026-11-02/tt/telegram"]?.status === "done", "a reminder that waits for a version goes out once the version is live");
  clock = T("2026-10-30T01:00:00Z"); logs.length = 0; r = await run(tmp);
  ck(st()["2026-11-02/never/facebook"].status === "missed" && logs.some(l => l.includes("social:missed:2026-11-02-never") && l.includes("1.40")), "never live within 6 h: missed, the alert names the version");
  ck(!logs.join("\n").includes("GOOGLE-TOKEN") && !logs.join("\n").includes("PRIVATE KEY"), "the Google token and key never appear in logs");
  ck(vcmp("1.37", "1.4") > 0 && vcmp("1.37.0", "1.37") === 0 && vcmp("1.36", "1.37") < 0, "versions compare part by part");
  delete IO.env.SHIP_SA_JSON;

  // a Page token (no business portfolio): /me is the Page, Instagram comes with it, /me/accounts is never called
  const fetch0 = IO.fetch; calls.length = 0;
  IO.fetch = async (u, o = {}) => new URL(String(u)).pathname.replace(/^\/v[\d.]+/, "") === "/me"
    ? (calls.push("GET /me"), J({ id: "111", name: "לוחית", instagram_business_account: { id: "222", username: "luchit.app" } })) : fetch0(u, o);
  const PA = await accounts("PAGE-TOKEN");
  ck(PA.kind === "page" && PA.page.id === "111" && PA.page.token === "PAGE-TOKEN" && PA.ig?.id === "222" && !calls.includes("GET /me/accounts"), "a Page token is used as is, with its Instagram account");
  IO.env.META_PAGE_ID = "999"; let pthrew = false; try { await accounts("PAGE-TOKEN"); } catch { pthrew = true; } delete IO.env.META_PAGE_ID;
  ck(pthrew, "a Page token of another Page than META_PAGE_ID is refused");
  IO.fetch = fetch0;
  const UA = await accounts("USER-TOKEN");
  ck(UA.kind === "user" && UA.page.token === "PAGE", "a user token still finds the Page through /me/accounts");

  // Instagram business login: its own token (no Page link), media from the public queue, weekly refresh sealed in state.json
  {
    const q2 = path.join(tmp, "q2"), kd = path.join(q2, "kits", "2026-11-05"); fs.mkdirSync(kd, { recursive: true });
    for (const f of ["post.png", "post.ig.jpg", "reel.mp4", "cover.png", "cover.ig.jpg", "story.png", "story.ig.jpg", "fb.png", "ig.png", "ig.ig.jpg"]) fs.writeFileSync(path.join(kd, f), "x");
    const items = [
      { id: "post", type: "image", at: "2026-11-08T18:00:00Z", targets: ["facebook", "instagram"], files: ["post.png"], caption: "פוסט" },
      { id: "reel", type: "reel", at: "2026-11-08T18:00:00Z", targets: ["facebook", "instagram"], files: ["reel.mp4"], cover: "cover.png", caption: "ריל" },
      { id: "story", type: "story", at: "2026-11-08T18:00:00Z", targets: ["instagram"], files: ["story.png"] },
      { id: "both", type: "image", at: "2026-11-16T18:00:00Z", targets: ["facebook", "instagram"], files: ["ig.png"], caption: "שניהם" },
    ];
    fs.writeFileSync(path.join(kd, "autopost.json"), JSON.stringify({ items }));
    const igc = [], used = [], st2 = () => JSON.parse(fs.readFileSync(path.join(q2, "state.json"), "utf8"));
    let refreshes = 0, refreshBad = false, n2 = 0;
    const tok = (u, o) => u.searchParams.get("access_token") || o.body?.get?.("access_token");
    IO.fetch = async (u0, o = {}) => {
      const u = new URL(String(u0)), m = o.method || "GET", p = u.pathname.replace(/^\/v[\d.]+/, ""), t = tok(u, o);
      if (u.host === "graph.instagram.com") {
        used.push(t); n2++;
        if (!["IG-OLD", "IG-NEW"].includes(t)) return J({ error: { message: "Invalid OAuth access token", type: "OAuthException", code: 190 } }, 400);
        if (p === "/refresh_access_token") { refreshes++; return refreshBad ? J({ error: { message: "Session has expired", type: "OAuthException", code: 190 } }, 400) : J({ access_token: "IG-NEW", token_type: "bearer", expires_in: 5184000 }); }
        if (p === "/me") return J({ id: "9", user_id: "333", username: "luchit.app" });
        if (m === "POST" && p === "/333/media") { igc.push(Object.fromEntries(o.body)); return J({ id: "ic" + n2 }); }
        if (m === "GET" && /^\/ic\d+$/.test(p)) return J({ status_code: "FINISHED" });
        if (m === "POST" && p === "/333/media_publish") return J({ id: "im" + n2 });
        if (m === "GET" && /^\/im\d+$/.test(p)) return J({ permalink: "https://www.instagram.com/p/im" + n2 });
        if (m === "GET" && p === "/333/media") return J({ data: [] });
        if (m === "GET" && p === "/333/content_publishing_limit") return J({ data: [{ quota_usage: 2, config: { quota_total: 100 } }] });
        return J({ error: { message: "unexpected " + m + " " + p } }, 400);
      }
      if (u.host === "graph.facebook.com" && p === "/debug_token") return J({ data: { type: "PAGE", is_valid: true, expires_at: t === "PAGE-TOKEN" ? 0 : 1798000000 } });
      if (u.host === "graph.facebook.com" && p === "/me")
        return t === "PAGE-TOKEN" ? J({ id: "111", name: "לוחית" }) : J({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400);
      if (u.host === "graph.facebook.com" && t !== "PAGE-TOKEN") return J({ error: { message: "wrong token " + p } }, 400);
      return realFetch(u0, o);
    };
    IO.env = { META_PUBLISH_TOKEN: ' "PAGE-TOKEN"\n', IG_PUBLISH_TOKEN: "IG-OLD\n", GITHUB_REPOSITORY: "ddsabag/vehicle-app", SOCIAL_SELFTEST: "1" };
    clock = T("2026-11-01T10:00:00Z"); logs.length = 0; calls.length = 0;
    await run(q2);
    ck(refreshes === 0 && st2().ig?.since && !st2().ig.tok, "a new Instagram secret is not refreshed at once (Instagram needs it 24 h old)");
    clock = T("2026-11-08T18:10:00Z"); igc.length = 0; used.length = 0; calls.length = 0;
    r = await run(q2);
    const raw = f => `https://raw.githubusercontent.com/ddsabag/vehicle-app/social-queue/kits/2026-11-05/${f}`;
    ck(refreshes === 1 && igToken(st2()) === "IG-NEW", "after a week the token is refreshed and the new one is kept");
    ck(!fs.readFileSync(path.join(q2, "state.json"), "utf8").match(/IG-NEW|IG-OLD|PAGE-TOKEN/), "state.json holds the token only sealed");
    ck(used.slice(1).every(t => t === "IG-NEW"), "Instagram calls after the refresh use the new token");
    ck(igc.some(c => c.image_url === raw("post.ig.jpg") && c.caption === "פוסט"), "Instagram image = the queue's JPEG copy");
    ck(igc.some(c => c.media_type === "REELS" && c.video_url === raw("reel.mp4") && c.cover_url === raw("cover.ig.jpg") && !c.upload_type), "Instagram reel = video_url from the queue, cover as JPEG");
    ck(igc.some(c => c.media_type === "STORIES" && c.image_url === raw("story.ig.jpg")), "Instagram story = the queue's JPEG copy");
    ck(!calls.some(c => c.includes("ig-api-upload")) && calls.includes("POST /111/photos") && calls.some(c => c.startsWith("POST /video-upload")), "no Instagram byte upload; Facebook posts with the Page token");
    ck(["post/facebook", "post/instagram", "reel/facebook", "reel/instagram", "story/instagram"].every(k => st2().posts["2026-11-05/" + k]?.status === "done"), "all five targets done");
    ck(!logs.join("\n").match(/IG-NEW|IG-OLD|PAGE-TOKEN/), "no token in the logs");
    clock = T("2026-11-08T19:10:00Z"); r = await run(q2);
    ck(refreshes === 1, "no second refresh within the week");
    // a refused refresh: one alert, the current token keeps working, no new try for 6 h
    refreshBad = true; clock = T("2026-11-16T18:05:00Z"); logs.length = 0;
    IO.env.META_PUBLISH_TOKEN = "PAGE-EXPIRED";
    r = await run(q2);
    ck(refreshes === 2 && logs.some(l => l.includes("social:fail:token-instagram")) && st2().ig.tried, "a refused refresh alerts once and is recorded");
    ck(st2().posts["2026-11-05/both/instagram"]?.status === "done" && !st2().posts["2026-11-05/both/facebook"]?.status, "Facebook refused: Instagram still publishes, Facebook waits");
    ck(logs.some(l => l.includes("social:fail:token-facebook")), "the refused Facebook token gets its own alert");
    clock = T("2026-11-16T19:05:00Z"); IO.env.META_PUBLISH_TOKEN = "PAGE-TOKEN"; r = await run(q2);
    ck(refreshes === 2 && st2().posts["2026-11-05/both/facebook"]?.status === "done", "no refresh retry within 6 h; Facebook catches up when the token works");
    // check: both networks, the sealed token, the quota
    IO.env.QUEUE = q2; logs.length = 0;
    const c = await check();
    ck(c.ok && logs.some(l => l.includes("@luchit.app (טוקן נפרד)") && l.includes("העמוד לוחית") && l.includes("2 מתוך 100") && l.includes("לא פג")), "check reports both networks, the Instagram quota and a Page token that does not expire");
    IO.env.META_PUBLISH_TOKEN = "EAAbad token"; logs.length = 0;
    const c2 = await check();
    ck(!c2.ok && logs.some(l => l.includes("12 תווים") && l.includes("מתחיל ב-EAA") && l.includes("רווחים")) && !logs.join("\n").includes("EAAbad"), "a refused token is described by its shape, never shown");
    IO.env.META_PUBLISH_TOKEN = JSON.stringify({ data: [{ name: "אחר", access_token: "OTHER", id: "1" }, { name: "לוחית", access_token: "PAGE-TOKEN", id: "111" }], paging: { cursors: { before: "a", after: "b" } } }, null, 2);
    ck(secretInfo("META_PUBLISH_TOKEN").how === "extracted" && (await connect()).page?.id === "111", "the whole me/accounts answer pasted as the secret: the לוחית Page's token is taken out of it");
    IO.env.META_PUBLISH_TOKEN = '"access_token": "EAAxyz' + "1".repeat(60) + '",';
    ck(secret("META_PUBLISH_TOKEN") === "EAAxyz" + "1".repeat(60), "a token pasted with its JSON key around it is taken out of it");
    IO.env.META_PUBLISH_TOKEN = "PAGE-TOKEN";
    delete IO.env.QUEUE;
    IO.env.IG_PUBLISH_TOKEN = "IG-OTHER";
    ck(igToken(st2()) === "IG-OTHER" && unseal(crypto.createHash("sha256").update("x").digest(), st2().ig.tok) === null, "a replaced secret wins over the sealed token; a wrong key opens nothing");
    // no Instagram token and no Page link: the Instagram target fails with one alert, Facebook still posts
    delete IO.env.IG_PUBLISH_TOKEN;
    const kd2 = path.join(q2, "kits", "2026-11-20"); fs.mkdirSync(kd2); for (const f of ["a.png", "a.ig.jpg"]) fs.writeFileSync(path.join(kd2, f), "x");
    fs.writeFileSync(path.join(kd2, "autopost.json"), JSON.stringify({ items: [{ id: "noig", type: "image", at: "2026-11-20T08:00:00Z", targets: ["facebook", "instagram"], files: ["a.png"], caption: "בלי אינסטגרם" }] }));
    clock = T("2026-11-20T08:05:00Z"); logs.length = 0; r = await run(q2);
    ck(st2().posts["2026-11-20/noig/instagram"]?.status === "failed" && st2().posts["2026-11-20/noig/facebook"]?.status === "done" && logs.some(l => l.includes("social:fail:notoken-instagram")), "no Instagram connection: that target fails with an alert, Facebook posts");
    IO.fetch = realFetch; IO.env = { META_PUBLISH_TOKEN: "SECRET-TOKEN", SOCIAL_SELFTEST: "1" };
  }

  // validation
  const bad = (it, m) => { try { validate({ items: [it] }, kit); ck(false, "should reject: " + m); } catch { ck(true, m); } };
  bad({ id: "x", type: "image", at: "2026-10-25T08:30:00", targets: ["facebook"], files: ["dealer-post.png"], caption: "a" }, "time without a zone");
  bad({ id: "x", type: "carousel", at: "2026-10-25T08:30:00Z", targets: ["facebook"], files: ["carousel-01.png"], caption: "a" }, "carousel with one file");
  bad({ id: "x", type: "image", at: "2026-10-25T08:30:00Z", targets: ["linkedin"], files: ["dealer-post.png"], caption: "a" }, "unknown target");
  bad({ id: "x", type: "image", at: "2026-10-25T08:30:00Z", targets: ["facebook"], files: ["../secret.png"], caption: "a" }, "path outside the kit");
  bad({ id: "x", type: "image", at: "2026-10-25T08:30:00Z", targets: ["facebook"], files: ["dealer-post.png"], caption: "#a ".repeat(31) }, "more than 30 hashtags");
  bad({ id: "x", type: "reel", at: "2026-10-25T08:30:00Z", targets: ["facebook"], files: ["dealer-post.png"], caption: "a" }, "reel that is not mp4");
  bad({ id: "x", type: "image", at: "2026-10-25T08:30:00Z", targets: ["facebook"], files: ["dealer-post.png"], caption: "a", needs_live: "soon" }, "needs_live that is not a version");
  fs.writeFileSync(path.join(kit, "plain.png"), "x");
  let qbad = false; try { validate({ items: [{ id: "x", type: "image", at: "2026-10-25T08:30:00Z", targets: ["instagram"], files: ["plain.png"], caption: "a" }] }, kit, { queue: true }); } catch { qbad = true; }
  ck(qbad, "a queued Instagram image without its JPEG copy is rejected");
  let rbad = 0; for (const rr of [{ id: "x", at: "2026-10-25 08:30", text: "a" }, { id: "x", at: "2026-10-25T08:30:00Z", text: "" }, { id: "x", at: "2026-10-25T08:30:00Z", text: "a", link: "http://x" }])
    try { validateReminders({ reminders: [rr] }); } catch { rbad++; }
  ck(rbad === 3, "reminders need a zoned time, a text and an https link");

  // auth failure: one alert, nothing posted, the run fails
  IO.env.META_PUBLISH_TOKEN = "EXPIRED";
  const k5 = path.join(tmp, "kits", "2026-11-01"); fs.mkdirSync(k5); fs.writeFileSync(path.join(k5, "d.png"), "x");
  fs.writeFileSync(path.join(k5, "autopost.json"), JSON.stringify({ items: [{ id: "auth", type: "image", at: "2026-10-29T18:30:00Z", targets: ["facebook"], files: ["d.png"], caption: "טוקן" }] }));
  IO.fetch = async (u, o = {}) => new URL(String(u)).pathname.endsWith("/me/accounts") ? J({ error: { message: "Error validating access token", type: "OAuthException", code: 190 } }, 400) : realFetch(u, o);
  logs.length = 0; let threw = false; try { await run(tmp); } catch { threw = true; }
  ck(threw && logs.some(l => l.includes("social:fail:token")), "an invalid token fails the run with one alert");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`social-publish selftest: ${n - fail}/${n} passed`);
  return fail ? 1 : 0;
}

// ---- cli ----
const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(url.fileURLToPath(import.meta.url));
if (isMain) {
  const cmd = process.argv[2];
  const go = async () => {
    if (cmd === "selftest") return selftest();
    if (cmd === "check") { const r = await check(); return r.ok ? 0 : 1; }
    if (cmd === "run") {
      const q = IO.env.QUEUE || "queue";
      if (!fs.existsSync(q)) { IO.log("no social-queue checkout: nothing to publish"); return 0; }
      const r = await run(q);
      if (IO.env.GITHUB_STEP_SUMMARY && r.summary.length) fs.appendFileSync(IO.env.GITHUB_STEP_SUMMARY, `### Social publish\n${r.summary.map(s => "- " + s).join("\n")}\n`);
      return 0;
    }
    console.error("usage: node social-publish.mjs run|check|selftest"); return 2;
  };
  go().then(c => process.exit(c), e => { console.error(scrub(e.stack || e.message)); process.exit(1); });
}
