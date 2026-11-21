### Visual review (app): 1 findings, 1 new

2026-11-12 11:15 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/43205940708. Report only: nothing here fails a run.

Shots: 79; kept their verdict (unchanged): 0; first look now: 79; second look now: 2; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 32; points the second look rejected: 1; typos dropped as misreadings (a word the app's text does not have): 1; requests without an answer: 0.
This month: 542 of 4000 first looks and 9 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| **new** cut_text | medium | `api35/360-f130__light__cars__tour-cars` part 1 | table header row of the car card, left-most column header: The header of the last column is meant to read "טיפול אחרון" but shows only "טיפ" and "אחו". The word is wrapped and cut at the card's left edge, so the letters are missing. |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `api35/411-extra__entry__app-link` | A system 'Pixel Launcher isn't responding' dialog covers most of the app screen. This is an Android system dialog, but it blocks the app content and is visibly | The dialog belongs to the Android system (Pixel Launcher), not to the app or website. It is an environment artifact and not a visual defect in the app. The app screen behind it looks intact. |
