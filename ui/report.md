### Visual review (ui): 1 findings, 0 new

2026-11-28 10:53 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/46134899064. Report only: nothing here fails a run.

Shots: 384; kept their verdict (unchanged): 382; first look now: 2; second look now: 0; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 122; points the second look rejected: 6; typos dropped as misreadings (a word the app's text does not have): 25; requests without an answer: 0.
This month: 2649 of 4000 first looks and 21 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| typo | medium | `rental-now-buy-390-dark` part 4 | the bold paragraph under the 'איך הדגם הזה מחזיק' heading: The sentence reads "ובאחר פחות טוב"; the word should be "ובאחד" ("and in one less good"), or "ובאחר" is a misspelling of "ובאחד". |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `buy-ask-above-buy-320-dark` | The white saved-to-my-cars toast covers the bullet below it, so the start of that question (ending in "על הסטוריה") is hidden behind the toast. | A fixed bar or toast drawn over content that scrolls under it is not a defect. The hidden line shows in full once the page scrolls, and the next part continues the list. |
| `buy-km-low-overview-320-dark` | The toast message sits on top of the card's date value below 'טסט אחרון', hiding most of its digits so only '25' shows. The text under the toast is not readable | The toast is a temporary floating message drawn over content that scrolls under it. It is not a layout defect, so it is not reported. |
| `buy-km-low-overview-390-dark` | The toast "נשמר ברכבים שלי, בסינון לקנייה" sits on top of the registration details. It covers the label starting "עלה לכבי…" and part of the date beneath it, wh | The toast is a temporary floating notification drawn over content that scrolls beneath it, so covering the card is expected and not a defect. |
| `buy-km-low-overview-390-light` | A toast message 'נשמר ברכבים שלי, בסינון לקנייה' sits over the 'עלה לכביש' row and covers the start of its date value, so the date reads '05/2021' with its firs | The toast is a transient floating notification drawn over scrolling content, which is expected behaviour. It is not a layout defect, and the row is not permanently hidden. |
| `buy-km-low-overview-390-light` | The date value is partly covered by the toast, so the leading digits are hidden. | Duplicate of claim 1. The toast floats over the content, so the date is covered, not clipped by its own box. |
| `buy-km-low-specs-390-dark` | The toast message 'נשמר ברכבים שלי, בסינון לקנייה' sits on top of the card below the 'מנוע והנעה' card and covers its header text and icon, so the card's title | The toast is a temporary floating message drawn over content that scrolls beneath it. That is expected, so it is not a defect. |
