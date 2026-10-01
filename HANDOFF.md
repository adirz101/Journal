# Journal — העברה לסוכן הבא

עודכן: 1 באוקטובר 2026.

## המוצר והרשאות העבודה

Journal (לשעבר Blackbox) הוא סביבת עבודה מקומית ל־Claude Code ול־Codex, עם ידע משותף שנבדק ידנית, מקורות ותיעוד ההקשר שנמסר לסשן.

- ריפו: https://github.com/adirz101/Journal
- תיקייה: `/Users/azechary/Documents/GitHub/Journal`
- המשתמש **אישר מימוש ראשוני עובד** מתוך התכנון הגדול, והמשך רציף מהחקירה למימוש בלי עצירות לאישור החלטות שגרתיות.
- **טרמינל בלבד כרגע.** אין אישור לצ׳אט מובנה או למימוש כל מפת הדרכים.
- המשתמש דחה במפורש vendor או קוד של dev3: לכתוב קוד מקורי או להשתמש במקור אחר. כל קוד/תיקיית dev3 שנבדקו הוסרו; אין קוד כזה במימוש.
- ענף העבודה: `codex/terminal-first`, מבוסס על `1bb07cb`. העבודה מקומית; אין push, merge או פרסום מוצר.

## מה כבר עובד

Electron + React/Vite + node-pty + xterm.js + SQLite/FTS5. יש אפליקציה עם בחירת Git checkout, טרמינל CLI אמיתי, עצירה/הפרעה, חיבור מחדש אחרי רענון, חידוש לפי UUID מדויק, וממשק הצעת/אישור/דחיית/עדכון/משיכת ידע עם מקורות.

הסוכנים משתמשים בהתחברות, בהגדרות ובאישורים הטבעיים שלהם. Claude מקבל UUID מראש ו־hooks נקודתיים לסשן; לא משנים הגדרות גלובליות. UUID של Codex דורש אישור ידני אחרי עצירה. אין `--last`, `--continue`, עקיפת הרשאות או שחזור אוטומטי של קלט. דיווח Claude על UUID אחר מבטל ודאות בזהות עד אישור ידני.

רק ידע מאושר, רלוונטי ובתוקף נכנס להקשר. המקור הוא הצהרה מפורשת של המשתמש או קטע UTF-8 מקובץ tracked בלי symlinks ועם fingerprint. שינוי קובץ פוסל את הידע עד עדכון ואישור. branch scope מדויק; checkout scope לא חוצה פרויקטים. גרסאות ו־receipts לא משתנות בדיעבד; נשמר גם טקסט ההפעלה המלא. בחידוש נבדק הקשר מחדש, בלי לחזור על המשימה המקורית כשהשדה ריק.

טרמינל אחד פעיל; פלט וקלידים אינם נשמרים. ידע, מקורות, משימות פתיחה ו־receipts נשמרים ב־userData מקומי. Worker מריץ SQLite/Git/אימות מקורות כדי לא לחסום קלט. סגירה הורגת את ה־PTY; פתיחה מחדש מציעה חידוש native, לא שחזור תהליך חי. פלט מוגבל בזיכרון והחסרה מוצגת בגלוי.

## אימות והגבולות שלו

33 בדיקות core עברו, וגם typecheck, build ובדיקת Electron עם PTY אמיתי ו־CLI fixtures בטוחים. היא כוללת ידע ממקור קובץ, אישור, מעבר Claude→Codex, UUID מדויק, קלט, הצפת 2.2MB, הפרעה, רענון בלי replay של תגובות טרמינל, סגירה/פתיחה מחדש ושמירה. צילום הבדיקה מקומית: `.cache/screenshots/journal-desktop.png`.

Claude Code 2.1.284 ו־Codex 0.154.0 הופעלו בפועל והפיקו פלט. Claude הגיע למסך אמון ב־checkout ו־Codex הציג כותרת native. לא נשלחה משימת מודל ולא אומתו turn מאומת, allow/deny, חידוש native אמיתי או שימוש המודל בידע. אל תציג fixture כהוכחת זרימת ספק מלאה. CI ל־macOS/Windows נכתב אך עדיין לא רץ; Windows native לא אומת. אין הפצה חתומה.

## קריאה והרצה

קרא `AGENTS.md`, `docs/TERMINAL-FIRST-SPEC.md`, `docs/adr/002-terminal-first-foundation.md` ו־`docs/IMPLEMENTATION-STATUS.md`. התכנון שב־`docs/JOURNAL-DESIGN.md` ו־`docs/IMPLEMENTATION-PLAN.md` היסטורי ורחב יותר; הוראות המשתמש והמפרט החדש קודמים לו. UI skills: המקורות המקומיים ב־`/Users/azechary/Downloads/skills-main/skills/`, במיוחד `emil-design-eng` ו־`pick-ui-library`.

```sh
npm ci
npm run dev
```

Node >=24. `npm ci` מתקין Electron ובונה node-pty ל־ABI שלו; צריך toolchain מקומי. בדיקות: `npm test`, `npm run check`, `npm run build`, `npm run test:desktop`. `npm run smoke:agents` מפעיל את הסוכנים בלי קלט. בסנדבוקס הנוכחי: cache/temp בתוך `.cache`, והרצת Electron GUI דורשת הרשאת sandbox; זו מגבלת הסביבה, לא זרימת מוצר.

הצעד הבא המומלץ: בדיקת אינטגרציה קטנה עם הסוכנים האמיתיים ב־checkout שהמשתמש מאשר לו אמון, הרשאות טבעיות, משימה בטוחה והעברת ידע; ואז אימות Windows. לא לחזור לתכנון מחדש או להכניס dev3/צ׳אט בלי בקשה מפורשת.
