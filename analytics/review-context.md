# Known non-behaviour shifts for the Sunday anomaly review

This file is read by `.github/scripts/anomaly-review.mjs` and sent to Claude with every weekly report. The measurement thread keeps it up to date. It is public: shifts and causes only, never business numbers.

- The new app UI is app versions 1.38, 1.38.1, 1.38.2 and 1.38.3. 1.38.3 was released on 27.10.2026; the website changed on the same day.
- In 1.38.3, the "+" on the cars list saves the checked car (car_save and car_unsave with from=add, and first_save for new installs). So car saves per 100 checks and the saver share rise: judge them without from=add.
- In 1.38.3, tab views per check drop a little, because re-tapping the open tab no longer counts twice.
- On the website, events sent while offline now wait and are sent later, so fewer events are lost.
- Website layout from 27.10: the desktop hint click "home-rail" replaces "home-top", so read the two together. The footer shows on every web screen, so there are more social link-outs.
- Since 1.38 the share button sits in the car header as an icon. The share_label experiment's button is gone, so its exposures (exp_expose) are zero by design, and the share rate moves for that reason as well.
- Slow checks: when the web and Android slow down at the same hours, the cause is the government data source, not the app version (31.10 and the morning of 1.11).
- The Google Play production launch was 18.10.2026, so the week 18–24.10 has launch traffic. A week-over-week drop in car checks right after that week is partly the end of that wave.
