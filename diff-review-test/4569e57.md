### Diff review: diff-review-test 4569e57 (before release): 3 points, 0 high

Base 42be57f → 4569e57. 9 files read. [run](https://github.com/ddsabag/vehicle-app/actions/runs/41351799624). Suggestions only: nothing here blocks a release.

> The cutHtml change is a sound fix for RTL names, but the chead hide logic likely no longer works, and inspect.yml becomes a second copy of the diff-review workflow that would replace the dataset tool on main; the review script also has a minor sort bug.

| severity | rule | where | what | fix |
|---|---|---|---|---|
| medium | bug | [.github/workflows/inspect.yml:1](https://github.com/ddsabag/vehicle-app/blob/4569e57426219c78e214fb62e59dc38621124208/.github/workflows/inspect.yml#L1) | inspect.yml is replaced with a full copy of diff-review.yml, including the `push: branches: [next]` trigger. If this branch reaches main, the 'Inspect datasets' tool disappears (bot-names.json still names it), and every push to next runs two review workflows. | Restore the original inspect.yml before release, or limit the probe to a workflow_dispatch on diff-review-test only. |
| medium (likely) | bug | [index.html:3262](https://github.com/ddsabag/vehicle-app/blob/4569e57426219c78e214fb62e59dc38621124208/index.html#L3262) | The header name is now `<b class="cut">`, and `.cut,.t b.cut{display:flex}` overrides the UA `[hidden]{display:none}`. Unless a global `[hidden]{display:none!important}` exists, setting `t.hidden = true` no longer hides the name on a narrow phone. | Hide it with `t.style.display = "none"`, or add `.cut[hidden]{display:none}` to the CSS. |
| low | bug | [.github/scripts/diff-review.mjs:129](https://github.com/ddsabag/vehicle-app/blob/4569e57426219c78e214fb62e59dc38621124208/.github/scripts/diff-review.mjs#L129) | The comparator term `(a.confidence === "sure" ? -1 : 1)` is never 0, so the file and line ordering after it is never reached. The comparator is also inconsistent: it returns -1 for any two 'sure' points in both orders. | Use `(a.confidence === "sure" ? 0 : 1) - (b.confidence === "sure" ? 0 : 1)` so equal confidences fall through to the file and line order. |
