// Preview run (inspect.yml, runs from any branch): builds the quarterly new-models article from the live registers and writes it to out/ only, touching nothing else.
// Set QUARTER (for example 2026Q2) to pick a quarter, otherwise the latest closed one is used.
process.env.PREVIEW = "1";
process.argv = [process.argv[0], process.argv[1], "newmodels", ...[process.env.QUARTER, process.env.QUERIES].filter(q => /^\d{4}Q[1-4]$/.test(q || "")).slice(0, 1)];
await import("./magazine-data.mjs");
