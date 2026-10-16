// Writes the hand-entered social numbers to metrics.json on the flashes branch (metrics.social), which /live reads.
// Keeps the previous week's TikTok numbers as "prev" so the dashboard can show the change.
import { putMetric } from "./flash.mjs";
const num = v => { const n = Number(String(v ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) && n >= 0 && n < 1e9 ? Math.round(n) : 0; };
const tiktok = { followers: num(process.env.TT_FOLLOWERS), views7: num(process.env.TT_VIEWS), likes7: num(process.env.TT_LIKES), profile7: num(process.env.TT_PROFILE), videos: num(process.env.TT_VIDEOS) };
const API = "https://api.github.com", tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
let prev = null;
try {
  const r = await fetch(`${API}/repos/${repo}/contents/metrics.json?ref=flashes`, { headers: { authorization: "Bearer " + tok, accept: "application/vnd.github.raw+json", "user-agent": "luchit-social" } });
  if (r.ok) { const m = await r.json(); if (m.social && m.social.tiktok) { const { prev: _p, ...cur } = m.social.tiktok; prev = cur; } }
} catch {}
const ok = await putMetric("social", { tiktok: { ...tiktok, ...(prev ? { prev } : {}) } });
console.log(ok ? "social stats saved" : "social stats not saved", JSON.stringify(tiktok));
