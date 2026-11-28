### Visual review (app): 3 findings, 2 new

2026-11-28 09:32 UTC, screenshots of https://github.com/ddsabag/vehicle-app/actions/runs/46130365245. Report only: nothing here fails a run.

Shots: 78; kept their verdict (unchanged): 49; first look now: 29; second look now: 2; waiting for a first look: 0; waiting for a second look: 0; with first-look points under the bar only (not sent on): 25; points the second look rejected: 2; typos dropped as misreadings (a word the app's text does not have): 3; requests without an answer: 0.
This month: 1289 of 4000 first looks and 35 of 400 second looks.

| kind | severity | shot | what |
|---|---|---|---|
| **new** layout | low | `api31/360-f130__light__cars__tour-cars` part 1 | top of the white card above the table header, empty area before the divider line: A large empty block sits at the top of the card above the divider and the table header, where there is no content. |
| **new** layout | low | `api35/360-f130__light__cars__tour-cars` part 1 | top of the white table card, between the card's top edge and the divider line ab: A large empty band at the top of the card, with only a thin divider line and no title or content, looks like missing content. |
| cut_text | medium | `api35/360-f130__light__cars__tour-cars` part 1 | the table header of the car card, leftmost column header, at the left edge of th: The header is cut: it shows only "טיפ" over "אחו", while the full word should read "טיפול אחרון". Letters are missing at the end of both lines, so the column title cannot be read. |

Points the second look rejected (listed while the review is report only, to measure what it misses):

| shot | the first look's point | why it was rejected |
|---|---|---|
| `api31/360-f130__light__cars__tour-cars` | The last column header, which should read "טיפול אחרון", is clipped at the left edge of the card and wraps into two broken fragments, so the word is partly hidd | The text is clipped at the left edge of the card: the letters 'ול' and 'ר' are missing, so the header reads 'טיפ' and 'אחו' instead of 'טיפול אחרון'. The table runs past the card's edge. At 130% font |
| `api31/411-extra__auto-light` | The footer sentence ends at "ואינו מחליף" with no object, and the line sits right against the bottom navigation bar. The rest of the sentence looks cut off, hid | The sentence continues below the visible area and is partly hidden by the bottom navigation bar. That is ordinary scrolling content under a fixed bar, not a defect, and the visible line's letters are |
