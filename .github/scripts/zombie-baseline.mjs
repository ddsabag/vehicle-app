// One-off: run the back-on-road detector from the inspect workflow (zombie.yml can only be dispatched from main).
// State goes to out/zombie and is published with the report on inspect-output; it is then copied to the zombie-data branch.
process.env.DIR = "out/zombie";
await import("./zombie-detector.mjs");
