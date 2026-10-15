// "Flashes" feed for the live dashboard: the same news the agents send to Telegram, as a short list the dashboard reads (branch "flashes", file flashes.json).
// The repository is public, so only text that is safe to be public goes in: alerts and agent news, never business numbers (the weekly report stays Telegram only).
// It never fails a workflow: any error is only logged. Needs GITHUB_TOKEN (contents: write) and GITHUB_REPOSITORY.
//   import { flash } from "./flash.mjs"; await flash("data", "alert", "text", optionalLink)
//   node flash.mjs <kind> <level> "<text>" [link]       kind: data|infra|content|market|release|experiment|reviews   level: alert|info
const API = "https://api.github.com", BR = "flashes", FILE = "flashes.json", KEEP = 60;
const strip = t => String(t).replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim().slice(0, 280);

export async function flash(kind, level, text, link) {
  if (/הודעת בדיקה|dry run/i.test(String(text))) return false;
  const tok = process.env.GITHUB_TOKEN, repo = process.env.GITHUB_REPOSITORY;
  if (!tok || !repo || process.env.DRY_RUN === "1" || process.env.DRY === "1") return false;
  const h = { authorization: "Bearer " + tok, accept: "application/vnd.github+json", "user-agent": "luchit-flash", "content-type": "application/json" };
  const entry = { t: new Date().toISOString(), k: kind, l: level, x: strip(text), ...(link ? { u: link } : {}) };
  try {
    for (let i = 0; i < 4; i++) {
      let r = await fetch(`${API}/repos/${repo}/contents/${FILE}?ref=${BR}`, { headers: h }), list = [], sha;
      if (r.status === 404) {
        const m = await (await fetch(`${API}/repos/${repo}/git/ref/heads/main`, { headers: h })).json();
        await fetch(`${API}/repos/${repo}/git/refs`, { method: "POST", headers: h, body: JSON.stringify({ ref: "refs/heads/" + BR, sha: m.object.sha }) });   // 422 when another run created it first: fine
      } else if (r.ok) { const j = await r.json(); sha = j.sha; try { list = JSON.parse(Buffer.from(j.content, "base64").toString("utf8")); } catch {} }
      else throw new Error("read " + r.status);
      const body = { message: "flash", branch: BR, content: Buffer.from(JSON.stringify([entry, ...list].slice(0, KEEP))).toString("base64"), ...(sha ? { sha } : {}) };
      const w = await fetch(`${API}/repos/${repo}/contents/${FILE}`, { method: "PUT", headers: h, body: JSON.stringify(body) });
      if (w.ok) return true;
      if (w.status !== 409 && w.status !== 422) throw new Error("write " + w.status);
      await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
  } catch (e) { console.log("flash skipped:", e.message || e); }
  return false;
}

if (process.argv[1] && process.argv[1].endsWith("flash.mjs") && process.argv.length >= 5) {
  const [, , kind, level, text, link] = process.argv;
  console.log((await flash(kind, level, text, link)) ? "flash sent" : "flash not sent");
}
