# Kit visual QA: 2026-10-22

14 images looked at by claude-sonnet-5-5.
2 findings, 10 low-confidence notes. Report only: decide each one by looking at the image.

## Findings
- **low · rtl** · story-02.png · Footer source line at the bottom, 'מקור: מאגרי משרד התחבורה, רכבים פעילים לפי דגם. אוקטובר 2026.': The closing period of the Hebrew sentence sits at the left end, before '2026' in the visual order. The text reads '.2026 אוקטובר', so the punctuation is at the wrong end of the sentence. («אוקטובר 2026.»)
- **low · overlap** · reel-one-line.frame-2of5.jpg · Phone mock, bottom card just above the bottom nav bar, the caption "איור · רכב לדוגמה" sits over a grey placeholder bar: The caption text is drawn over a grey skeleton bar, so the text and the bar overlap and the word "איור" is partly struck through by the bar. («איור · רכב לדוגמה»)

## Low-confidence notes
- layout · carousel-04.png · Bottom right, next to the swipe hint, the 'luchit.app' footer: The footer 'luchit.app' is low-contrast gray text on the dark background; it is small but readable. This is a minor contrast blemish.
- typo · carousel-02.png · swipe hint at bottom left, next to the arrow: The swipe hint "החליקו" has an arrow "←" before it, on its left, which points toward the next slide in right-to-left reading. This is correct, so it is not a defect. Low-confidence note only.
- rtl · carousel-03.png · bottom left, the swipe cue next to the word "החליקו": The swipe arrow "←" points left, which is the correct direction for swiping to the next slide in right-to-left Hebrew, but it sits to the left of the word, so it looks fine. This is only a possible c…
- rtl · carousel-01.png · bottom left, next to the word swipe prompt "החליקו": The arrow "←" sits to the left of "החליקו". In an RTL carousel the next slide is reached by swiping left, so the arrow direction may be fine. The slide is only a weak candidate for an RTL arrow error.
- layout · story-01.png · Bottom of the story: the Google Play badge, the line "זמינה להורדה" above it and the counter "1/3" below it: The Google Play badge and the "1/3" counter sit at about y=1520-1660, inside the bottom 340px (y>1580) that the network's interface covers. The badge is exempt from this rule, but the counter "1/3" i…
- layout · story-02.png · Footer and badge area, y≈1470-1700, in the bottom 340px of the story: The page counter '2/3' and the source line sit within the bottom 340px reserved for the network's UI. The source line is small footer text, which is allowed, and the badge is exempt, so this is only …
- rtl · reel-one-line.frame-3of5.jpg · Headline, second line in yellow: The period sits at the left end of the Hebrew line. In right-to-left text that is the end of the sentence, so this is correct and not a defect. No real issue here.
- rtl · reel-one-line.frame-1of5.jpg · Title, second line, yellow text: The period is at the left end of the line, which is the end of a Hebrew sentence in right-to-left reading, so it is correctly placed. No defect.
- layout · reel-one-line.frame-2of5.jpg · Headline: the period sits at the left end of the yellow word "אחת.": The period is on the left end of the Hebrew word, which is correct for right to left. This is not a defect.
- layout · reel-one-line.frame-5of5.jpg · small Hebrew line under the luchit.app pill, 'וחוסכים נסיעה': The line 'וחוסכים נסיעה' sits below the URL pill and reads as a continuation of 'בודקים לפני שנפגשים.' It is separated from the headline by the URL pill, so the sentence flow is broken and the text o…
