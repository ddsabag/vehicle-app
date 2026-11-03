### Diff review: next ee77d8d (push): 1 points, 0 high

Base 240aae5 → ee77d8d. 1 files read. [run](https://github.com/ddsabag/vehicle-app/actions/runs/41517551535). Suggestions only: nothing here blocks a release.

> The online line now refreshes every 30 seconds through a new /live/now endpoint, and the page reloads at once when the screen comes back; the wiring looks sound, with one small staleness gap.

| severity | rule | where | what | fix |
|---|---|---|---|---|
| low (likely) | bug | [worker/live/worker.js:1336](https://github.com/ddsabag/vehicle-app/blob/ee77d8df8c9cb6638d788bc4b11c8da4048addcd/worker/live/worker.js#L1336) | During the 5-minute quota backoff, onlineNow() returns the old cached answer without throwing. /live/now then sends it without stale:true, so the top line drops the 'נתון אחרון שנשמר' label even though the number may be minutes old. | In the /live/now handler, add stale: Date.now() - onlAt >= 20e3 (or Date.now() < backoffUntil) to the successful response. |
