// reviews-health.mjs: reads luchit-reviews' public /health (no review text, ids or counts) for the ops thread, from a GitHub runner,
// since the ops container cannot reach workers.dev. Opening it on the main address also installs the Telegram webhook when needed.
//   Inspect datasets workflow, script reviews-health.mjs
const U = "https://luchit-reviews.ddsabag.workers.dev/health";
for (let i = 0; i < 2; i++) {
  try {
    const r = await fetch(U, { headers: { "user-agent": "luchit-ops-probe/1" }, signal: AbortSignal.timeout(15000) });
    const t = await r.text();
    console.log(`${new Date().toISOString()} ${r.status} ${t.slice(0, 400)}`);
  } catch (e) { console.log(`${new Date().toISOString()} no answer: ${e.name}`); }
  if (!i) await new Promise(r => setTimeout(r, 5000));
}
