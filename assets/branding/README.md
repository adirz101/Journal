# Journal branding

Original PNG artwork supplied by the project owner. The files are preserved byte-for-byte.

| Asset | Use |
| --- | --- |
| [Banner](journal-banner.png) | Repository README header |
| [Wordmark](journal-wordmark.png) | Application welcome screen |
| [White mark](journal-mark-white.png) | Dark-mode sidebar and empty terminal workspace |
| [Dark mark](journal-mark.png) | Light-mode sidebar and empty terminal workspace |
| [App icon](journal-app-icon.png) | Favicon, Electron window icon and macOS Dock |

Both marks are rendered directly, with no color filter. The dark mark and wordmark have transparent backgrounds and dark artwork. The welcome screen renders the wordmark with a CSS filter in dark mode and its original colors in light mode; the source images remain unchanged. The wordmark's transparent margins are clipped in its display box. Electron trims 5% of the app icon's transparent padding on each edge at runtime to increase its visible size by about 11%, keeping the rounded artwork intact.

There is no packaged release yet. These assets are available for future packaging; this change does not modify Electron's installed app bundle or its executable icon.
