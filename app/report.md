### Visual review (app): 4 findings, 0 new

2026-11-14 08:05 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/43573582340. Report only: nothing here fails a run.

Shots: 78; kept their verdict (unchanged): 61; first look now: 17; second look now: 0; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 27; points the second look rejected: 1; typos dropped as misreadings (a word the app's text does not have): 2; requests without an answer: 0.
This month: 775 of 4000 first looks and 11 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| cut_text | medium | `api31/360-f130__light__cars__tour-cars` part 1 | the car table's column header at the card's left edge, last column: The last column header is squeezed to the card's left edge and shows "טיפ" over "אחו". The second word looks truncated (probably "אחזקה" or similar), so the header is clipped. |
| cut_text | medium | `api35/360-f130__light__cars__tour-cars` part 1 | table header row of the car card, last column at the left edge: The column header for the last-service column wraps to two lines and shows only "טיפ" and "אחו". The endings of the words ("טיפול אחרון") are cut off at the card's left edge, so the header cannot be read in full. |
| layout | low | `api31/360-f130__light__cars__tour-cars` part 1 | the top of the white table card, above the divider line: A large empty area sits at the top of the card above the divider and the column headers, where a title or content should be. |
| layout | low | `api35/360-f130__light__cars__tour-cars` part 1 | top of the white table card, above the divider line and header row: A large empty white area sits at the top of the card above the divider line, with no content, so the card looks like it is missing a title or content. |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `api35/360-f130__light__home__tour-home` | The subtitle of the recall card is cut at the card's text edge, so the end of the word is hidden; a shortened line ending in an ellipsis is fine, but here the t | The line ends in a clear ellipsis, which is deliberate truncation and not a defect. No letter is drawn partly at the edge. |
