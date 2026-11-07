### Visual review (app): 1 findings, 1 new

2026-11-05 08:59 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/41997892694. Report only: nothing here fails a run.

Shots: 78; kept their verdict (unchanged): 0; first look now: 78; second look now: 2; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 30; points the second look rejected: 1; typos dropped as misreadings (a word the app's text does not have): 2; requests without an answer: 0.
This month: 463 of 4000 first looks and 7 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| **new** cut_text | medium | `api35/411-f200__light__car__check-check` part 1 | top app bar, plate chip at the right edge beside the back chevron: The yellow plate box ends in the middle of the plate number: it shows '12-345-6' with the 6 clipped at the box's border, and the final '7' is drawn outside the box on the page background, next to the chevron. The plate looks broken, though  |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `api35/411-f100__light__home-settings__tour-settings` | The third price input's value box is cut off at the bottom by the sheet's bottom edge; the field and its label 'חשמל (₪ לקוט״ש)' are clipped where the bottom sh | The settings sheet is scrollable and the content simply continues below the screen edge, which is normal scrolling. The visible part of the row is not clipped by its own box. |
