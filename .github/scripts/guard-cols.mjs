// Probe (24.10.2026): do the columns data-guard.mjs lists for each dataset exist there? Prints missing ones; column names only, no rows.
const src = (await import("node:fs")).readFileSync(".github/scripts/data-guard.mjs", "utf8");
const sets = [...src.matchAll(/\{ key: "(\w+)", id: "([0-9a-f-]{36})"[^\n]*?use: (\[[^\]]*\])/g)].map(m => ({ key: m[1], id: m[2], use: JSON.parse(m[3]) }));
for (const s of sets) {
  try {
    const j = await (await fetch(`https://data.gov.il/api/3/action/datastore_search?resource_id=${s.id}&limit=0`, { signal: AbortSignal.timeout(30000) })).json();
    const have = new Set((j.result?.fields || []).map(f => f.id)), miss = s.use.filter(c => !have.has(c));
    console.log(`${s.key.padEnd(10)} total=${j.result?.total} ${miss.length ? "MISSING " + miss.join(",") : "ok"}${miss.length ? " | has: " + [...have].join(",") : ""}`);
  } catch (e) { console.log(`${s.key.padEnd(10)} unreadable ${e.message}`); }
}
