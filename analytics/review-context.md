# Known non-behaviour shifts for the Sunday anomaly review

This file is read by `.github/scripts/anomaly-review.mjs` and sent to Claude with every weekly report. The measurement thread keeps it up to date. It is public: shifts and causes only, never business numbers.

- The new app UI is app versions 1.38, 1.38.1, 1.38.2 and 1.38.3. 1.38.3 was released on 27.10.2026; the website changed on the same day.
- In 1.38.3, the "+" on the cars list saves the checked car (car_save and car_unsave with from=add, and first_save for new installs). So car saves per 100 checks and the saver share rise: judge them without from=add.
- In 1.38.3, tab views per check drop a little, because re-tapping the open tab no longer counts twice.
- On the website, events sent while offline now wait and are sent later, so fewer events are lost.
- Website layout from 27.10: the desktop hint click "home-rail" replaces "home-top", so read the two together. The footer shows on every web screen, so there are more social link-outs.
- Since 1.38 the share button sits in the car header as an icon. The share_label experiment's button is gone, so its exposures (exp_expose) are zero by design, and the share rate moves for that reason as well.
- Slow checks and failed checks of kind "offline": when the web and Android slow down or fail at the same hours, the cause is the government data source, not the app version (31.10, and 1.11 to 2.11). Failed checks of kind "not_found" are plates the registry does not know, not failures of ours.
- The Google Play production launch was 18.10.2026, so the week 18–24.10 has launch traffic. A week-over-week drop in car checks right after that week is partly the end of that wave.
- App 1.38.4 (fixes only) brings the word "שיתוף" back beside the share icon. It reached 20% of users on 4.11 and 100% on 7.11, so share opens per check may rise from then: compare by app version, not by date.
- From 5.11 the website's js_error carries kind, line and a browser class, and web views that arrive from a Facebook or Instagram link count as kind "iab". Web error kinds before and after 5.11 are not comparable: compare errors by source (src).
- The magazine sign-up form rejected every address that contains the letter "s" from at least 23.10 until 7.11 (fixed that afternoon). Magazine confirmations (newsletter_confirm) before 7.11 are depressed by that bug, and a rise after it is partly the fix.
- On the afternoon of 7.11 the forms were tested end to end: a few business-lead submits (b2b_lead_submit, type and interest "אחר") and one magazine confirmation are tests, not real leads or subscribers.
- Compare opens per check are lower in the new app UI (1.38.x) than in 1.37: the compare entry moved to the car card and the menu. A week in which the last 1.37 users moved to 1.38 shows a compare drop for that reason: compare by app version, and read the site on its own.
- The cars view switch (cars_mode: list or table in "הרכבים שלי") shows only to someone with two or more saved cars, and the app remembers the choice, so only a few people send it, now and then. A week of a new app version without it is not a lost event: 1.38.4 still has the switch (release guard, 12.11).
- Compare opens per check have kept falling week by week in the new app UI since 27.10, on every 1.38.x version alike. On the same days 1.38.3 and 1.38.4 differ by no more than chance, so a release-guard compare finding on 1.38.4 is that trend, not the version. The trend itself is real, and the product thread watches it.
