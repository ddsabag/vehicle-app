### Visual review (ui): 0 findings, 0 new

2026-11-22 05:40 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/44988276560. Report only: nothing here fails a run.

Shots: 384; kept their verdict (unchanged): 0; first look now: 300; second look now: 4; waiting for a first look: 84; waiting for a second look: 0; with first-look points under the bar only (not sent on): 144; points the second look rejected: 4; typos dropped as misreadings (a word the app's text does not have): 35; requests without an answer: 0.
This month: 1920 of 4000 first looks and 10 of 400 second looks.

No confirmed finding.

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `buy-ask-above-overview-320-dark` | The toast message is drawn over the lower half of both stat cards, hiding their figures (the values under 'ממוצע לשנה' and 'ק״מ בטסט האחרון' are partly covered | The toast is a transient floating message, fixed to the screen and drawn over content that scrolls under it. That is expected behaviour and not a defect. |
| `buy-ask-above-specs-390-dark` | A toast message 'נשמר ברכבים שלי, בסינון לקנייה' sits on top of the engine displacement value and the 'חשמל/בנזין' value, covering the text of the card behind i | The toast is a temporary floating message fixed to the screen, drawn over content that scrolls under it. That is expected behaviour and not a defect. |
| `buy-km-low-overview-320-dark` | The toast message is drawn over the 'טסט אחרון' date value in the רישוי וטסט card, hiding most of the date digits beneath it. | The toast is a temporary message fixed to the screen, drawn over content that scrolls under it. The date is shown in full further down the page (05/2021 at the top of part 2), so this is not a defect. |
| `buy-km-low-overview-390-dark` | The toast 'נשמר ברכבים שלי, בסינון לקנייה' is drawn over the 'עלה לכבי...' label and the date below it, so the label and the date '...05/2021' are partly hidden | The toast is a transient floating notification, fixed to the screen and drawn over scrolling content. Content hidden under such a bar is not a defect. |
