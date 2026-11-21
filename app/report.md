### Visual review (app): 4 findings, 1 new

2026-11-21 08:51 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/44886249998. Report only: nothing here fails a run.

Shots: 77; kept their verdict (unchanged): 67; first look now: 10; second look now: 1; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 26; points the second look rejected: 1; typos dropped as misreadings (a word the app's text does not have): 3; requests without an answer: 0.
This month: 970 of 4000 first looks and 21 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| **new** layout | low | `api35/360-f130__light__cars__tour-cars` part 1 | top of the white car list card, above the divider line: A large empty band sits at the top of the card, above the divider line and the table header, with no content in it. It looks like a missing title or toolbar. |
| cut_text | medium | `api31/360-f130__light__cars__tour-cars` part 1 | table header row of the car card, last column at the left edge: The last column header is split over two lines and reads "טיפ" / "אחו". It looks like a longer word (probably טיפול / אחזקה) is cut and its remaining letters are missing, so the column title cannot be read in full. |
| cut_text | medium | `api35/360-f130__light__cars__tour-cars` part 1 | table header row of the car list card, last column at the left edge: The last column header is split over two lines and reads 'טיפ' / 'אחו'. The word looks like 'טיפול אחרון' or similar, and it is cut off at the column edge, so the full header is not readable. |
| layout | low | `api31/360-f130__light__cars__tour-cars` part 1 | top of the car card, above the divider line and the table header: A large empty white area sits at the top of the card, above the line and the table header, where a title or content would be expected. |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `api31/320-f130__dark__home-settings__tour-settings` | The label 'לפי המכשיר' is wider than its segment and runs past the left edge of the grey pill, so its first letters sit outside the control's box and look clipp | The word is complete and legible and sits inside the grey pill with a small margin, so there is no visible cut. |
