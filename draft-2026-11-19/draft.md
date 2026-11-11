# טיוטת ערכה 6 ליום חמישי 2026-11-19

Draft by claude-opus-5-5 the night before. Review every line; the Thursday run renders, films, lints the whole kit and decides.

## Pain
שתי מודעות שנראות אותו דבר: איך יודעים מה הסיפור של כל רכב

This pain is story_data, the next unused buyer pain in audience_rule.buyer_pains after kit 5's seller_q (home_checks appeared only as kit 5's Sunday post angle). On Yad2 and in the Facebook groups, an Israeli buyer looking for a used Toyota Corolla sees a wall of near-identical ads: same model, same year, similar price, a few lines of text and photos. The buyer then has to choose which seller to call and which trip to make, and that is a decision under uncertainty. Israelis also carry a strong social fear of overpaying or choosing wrong, so the feeling 'they all look the same, how do I tell them apart' bites. The fleet data makes it concrete: 190,807 active Toyota Corollas are on the road, so the car in the ad is one of very many, and each has its own registered story (hands, ownership type, test date, km recorded at the last test). The week's answer is calm and practical. Type each ad's plate, put the two side by side with the live compare feature (no ranking), and arrive at the meeting with the same picture from the Ministry of Transport data. Nobody is cast as a villain: an ad is short by nature, and the data fills in the rest.

## Picks
- reel: Efficiency/compare: שתי מודעות, אותו דגם [fleet-top-models (+ compare, live in Play production)]
- carousel: Community: קורולה יד שנייה. איך יודעים איזו? [fleet-top-models]
- stories: Community: שתי מודעות, מה ההבדל? [compare (live UI, no numbers)]
- dealer: buyer post (buyer post: השאלות למוכר שהמספר כבר עונה עליהן (ידיים, סוג בעלות, ק"מ בטסט האחרון, ריקול פתוח)): הסיפור של הרכב, לפי המספר [none (structure only, no numbers)]

## Lint (copy only)
Clean after 1 fix round(s).

## Notes
- Lint fix: the reel's visual descriptions no longer contain any digits. Second ranges, the build version, the badge pixel sizes and the end-card hold time became named beats and references (the kit-two gen.py badge spec and the RUNBOOK end-card tail). The exact timings for a reel of about thirty seconds should go into the kit markdown's timed table as timecodes, or into gen.py, which takes them from the kit-two reference.
- Reel line 2: I removed the spoken fleet number from the voice-over, because numbers in words fail the lint. The voice-over now says 'אחד הדגמים הנפוצים על הכביש' (a count statement from the idea title, not a ranking claim). The figure appears on screen only and rests on fleet-top-models fact 0.
- Demo plate: the iron rules list 12-345-67 / 1234567 as demo plates, but the RUNBOOK (which wins) says they belong to a real car since early November. Only 76-543-21 is used. In the reel, the second compared car shows a masked plate. Please confirm that is acceptable, or show the second car with no plate at all.
- Pain = story_data, the next unused buyer pain after kit 5's seller_q. Please confirm the meaning I took from the id: the car's registered story behind a look-alike ad. Its definition in rotation.json was not in my context.
- The Sunday post angle (dealer_angle_cursor) closely overlaps kit 5's carousel of seller questions. To avoid a repeat, I reframed it as 'what is registered / what is left to ask'. Please check whether the cursor actually advanced after bonus kit 5.
- Feature spotlight = השוואה (compare). It was not used in kits 4 or 5. It is live at full Play production rollout, so there is no needs_live. App screens must be recorded fresh from the current production build with mocked data and 76-543-21, and app-record must be switched off the old demo plate first.
- The only number in the copy is 190,807 (fleet-top-models fact 0). Its fetched_at must still be within the lint window when the kit is linted. If it is not, re-run ideas.mjs.
- Not used: fuel prices (VERIFY cautions; the price is from the Delek list, not the regulated price); settlements (no news this week); the new recall campaigns (mostly trucks and imports, and they have no facts). Recalls appear only as the neutral 'ועוד דבר שכדאי לבדוק' discovery, with no numbers and 'בדרך כלל ללא עלות'.
- Golden rule: the seller is never framed as hiding anything, and honest limits (no accidents, liens or theft) are stated. There is no winner or recommendation wording; the compare is described as 'בלי דירוג'.
- Schedule: Sun 22.11 08:30 buyer post · Mon 23.11 20:30 carousel · Tue 24.11 08:15 stories · Thu 26.11 20:30 reel. TikTok is scheduled after the Cowork run on Fri 20.11. Every go/ topic is c=story_data.
