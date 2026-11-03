### Diff review: next 1a9bdcd (push): 1 points, 0 high

Base ee77d8d → 1a9bdcd. 2 files read. [run](https://github.com/ddsabag/vehicle-app/actions/runs/41633717149). Suggestions only: nothing here blocks a release.

> The fb_groups folding is consistent in the snapshot and its selftest, but the worker edit also drops an unrelated bot-board entry and folds Facebook-group tags with a case-sensitive test that does not match camp-data's.

| severity | rule | where | what | fix |
|---|---|---|---|---|
| low (likely) | bug | [worker/live/worker.js:852](https://github.com/ddsabag/vehicle-app/blob/1a9bdcd9836b74b0177bf2998bcb69eabf67583e/worker/live/worker.js#L852) | This campaign-only change also deletes the "recall-explain.yml" entry from the bot-board names (BN). If that workflow still runs, the /live bots board will list it under "אחר" with its raw name instead of "הסברי הריקולים" in the data group. | Restore "recall-explain.yml":["הסברי הריקולים","נתונים"] in BN, unless the workflow was really removed. |

Dropped (not tied to a line the change touched): 1.

- worker/live/worker.js:1103 (a line the change did not touch): The worker's fam() matches /^fbg_[a-z]{1,20}$/ against the raw topic, so it is case-sensitive. camp-data.mjs's family() lowercases first, and its selftest expe…
