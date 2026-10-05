# לוחית · בדיקת רכב לפי מספר

איתור פרטי רכב לפי מספר רישוי, ישירות מהמאגרים הפתוחים של משרד התחבורה ב-[data.gov.il](https://data.gov.il/dataset?organization=ministry_of_transport).

האתר: https://ddsabag.github.io/vehicle-app/

קובץ אחד (`index.html`), בלי שרת. הדפדפן פונה ל-API של data.gov.il (CKAN `datastore_search`) ומחבר את המאגרים לפי מספר הרכב ולפי קוד היצרן, קוד הדגם ושנת הייצור.

אפשר לפתוח רכב ישירות בכתובת: `https://ddsabag.github.io/vehicle-app/#1234567`

## אפליקציית אנדרואיד

התיקייה `android/` עוטפת את `index.html` באפליקציית אנדרואיד (WebView). כל דחיפה ל-`main` שמשנה את הדף או את `android/` בונה APK ו-AAB לא חתומים ב-GitHub Actions ומפרסמת אותם בענף `android-builds`. החתימה נעשית מחוץ ל-CI עם מפתח ההעלאה הפרטי.

מדיניות פרטיות: https://ddsabag.github.io/vehicle-app/privacy.html

## זכויות יוצרים

© 2026 דודו סבאג. כל הזכויות שמורות. אין לעתק, להפיץ או לפרסם את הקוד, העיצוב או השם ללא אישור בכתב. ראו `LICENSE`.
