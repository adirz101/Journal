# Journal UX redesign, Phase 1: Foundation

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Read `AGENTS.md` first and follow it. Before any UI step, read `/Users/azechary/Downloads/skills-main/skills/emil-design-eng/SKILL.md`; read `pick-ui-library/SKILL.md` before adding the font dependency (task 1.1b). If that collection is unavailable, say so instead of claiming to have applied it.

**Goal:** Phase 1 of [the UX redesign](2026-10-04-ux-redesign.md) (section 7, "Phase 1: Foundation"): semantic color tokens and a type scale (F3), the bundled JetBrains Mono font (D7), the plain-language vocabulary (F1), provider logos (F2, D9) and a shortcut router that works while the terminal has focus (F4, D8, BUG-7). Layout, sidebar, inspector and composer changes belong to Phases 3 and 4.

**Architecture:**
- **Renderer** (`src/ui`): new `tokens.css` (all colors, both themes, fonts, type scale) and `fonts.css`; `styles.css` refers to tokens only; new `copy.ts` (vocabulary and the mapping of core reason and warning strings) and `ProviderMark.tsx`.
- **Desktop main** (`src/desktop`): new pure `shortcuts.mjs` (`matchShortcut`, `shortcutLabels`); `main.mjs` matches keys in `before-input-event` and sends `{type:'command', id}` on the existing `journal:event` channel. The preload allow-list is unchanged.
- **Core and runtime:** unchanged. Receipt and packet text stays byte-for-byte the same (receipts are immutable).

**Tech stack:** Electron 44, React 19, Vite 8, TypeScript 6, xterm.js 6, Node 24 `node --test` (type stripping lets tests import plain `.ts` modules), Playwright with real Electron.

**Design source:** the approved mockup (local copy: `journal-mock/src/base.css` for tokens, `System.body.html` for states, type scale and keyboard map, `Personality.body.html` for voice; `logos/{claude,openai,cursor}.svg` from Simple Icons). Board numbers (B1–B15) are those of the master plan.

**How this plan was checked:** every task below was replayed in order on a copy of the repository at `2a69b4c`, running `npm test`, `npm run check`, `npm run build` and `npm run test:desktop` after each task. All four passed after every task; the results are in section 7. The codemods and edit scripts fail loudly if the source differs from what they expect, so a drifted branch stops at the first mismatch instead of producing a half-migrated file.

---

## 1. Scope and order

| Task | Master task | What | Commit leaves |
|---|---|---|---|
| 1.1a | 1.1 | `tokens.css`, `:root` on tokens, terminal colors from tokens, contrast test | dark and light palettes switch at the root; legacy variables still work |
| 1.1b | 1.1, D7 | JetBrains Mono bundled; one monospace stack everywhere | fonts load under `font-src 'self'`; notices list the font |
| 1.1c | 1.1 | Codemod pass 1: every rule outside the light theme uses tokens | dark theme on the mockup palette; light overrides still win |
| 1.1d | 1.1 | Codemod pass 2: light overrides removed; static CSS test | light theme comes from tokens only |
| 1.1e | 1.1 | 11 px type floor, focus ring, scrollbars, placeholders | B8 type and focus rules hold |
| 1.2 | 1.2 | `copy.ts` and the vocabulary in every component; spec selectors | old terms gone from visible text |
| 1.3 | 1.3 | `ProviderMark.tsx`; marks next to provider names; notices | marks shown, names unchanged |
| 1.4a | 1.4 | `src/desktop/shortcuts.mjs` (pure) and its table test | matcher ready, not wired |
| 1.4b | 1.4, BUG-7 | Router in main, commands in the renderer, desktop proof, docs | shortcuts work in the terminal |
| 1.5 | — | Phase verification and `docs/IMPLEMENTATION-STATUS.md` | phase recorded |

Out of scope (later phases): the sidebar, header, status bar and three-tab inspector (3), the composer and "Start" shortcut (4), the palette, open-any-file, next-needs-you and Settings shortcuts (2, 3, 8), state words such as "Your turn" (2), and the off-scale sizes 14–21 px (3 rebuilds those screens).

## 2. What the investigation found (including corrections to the master plan)

1. **`styles.css` is 43 KB of minified rules on 190 lines** (533 rules, 207 distinct hex colors in 403 places, 158 light-theme overrides, 72 font sizes below 11 px rather than "about 60"). Hand-written old/new edits for each rule are not reviewable, so tasks 1.1c and 1.1d use a one-off codemod with an explicit color-to-token table. It refuses to run if it meets a color it has no mapping for.
2. **Fonts need no package-audit change.** Vite emits the woff2 files as `dist/assets/<name>-<hash>.woff2` (checked with Vite 8 and a bare `url('@fontsource/…')`), which the existing allow-list entry `^dist/(?:index\.html|assets/[^/]+)$` already covers. Every file is larger than Vite's 4 KiB inlining limit, so none becomes a `data:` URL (which `font-src 'self'` would block). The master plan's "package audit allow-list" step is unnecessary; a regression assertion is added instead. `THIRD_PARTY_NOTICES.md` is generated (`npm run notices`), so the font enters it through `journal.rendererBundle`, and hand-written sections would be overwritten: the Simple Icons note is added to `scripts/notices.mjs`.
3. **`@fontsource/jetbrains-mono@5.3.0` (OFL-1.1) is the safest source:** an npm package pinned like every other dependency, with its OFL text in `LICENSE`, which `scripts/notices.mjs` already copies. Its Latin and Latin Extended subsets do not contain box-drawing, block or Braille characters; those fall back to the next font in the stack (risk R1).
4. **xterm measures its cell once, on a canvas,** so it cannot use `var(--font-mono)` and would measure a fallback if the font loaded later. `theme.ts` exports the same stack as a string (a unit test keeps them equal), and `main.tsx` waits (at most 1.5 s) for the font before the first render.
5. **Playwright's `page.keyboard` bypasses Electron's `before-input-event`.** Measured in Electron 44: no `before-input-event` fires for `page.keyboard.press`, while `webContents.sendInputEvent` does and honours `preventDefault`. The master plan's "press Alt+2 with Playwright" would test nothing; the desktop tests use a `pressKey` helper built on `sendInputEvent`.
6. **The 2.1 map conflicts with the do-not-intercept rule for Open project on Windows and Linux** (Ctrl+O is a Ctrl+letter without Shift; Claude Code and readline use it). Ctrl+O is not routed there: xterm stops the events it consumes, so a page-level listener sees Ctrl+O only when focus is outside the terminal. macOS routes ⌘O.
7. **"Screen-reader names keep the precise meaning, for example 'Remember (approve for agents)'" would break WCAG 2.5.3 (label in name)** and every `getByRole(…, { name: 'Remember', exact: true })`. Visible text and accessible name stay identical ("Remember"); the precise term goes in the `title` tooltip.
8. **`desktop.spec.ts:69`** expects the light terminal background `rgb(255, 255, 255)`; the light `--term` token is `#FAFAFB`, so it becomes `rgb(250, 250, 251)`.
9. **Acceptance "light and dark screenshots match boards B4/B5" cannot hold in Phase 1:** those boards show the Phase 3 layout. Phase 1 acceptance is the palette, type floor, vocabulary, marks and shortcuts on today's layout.
10. **A renderer `src/ui/shortcuts.ts` is not needed.** The labels come from the same table as the matcher, through `bootstrap.shortcuts`, so tooltips cannot drift from the keys; the renderer only needs the `CommandId` type (a unit test compares that union with the table).
11. **Raising sizes to 11 px makes the launch area taller.** At the minimum window (900×640) with both sidebars widened, as in `desktop.spec.ts`, the terminal shows only three rows. The scenario now scrolls through history a page at a time instead of expecting old lines on screen (risk R2).
12. **Provider marks do not go on the Start buttons:** the mockup's primary button is text only, and Phase 4 replaces those buttons with agent cards. Marks go on session rows, the terminal heading, the provider line, the Cursor status card and the context "Route" line.
13. **Inspector-tab shortcuts can work now:** ⌥⌘1–3 / Alt+Shift+1–3 open today's Context, Files and Memory panels and are retargeted to the three tabs in Phase 3. Shortcuts whose actions do not exist yet (palette, open any file, next needs you, sidebar, Settings, separate-copy session) get no row: a row without a handler would swallow a key and do nothing.

## 3. Decisions taken here (no user action needed)

- **Font:** `@fontsource/jetbrains-mono` 400, 500 and 600, Latin and Latin Extended woff2 only (six files, 87 KB). The `pick-ui-library` list has no font entry; this adds no UI library. The terminal uses weight 400 and 600 for bold (no 700 face ships; `font-synthesis:none` prevents faux bold).
- **Token palette:** the mockup's tokens exactly, plus the few the current UI needs and the mockup lacks: `--on-acc` (text on the primary button), `--scrim` (dialog backdrop), `--redline` (border of error banners), `--claude`/`--claude-soft` (provider tile) and the code, syntax and Git colors, kept at their current values for both themes.
- **Amber means "needs you" only (B8).** The old beige `.hint` color becomes `--tx2`; notes awaiting review and out-of-date branch summaries keep amber.
- **Vocabulary:** Knowledge → Project memory (tab "Memory"); claim → note; Approve → Remember; Withdraw → Archive; Resume → Continue; Stop terminal → Stop; Research → Read-only; Worktree → Separate copy (worktree); proposals → suggestions; repo overview / branch update (as reasons) → About this project / Where this branch stands; receipt → what was sent; stale → out of date. "Preview context", "Save for review", "Add for review", "Propose …", "Initial task" and the "Native session ID" label stay until the phases that replace them (4, 6, 7). Session titles that core generates ("Resume · …") are data, not copy.
- **Shortcut ids routed now:** `new-session`, `open-project` (⌘O on macOS only), `add-note`, `focus-terminal`, `toggle-inspector`, `slot-1`–`slot-4`, `tab-session`, `tab-files`, `tab-memory`. Commands are ignored while a modal dialog is open. Windows and Linux users lose Ctrl+N, Ctrl+Alt+B and Ctrl+Shift+E (Files) in favour of Ctrl+Shift+N, Ctrl+Shift+B and Alt+Shift+2 (D8, approved); Ctrl+Shift+E now focuses the terminal.

**Decision for the user (not blocking):** whether box-drawing characters in the terminal (Claude Code's and Codex's frames) should also use JetBrains Mono. That needs the full font files (about 90 KB per weight, from the JetBrains release, vendored with the OFL text and a hand-written notices entry) instead of the fontsource subsets. Recommendation: ship the subsets now and decide after looking at real sessions.

## 4. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | Box drawing, blocks and Braille spinners render in the fallback font, so TUI frames may look slightly thinner or misaligned against JetBrains Mono text | Cell size comes from JetBrains Mono; xterm's DOM renderer keeps the grid. Check one Claude Code and one Codex session by eye (task 1.5); see the decision above |
| R2 | 11 px floor plus the current launch bar leaves three terminal rows at 900×640 with widened sidebars | Accepted until Phase 3 moves the composer off the session screen; the default layout at 900×640 keeps six rows |
| R3 | Alt+1–4 is readline's digit-argument and Alt+Shift+1–3 may be used by some TUIs on Windows/Linux | Approved trade-off (D8); every other Alt and Ctrl key passes through, covered by the table test |
| R3a | On Linux, IBus may take Ctrl+Shift+E (emoji input) before the app sees it | Known limitation, recorded for the Linux check. The terminal can still be focused by clicking it, and IBus's emoji shortcut can be changed in its settings |
| R4 | Changing Windows/Linux shortcuts surprises existing users | README and tooltips show the new keys; the alpha has few users |
| R5 | The codemod maps 207 colors by role; a few surfaces may look different from the mockup intent | It refuses unknown colors; review the light and dark screenshots that `desktop.spec.ts` writes to `.cache/screenshots/` in tasks 1.1c–1.1e |
| R6 | Node 24 type stripping of `.ts` imports in unit tests (`copy.ts`, `theme.ts`) | Both files use only erasable syntax and no relative imports; CI runs Node 24 |
| R7 | Brand use of the Claude, OpenAI and Cursor marks (D9) | Names always accompany the marks; check the brand pages before a public release (master plan D9) |

## 5. File map

| File | Change |
|---|---|
| `src/ui/tokens.css` | New: color tokens (dark and light), fonts, type scale |
| `src/ui/fonts.css` | New: six `@font-face` rules |
| `src/ui/styles.css` | Imports; `:root`; colors → tokens (codemod); light overrides removed; type floor; focus ring; scrollbars; provider mark |
| `src/ui/theme.ts` | xterm themes from tokens; `MONO_FONT` |
| `src/ui/main.tsx` | Waits for the font before rendering |
| `src/ui/TerminalPane.tsx`, `src/ui/ProcessDialog.tsx` | `MONO_FONT`, weights 400/600 |
| `src/ui/copy.ts` | New: vocabulary, tooltips, core string mapping |
| `src/ui/ProviderMark.tsx` | New: inline SVG marks |
| `src/ui/App.tsx`, `KnowledgePanel.tsx`, `KnowledgeForm.tsx`, `ContextPanel.tsx`, `ActivityPanel.tsx`, `DataDialog.tsx`, `ManageProjectDialog.tsx`, `ExplorerPanel.tsx`, `ProviderStatus.tsx`, `ResizableWorkspace.tsx`, `SessionList.tsx` | Vocabulary, marks, command handling |
| `src/ui/types.ts` | `CommandId`, `command` event, `Bootstrap.shortcuts` |
| `src/desktop/shortcuts.mjs` | New: `matchShortcut`, `shortcutLabels`, `COMMAND_IDS` |
| `src/desktop/main.mjs` | `before-input-event` router; `bootstrap.shortcuts`; window background |
| `scripts/notices.mjs`, `THIRD_PARTY_NOTICES.md` | Simple Icons section; regenerated with the font |
| `package.json`, `package-lock.json` | `@fontsource/jetbrains-mono` 5.3.0 (dev dependency, renderer bundle) |
| `tests/tokens.test.mjs`, `styles.test.mjs`, `copy.test.mjs`, `provider-mark.test.mjs`, `shortcuts.test.mjs` | New unit tests |
| `tests/release.test.mjs` | Font and artwork notices; font in the audit allow-list |
| `tests/support/keys.ts` | New: `pressKey` through `before-input-event` |
| `tests/desktop*.spec.ts` | Selectors, font, type floor, BUG-7 proof |
| `README.md`, `docs/FILE-EXPLORER-DESIGN.md`, `docs/IMPLEMENTATION-STATUS.md` | Shortcuts and status |

## 6. Tasks

Run from the repository root on `claude/ux-redesign`. Line numbers refer to `2a69b4c`; every edit is anchored on its exact text. "All four checks" means:

```bash
npm test && npm run check && npm run build && npm run test:desktop
```

Desktop tests run headless (`JOURNAL_HEADLESS=1` is the default in `playwright.config.ts`) and need Electron-native node-pty (`npm run rebuild` if `npm test` was run against a Node-built copy). Check the exit status, not only the summary line.

### Task 1.1a: Color tokens and terminal colors

**Files:**
- Create: `src/ui/tokens.css`, `tests/tokens.test.mjs`
- Modify: `src/ui/styles.css:1-3` and `:37`, `src/ui/theme.ts` (whole file), `src/desktop/main.mjs:75`, `tests/desktop.spec.ts:69`

- [ ] **Step 1: Write the failing test.** Create `tests/tokens.test.mjs`:

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { terminalThemes } from '../src/ui/theme.ts';

// Token values per theme, read from src/ui/tokens.css.
const css = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
const block = selector => {
  const start = css.indexOf(`${selector}{`); assert.ok(start >= 0, selector);
  return Object.fromEntries([...css.slice(start, css.indexOf('}', start)).matchAll(/--([a-z0-9-]+):([^;}]+)/g)].map(([, name, value]) => [name, value.trim()]));
};
const dark = block(':root'); const themes = { dark, light: { ...dark, ...block(':root[data-theme=light]') } };

// WCAG 2.x relative luminance and contrast. Translucent tokens are composited on what is beneath them.
const rgba = value => {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16)).concat(1);
  const fn = value.match(/^rgba\(([\d.]+),([\d.]+),([\d.]+),([\d.]+)\)$/);
  assert.ok(fn, `Unsupported color ${value}`); return fn.slice(1).map(Number);
};
const mix = (color, base) => { const [r, g, b, a] = rgba(color); return [r, g, b].map((c, i) => c * a + base[i] * (1 - a)); };
const luminance = rgb => { const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

const TEXT = ['tx', 'tx2', 'tx3', 'acc', 'amb', 'grn', 'red'];
const SURFACES = ['bg', 'side', 'panel', 'raised', 'field', 'hover', 'sel', 'term'];
const TINTS = { acc: 'accsoft', amb: 'ambsoft', grn: 'grnsoft', red: 'redsoft' };

for (const [name, t] of Object.entries(themes)) {
  test(`${name} theme: every text token is at least 4.5:1 on every surface and on its own tint`, () => {
    const solid = token => mix(t[token], rgba(t.bg).slice(0, 3));
    const low = [];
    for (const text of TEXT) for (const surface of SURFACES) {
      const ratio = contrast(solid(text), solid(surface));
      if (ratio < 4.5) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
    for (const [text, tint] of Object.entries(TINTS)) for (const surface of ['bg', 'side', 'panel']) {
      const ratio = contrast(solid(text), mix(t[tint], solid(surface)));
      if (ratio < 4.5) low.push(`${text} on ${tint} over ${surface}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrast(solid('on-acc'), solid('accbtn')) >= 4.5, 'Text on the primary button');
    assert.deepEqual(low, []);
  });

  test(`${name} theme: the terminal uses the same colors as the tokens`, () => {
    const terminal = terminalThemes[name];
    for (const [key, token] of [['background', 'term'], ['foreground', 'tx'], ['cursor', 'acc'], ['scrollbarSliderBackground', 'line2'], ['scrollbarSliderHoverBackground', 'tx3']])
      assert.equal(terminal[key]?.toUpperCase(), t[token].toUpperCase(), `${key} = --${token}`);
  });
}
~~~~

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test tests/tokens.test.mjs`
Expected: FAIL with `ENOENT … src/ui/tokens.css`.

- [ ] **Step 3: Create `src/ui/tokens.css`:**

~~~~css
/* Journal design tokens (design board B8). Every color the UI uses is defined
   here, for both themes; styles.css refers to them by name. Dark is the
   default; the light theme is selected by data-theme="light" on <html>.
   Contrast: every text token is at least 4.5:1 on every surface token in both
   themes (tests/tokens.test.mjs). Amber means "needs you" and nothing else. */
:root{
  color-scheme:dark;
  --bg:#0F1115;--side:#13161B;--panel:#13161B;--raised:#1A1E25;--field:#0C0E12;--hover:#1D2229;--sel:#1C2A40;--term:#0B0D10;
  --line:#242931;--line2:#30363F;
  --tx:#E8EAEE;--tx2:#B3BAC6;--tx3:#8E97A6;
  --acc:#6AA5FF;--accbtn:#2D6BE6;--accsoft:rgba(106,165,255,.13);--on-acc:#FFFFFF;
  --amb:#F2B957;--ambsoft:rgba(242,185,87,.12);--ambline:rgba(242,185,87,.35);
  --grn:#6CCB8D;--grnsoft:rgba(108,203,141,.12);
  --red:#F48B78;--redsoft:rgba(244,139,120,.12);--redline:rgba(244,139,120,.35);
  --scrim:rgba(9,12,17,.73);
  --claude:#D97757;--claude-soft:rgba(217,119,87,.16);
  /* Code preview, syntax and Git status colors (unchanged from the previous palette). */
  --code-selection:#264F78;--code-match:#5C4D1A;--code-match-current:#7A6420;
  --syn-keyword:#FF7B72;--syn-string:#A5D6FF;--syn-comment:#8B949E;--syn-number:#79C0FF;--syn-type:#FFA657;--syn-property:#D2A8FF;--syn-inserted:#7EE787;--syn-deleted:#FFA198;--syn-invalid:#F85149;
  --git-modified:#E2C08D;--git-added:#81B88B;--git-deleted:#EC7F74;--git-renamed:#79B8FF;--git-conflict:#F2777A;--git-submodule:#8DB9E2;--git-ignored:#6B7380;--sensitive:#A59A7C;
  /* Type: system UI; JetBrains Mono (bundled, see fonts.css) for code, paths, IDs and the terminal. */
  --font-ui:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif;
  --font-mono:"JetBrains Mono","SF Mono",ui-monospace,"Cascadia Mono",Menlo,Consolas,monospace;
  /* Type scale, ratio about 1.2. Nothing renders below 11 px. */
  --text-caption:11px;--text-meta:12px;--text-body:13px;--text-title:16px;--text-screen:22px;
}
:root[data-theme=light]{
  color-scheme:light;
  --bg:#FFFFFF;--side:#F5F6F8;--panel:#F8F9FA;--raised:#FFFFFF;--field:#FFFFFF;--hover:#ECEEF1;--sel:#E2EBFC;--term:#FAFAFB;
  --line:#E3E6EB;--line2:#CDD3DB;
  --tx:#14171C;--tx2:#454D5A;--tx3:#5E6776;
  --acc:#1A5FD8;--accbtn:#1A5FD8;--accsoft:rgba(26,95,216,.08);
  --amb:#8A5300;--ambsoft:#FFF5E0;--ambline:#F0D49A;
  --grn:#17713A;--grnsoft:#E5F4EA;
  --red:#AE321E;--redsoft:#FCEBE7;--redline:#F0C3BA;
  --scrim:rgba(23,36,59,.33);
  --claude:#C8603F;--claude-soft:#FBEEE8;
  --code-selection:#C8DCFA;--code-match:#FBE7A6;--code-match-current:#F5CF5B;
  --syn-keyword:#CF222E;--syn-string:#0A3069;--syn-comment:#6E7781;--syn-number:#0550AE;--syn-type:#953800;--syn-property:#8250DF;--syn-inserted:#116329;--syn-deleted:#82071E;--syn-invalid:#82071E;
  --git-modified:#8A5A00;--git-added:#2B7A36;--git-deleted:#B42318;--git-renamed:#1A5FB4;--git-conflict:#B00020;--git-submodule:#3D6A99;--git-ignored:#98A2B3;--sensitive:#7C6A3A;
}
~~~~

- [ ] **Step 4: Replace `src/ui/theme.ts`:**

~~~~ts
import type { ITheme } from '@xterm/xterm';

export type Appearance = 'dark' | 'light';

export function storedAppearance(): Appearance {
  try { return localStorage.getItem('journal-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

// xterm cannot read CSS variables: these repeat src/ui/tokens.css (--term, --tx,
// --acc, --line2, --tx3); tests/tokens.test.mjs keeps the two in step.
export const terminalThemes: Record<Appearance, ITheme> = {
  dark: {
    background: '#0B0D10', foreground: '#E8EAEE', cursor: '#6AA5FF', cursorAccent: '#0B0D10', selectionBackground: '#264F78',
    scrollbarSliderBackground: '#30363F', scrollbarSliderHoverBackground: '#8E97A6', scrollbarSliderActiveBackground: '#8E97A6',
    black: '#2A2F37', red: '#F49A88', green: '#7DD39A', yellow: '#F2C46B', blue: '#7FB2FF', magenta: '#BBA9FF', cyan: '#7FD8B8', white: '#B3BAC6',
    brightBlack: '#7C8594', brightRed: '#F49A88', brightGreen: '#7DD39A', brightYellow: '#F2C46B', brightBlue: '#7FB2FF', brightMagenta: '#BBA9FF', brightCyan: '#7FD8B8', brightWhite: '#ECEEF2',
  },
  light: {
    background: '#FAFAFB', foreground: '#14171C', cursor: '#1A5FD8', cursorAccent: '#FAFAFB', selectionBackground: '#C8DCFA', selectionForeground: '#14171C',
    scrollbarSliderBackground: '#CDD3DB', scrollbarSliderHoverBackground: '#5E6776', scrollbarSliderActiveBackground: '#5E6776',
    black: '#14171C', red: '#AE321E', green: '#17713A', yellow: '#8A5300', blue: '#1A5FD8', magenta: '#5B40C9', cyan: '#0F6B52', white: '#454D5A',
    brightBlack: '#6B7380', brightRed: '#AE321E', brightGreen: '#17713A', brightYellow: '#8A5300', brightBlue: '#1A5FD8', brightMagenta: '#5B40C9', brightCyan: '#0F6B52', brightWhite: '#14171C',
  },
};
~~~~

- [ ] **Step 5: Use the tokens at the root.** Apply these exact replacements. In `styles.css` the `--muted`, `--accent` and `--accent-button` aliases keep today's rules working until task 1.1c removes them; `--line` is now defined by `tokens.css` under the same name.

1. `src/ui/styles.css`: replace

~~~~css
@import url('@xterm/xterm/css/xterm.css');

:root{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#d8dce2;background:#101216;font-size:13px;font-synthesis:none;color-scheme:dark;--muted:#929aa8;--line:#292e37;--accent:#3b82f6;--accent-button:#2563eb}
~~~~

   with

~~~~css
@import url('@xterm/xterm/css/xterm.css');
@import url('./tokens.css');

:root{font-family:var(--font-ui);color:var(--tx);background:var(--bg);font-size:var(--text-body);font-synthesis:none;font-feature-settings:"tnum" 1;-webkit-font-smoothing:antialiased;--muted:var(--tx3);--accent:var(--acc);--accent-button:var(--accbtn)}
~~~~

2. `src/ui/styles.css`: delete

~~~~css
:root[data-theme=light]{color-scheme:light;color:#253044;background:#fafbfe;--muted:#59677c;--line:#dce2ec;--accent:#2563eb}
~~~~

3. `src/desktop/main.mjs`: replace

~~~~js
minWidth: 900, minHeight: 640, backgroundColor: '#101216',
~~~~

   with

~~~~js
minWidth: 900, minHeight: 640, backgroundColor: '#0F1115',
~~~~

4. `tests/desktop.spec.ts`: replace

~~~~ts
toHaveCSS('background-color', 'rgb(255, 255, 255)')
~~~~

   with

~~~~ts
toHaveCSS('background-color', 'rgb(250, 250, 251)')
~~~~

- [ ] **Step 6: Run the checks.**
Run: `node --test tests/tokens.test.mjs`, then all four checks.
Expected: 4 new tests pass (227 unit tests); 17 desktop scenarios pass.

- [ ] **Step 7: Commit.**

```bash
git add src/ui/tokens.css src/ui/theme.ts src/ui/styles.css src/desktop/main.mjs tests/tokens.test.mjs tests/desktop.spec.ts
git commit -m "Add design tokens for both themes and take terminal colors from them" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** both themes switch through `data-theme` on `<html>` as before; every text token reaches 4.5:1 on every surface; the terminal background equals `--term`.

### Task 1.1b: Bundle JetBrains Mono

**Files:**
- Create: `src/ui/fonts.css`
- Modify: `package.json`, `package-lock.json`, `THIRD_PARTY_NOTICES.md` (generated), `src/ui/styles.css` (monospace rules), `src/ui/theme.ts`, `src/ui/main.tsx`, `src/ui/TerminalPane.tsx:18-19`, `src/ui/ProcessDialog.tsx:19`, `tests/tokens.test.mjs`, `tests/release.test.mjs:70,88`, `tests/desktop.spec.ts:53`

- [ ] **Step 1: Read `pick-ui-library/SKILL.md`** (AGENTS.md). Fonts are not on its list; record in the commit body that no UI library is added.

- [ ] **Step 2: Write the failing tests.** Append to `tests/tokens.test.mjs`:

~~~~js

test('the terminal font stack is the --font-mono token', async () => {
  const { MONO_FONT } = await import('../src/ui/theme.ts');
  const tokens = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
  const stack = tokens.match(/--font-mono:([^;]+);/)[1];
  assert.equal(MONO_FONT.replace(/\s*,\s*/g, ','), stack.replace(/\s*,\s*/g, ','));
  assert.match(stack, /^"JetBrains Mono",/);
});
~~~~

and apply the two `tests/release.test.mjs` replacements listed in step 5.
Run: `node --test tests/tokens.test.mjs tests/release.test.mjs`
Expected: FAIL: `MONO_FONT` is undefined, and "The bundled monospace font" is missing from the notices.

- [ ] **Step 3: Add the font package.**

```bash
npm view @fontsource/jetbrains-mono@5.3.0 license   # expect: OFL-1.1
npm install --save-dev --save-exact @fontsource/jetbrains-mono@5.3.0
```

In `package.json`, add `"@fontsource/jetbrains-mono"` to `journal.rendererBundle` (keep the list sorted: after `"@codemirror/view"`). Then regenerate the notices:

```bash
npm run notices   # expect: Wrote notices for 58 packages
git diff --stat THIRD_PARTY_NOTICES.md   # only the new @fontsource/jetbrains-mono 5.3.0 section (OFL-1.1)
```

- [ ] **Step 4: Create `src/ui/fonts.css`:**

~~~~css
/* JetBrains Mono (SIL Open Font License 1.1), bundled by Vite from
   @fontsource/jetbrains-mono because the CSP only allows the app's own fonts
   (font-src 'self'). Regular, medium and semibold in the Latin and Latin
   Extended subsets; other characters (box drawing, CJK) use the next font in
   --font-mono. */
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:400;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-400-normal.woff2') format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:500;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-500-normal.woff2') format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:600;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2') format('woff2');unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
@font-face{font-family:"JetBrains Mono";font-style:normal;font-weight:600;font-display:swap;src:url('@fontsource/jetbrains-mono/files/jetbrains-mono-latin-ext-600-normal.woff2') format('woff2');unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
~~~~

- [ ] **Step 5: Use one monospace stack.** Replace `src/ui/theme.ts` with:

~~~~ts
import type { ITheme } from '@xterm/xterm';

export type Appearance = 'dark' | 'light';

export function storedAppearance(): Appearance {
  try { return localStorage.getItem('journal-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

// The --font-mono stack from src/ui/tokens.css (xterm measures glyphs on a canvas).
export const MONO_FONT = '"JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

// xterm cannot read CSS variables: these repeat src/ui/tokens.css (--term, --tx,
// --acc, --line2, --tx3); tests/tokens.test.mjs keeps the two in step.
export const terminalThemes: Record<Appearance, ITheme> = {
  dark: {
    background: '#0B0D10', foreground: '#E8EAEE', cursor: '#6AA5FF', cursorAccent: '#0B0D10', selectionBackground: '#264F78',
    scrollbarSliderBackground: '#30363F', scrollbarSliderHoverBackground: '#8E97A6', scrollbarSliderActiveBackground: '#8E97A6',
    black: '#2A2F37', red: '#F49A88', green: '#7DD39A', yellow: '#F2C46B', blue: '#7FB2FF', magenta: '#BBA9FF', cyan: '#7FD8B8', white: '#B3BAC6',
    brightBlack: '#7C8594', brightRed: '#F49A88', brightGreen: '#7DD39A', brightYellow: '#F2C46B', brightBlue: '#7FB2FF', brightMagenta: '#BBA9FF', brightCyan: '#7FD8B8', brightWhite: '#ECEEF2',
  },
  light: {
    background: '#FAFAFB', foreground: '#14171C', cursor: '#1A5FD8', cursorAccent: '#FAFAFB', selectionBackground: '#C8DCFA', selectionForeground: '#14171C',
    scrollbarSliderBackground: '#CDD3DB', scrollbarSliderHoverBackground: '#5E6776', scrollbarSliderActiveBackground: '#5E6776',
    black: '#14171C', red: '#AE321E', green: '#17713A', yellow: '#8A5300', blue: '#1A5FD8', magenta: '#5B40C9', cyan: '#0F6B52', white: '#454D5A',
    brightBlack: '#6B7380', brightRed: '#AE321E', brightGreen: '#17713A', brightYellow: '#8A5300', brightBlue: '#1A5FD8', brightMagenta: '#5B40C9', brightCyan: '#0F6B52', brightWhite: '#14171C',
  },
};
~~~~

Replace `src/ui/main.tsx` with:

~~~~tsx
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
// A terminal measures its cell size when it opens. Load the bundled monospace
// font first, so it measures JetBrains Mono rather than a fallback. Bounded:
// a font problem never keeps the window from rendering.
const fonts = Promise.all(['400 13px', '600 13px'].map(font => document.fonts.load(`${font} "JetBrains Mono"`)));
void Promise.race([fonts, new Promise(resolve => setTimeout(resolve, 1500))]).catch(() => {})
  .finally(() => createRoot(document.getElementById('root')!).render(<App />));
~~~~

Apply these exact replacements:

1. `src/ui/styles.css`: replace

~~~~css
@import url('./tokens.css');
~~~~

   with

~~~~css
@import url('./tokens.css');
@import url('./fonts.css');
~~~~

2. `src/ui/styles.css`: replace

~~~~css
kbd{font-family:inherit;
~~~~

   with

~~~~css
code,pre{font-family:var(--font-mono);font-variant-ligatures:none}kbd{font-family:inherit;
~~~~

3. `src/ui/styles.css`: replace

~~~~css
.branch-badge>span{font-family:monospace;
~~~~

   with

~~~~css
.branch-badge>span{font-family:var(--font-mono);
~~~~

4. `src/ui/styles.css`: replace

~~~~css
.terminal-footer>span:first-child{font-family:monospace}
~~~~

   with

~~~~css
.terminal-footer>span:first-child{font-family:var(--font-mono)}
~~~~

5. `src/ui/styles.css`: replace

~~~~css
.resume-id input{font-family:monospace;
~~~~

   with

~~~~css
.resume-id input{font-family:var(--font-mono);
~~~~

6. `src/ui/styles.css`: replace

~~~~css
.receipt-id{font-family:monospace;
~~~~

   with

~~~~css
.receipt-id{font-family:var(--font-mono);
~~~~

7. `src/ui/styles.css`: replace

~~~~css
font-family:"SFMono-Regular",Consolas,monospace}
~~~~

   with

~~~~css
font-family:var(--font-mono)}
~~~~

8. `src/ui/styles.css`: replace

~~~~css
font:600 10px/1 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
~~~~

   with

~~~~css
font:600 10px/1 var(--font-mono);
~~~~

9. `src/ui/styles.css`: replace

~~~~css
.preview-path{font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
~~~~

   with

~~~~css
.preview-path{font:11px var(--font-mono);
~~~~

10. `src/ui/styles.css`: replace

~~~~css
.cm-scroller{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
~~~~

   with

~~~~css
.cm-scroller{font-family:var(--font-mono);
~~~~

11. `src/ui/styles.css`: replace

~~~~css
gap:4px;font:11px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
~~~~

   with

~~~~css
gap:4px;font:11px var(--font-mono);
~~~~

12. `src/ui/TerminalPane.tsx`: replace

~~~~tsx
import { terminalThemes, type Appearance } from './theme';
~~~~

   with

~~~~tsx
import { MONO_FONT, terminalThemes, type Appearance } from './theme';
~~~~

13. `src/ui/TerminalPane.tsx`: replace

~~~~tsx
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
~~~~

   with

~~~~tsx
      fontFamily: MONO_FONT, fontWeight: 400, fontWeightBold: 600,
~~~~

14. `src/ui/ProcessDialog.tsx`: replace

~~~~tsx
import { terminalThemes, type Appearance } from './theme';
~~~~

   with

~~~~tsx
import { MONO_FONT, terminalThemes, type Appearance } from './theme';
~~~~

15. `src/ui/ProcessDialog.tsx`: replace

~~~~tsx
fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace' });
~~~~

   with

~~~~tsx
fontFamily: MONO_FONT, fontWeight: 400, fontWeightBold: 600 });
~~~~

16. `tests/desktop.spec.ts`: replace

~~~~ts
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // The terminal is a real native PTY
~~~~

   with

~~~~ts
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // JetBrains Mono ships inside the app (CSP font-src 'self') and the terminal uses it.
    expect(await page.evaluate(() => [...document.fonts].some(face => face.family.replace(/"/g, '') === 'JetBrains Mono' && face.status === 'loaded'))).toBe(true);
    await expect(page.locator('.xterm-rows')).toHaveCSS('font-family', /^"JetBrains Mono"/);
    // The terminal is a real native PTY
~~~~

17. `tests/release.test.mjs`: replace

~~~~js
  for (const name of [...pkg.journal.rendererBundle, ...shipped, 'node-pty', 'electron']) assert.match(notices, new RegExp(`^## ${name.replace(/[/@.]/g, '\\$&')} `, 'm'), name);
~~~~

   with

~~~~js
  for (const name of [...pkg.journal.rendererBundle, ...shipped, 'node-pty', 'electron']) assert.match(notices, new RegExp(`^## ${name.replace(/[/@.]/g, '\\$&')} `, 'm'), name);
  assert.match(notices, /^## @fontsource\/jetbrains-mono .*\n\nLicense: OFL-1\.1$/m, 'The bundled monospace font');
~~~~

18. `tests/release.test.mjs`: replace

~~~~js
'node_modules/node-pty/build/Release/spawn-helper', 'assets/branding/journal-app-icon.png']), []);
~~~~

   with

~~~~js
'node_modules/node-pty/build/Release/spawn-helper', 'assets/branding/journal-app-icon.png',
    'dist/assets/jetbrains-mono-latin-400-normal-V6pRDFza.woff2']), []);
~~~~

- [ ] **Step 6: Run the checks.**
Run: all four checks; then `ls dist/assets/*.woff2 | wc -l`.
Expected: 228 unit tests pass; six woff2 files in `dist/assets`; 17 desktop scenarios pass, including the new font assertions (the font is loaded and `.xterm-rows` uses it).

- [ ] **Step 7: Commit.**

```bash
git add package.json package-lock.json THIRD_PARTY_NOTICES.md src/ui/fonts.css src/ui/styles.css src/ui/theme.ts src/ui/main.tsx src/ui/TerminalPane.tsx src/ui/ProcessDialog.tsx tests/tokens.test.mjs tests/release.test.mjs tests/desktop.spec.ts
git commit -m "Bundle JetBrains Mono for code, paths, IDs and the terminal" -m "Fonts come from @fontsource/jetbrains-mono (OFL-1.1), Latin and Latin Extended, weights 400/500/600, served from the app under font-src 'self'. No UI library is added (pick-ui-library has no font entry)." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** no network font request; `npm run notices` output is committed; the terminal, code previews, paths and IDs render in JetBrains Mono.

### Task 1.1c: Rules outside the light theme use tokens (codemod pass 1)

**Files:**
- Modify: `src/ui/styles.css` (244 declarations)
- Create (not committed): `.cache/tokens-codemod.mjs` (`.cache/` is ignored by Git)

- [ ] **Step 1: Save the codemod** as `.cache/tokens-codemod.mjs`. The tables are the whole mapping: each color, by the role of the property it appears in (text, surface or line), to a token.

~~~~js
// One-off migration of src/ui/styles.css to the tokens in src/ui/tokens.css.
// node .cache/tokens-codemod.mjs dark   -> rules outside the light theme use var(--token)
// node .cache/tokens-codemod.mjs light  -> drops light-theme color overrides the tokens now cover
// Prints every change and fails on any color it has no mapping for.
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/ui/styles.css';
const pass = process.argv[2];
if (!['dark', 'light'].includes(pass)) throw new Error('Usage: tokens-codemod.mjs dark|light');

// Colors by role. The same hex can mean text in one property and a surface in another.
const TEXT = {
  tx: '#d8dce2 #e0e3e8 #dce1e8 #dceaff #b5d2ff #d6dbe2 #aeb6c2',
  tx2: '#c0c6ce #a5afbe #a9b4c3 #abb4c1 #aeb6c1 #c4d1e5 #bcd0ec #baaa82 #c0b28e',
  tx3: '#616e7f #68707c #68727f #6f7987 #6f8fbf #707b88 #727c89 #758091 #76818c #788392 #7b8898 #7c8895 #7d8794 #7e8996 #7f8997 #8390a0 #8992a0 #8aa4c6 #8c94a1 #8d97a3 #8e98a6 #8f99a6 #8f9dad #909aab #919cac #929aa8 #929baa #94a3b8 #959faf #9da6b3 #5f6976',
  acc: '#7aafff #91bdff #3b82f6', amb: '#d9c18c #e6c27f', grn: '#a7bf8e #b4cca1', red: '#d79b91 #dab0a5 #e2b9ae #e3aea3',
  'on-acc': '#ffffff',
  sensitive: '#a59a7c', 'git-modified': '#e2c08d', 'git-added': '#81b88b', 'git-deleted': '#ec7f74', 'git-renamed': '#79b8ff', 'git-conflict': '#f2777a', 'git-submodule': '#8db9e2', 'git-ignored': '#6b7380',
  'syn-keyword': '#ff7b72', 'syn-string': '#a5d6ff', 'syn-comment': '#8b949e', 'syn-number': '#79c0ff', 'syn-type': '#ffa657', 'syn-property': '#d2a8ff', 'syn-deleted': '#ffa198', 'syn-invalid': '#f85149', 'syn-inserted': '#7ee787',
};
const SURFACE = {
  term: '#101216', field: '#11151a #15191f #151a20 #171b21 #12151a', side: '#15181d #15191e', panel: '#171a20',
  raised: '#181c22 #191d23 #1c2129 #1d222a #1e232a #20252d #1a1e25', hover: '#1d232b #262c33 #262c35 #303743 #2b3039',
  sel: '#21262e #172d50 #1f3352 #22324a', accsoft: '#15253d #17325b #1c3f75 #1c2a40',
  ambsoft: '#2b2619 #3b3424', grnsoft: '#2d3a28', redsoft: '#302322 #3d2c29', scrim: '#090c11bb',
  'code-selection': '#264f78', 'code-match': '#5c4d1a', 'code-match-current': '#7a6420',
};
const LINE = {
  line: '#242933 #262b33 #292e37', ambline: '#5c4a28', redline: '#624441', acc: '#3b82f6',
  line2: '#2c323b #303641 #303742 #323944 #333a44 #363c47 #39404b #424a56 #454e5a #29466f #2f4a72 #3a4a63 #3662a0',
};
// Whole declarations that change shape rather than color.
const DECLARATIONS = { 'background:#2f6feb': 'filter:brightness(1.08)' };
// The aliases task 1.1a left on :root, and their uses.
const LEGACY = { 'var(--muted)': 'var(--tx3)', 'var(--accent)': 'var(--acc)', 'var(--accent-button)': 'var(--accbtn)' };
const ALIASES = new Set(['--muted', '--accent', '--accent-button']);

const table = groups => new Map(Object.entries(groups).flatMap(([token, hexes]) => hexes.split(' ').map(hex => [hex, `var(--${token})`])));
const roles = { text: table(TEXT), surface: table(SURFACE), line: table(LINE) };
const roleOf = (prop, selector) => /^background/.test(prop) ? (/status-dot/.test(selector) ? 'text' : 'surface')
  : prop === 'color' || prop === 'border-left-color' ? 'text' : 'line';

const css = readFileSync(FILE, 'utf8');
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const hasHex = value => /#[0-9a-fA-F]{3,8}\b/.test(value);
const isLight = selector => selector.includes('data-theme=light');
const COLOR_PROP = /^(?:color|background(?:-color)?|border(?:-[a-z]+)?-color)$/;
const notes = []; const unmapped = [];
// A rule is "selector{declarations}"; @media and @container blocks only wrap rules.
// The selector group skips whatever precedes it on the line: comments, @import and closing braces.
const out = css.replace(/([^{};/]+)\{([^{}]*)\}/g, (whole, rawSelector, body) => {
  const selector = rawSelector.trim();
  if (selector.startsWith('@')) return whole;
  const parts = body.split(';');
  if (pass === 'dark') {
    if (isLight(selector)) return whole;
    const next = parts.filter(part => !ALIASES.has(part.split(':')[0].trim())).map(part => {
      const colon = part.indexOf(':'); if (colon < 0) return part;
      const prop = part.slice(0, colon).trim(); const value = part.slice(colon + 1).trim();
      let text = DECLARATIONS[`${prop}:${value}`] ?? part.replace(HEX, hex => {
        const token = roles[roleOf(prop, selector)].get(hex.toLowerCase());
        if (!token) unmapped.push(`${selector} { ${prop}: ${value} }`);
        return token ?? hex;
      });
      for (const [old, replacement] of Object.entries(LEGACY)) text = text.split(old).join(replacement);
      if (text !== part) notes.push(`${selector.slice(0, 50)} { ${part.trim()} -> ${text.trim()} }`);
      return text;
    });
    return `${rawSelector}{${next.join(';')}}`;
  }
  if (!isLight(selector)) return whole;
  const kept = parts.filter(part => {
    const colon = part.indexOf(':'); if (colon < 0) return part.trim() !== '';
    const prop = part.slice(0, colon).trim(); const value = part.slice(colon + 1).trim();
    if (!hasHex(value)) return true;
    if (!COLOR_PROP.test(prop) && !prop.startsWith('--')) { unmapped.push(`light, not a color: ${selector} { ${part.trim()} }`); return true; }
    notes.push(`drop ${selector.slice(0, 60)} { ${part.trim()} }`); return false;
  });
  // A rule with nothing left goes; its leading whitespace stays so lines keep their shape.
  return kept.length ? `${rawSelector}{${kept.join(';')}}` : rawSelector.match(/^\s*/)[0];
});
if (unmapped.length) { console.error(`Unmapped:\n${unmapped.join('\n')}`); process.exit(1); }
// Hover blocks and lines left empty by the light pass.
const tidy = pass === 'light' ? out.replace(/@media\(hover:hover\) and \(pointer:fine\)\{\s*\}/g, '').replace(/^[ \t]*\n/gm, '').replace(/(\/\*[^*]*\*\/)\n(?=\/\*|$)/g, '') : out;
writeFileSync(FILE, tidy);
console.log(notes.join('\n'));
console.log(`${notes.length} ${pass === 'dark' ? 'declarations now use tokens' : 'light-theme declarations removed'}`);
~~~~

- [ ] **Step 2: Run the dark pass.**
Run: `node .cache/tokens-codemod.mjs dark | tail -1`
Expected: `244 declarations now use tokens` (no "Unmapped" error).
Run: `grep -o '#[0-9a-fA-F]\{3,8\}\b' src/ui/styles.css | wc -l`
Expected: `158`, all inside `[data-theme=light]` rules: `grep -o '[^{}]*{[^}]*#[0-9a-fA-F]\{3,8\}[^}]*}' src/ui/styles.css | grep -vc 'data-theme=light'` prints `0`.

- [ ] **Step 3: Review the result.** Run all four checks, then look at `.cache/screenshots/journal-desktop.png` (dark) and `journal-light*.png` (light; still driven by the old overrides). Apply `emil-design-eng`: no new transitions, nothing animated.
Expected: 228 unit tests and 17 desktop scenarios pass.

- [ ] **Step 4: Commit.**

```bash
git add src/ui/styles.css
git commit -m "Styles use color tokens outside the light theme" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** the dark theme uses only tokens; `--muted`, `--accent` and `--accent-button` no longer exist.

### Task 1.1d: The light theme comes from tokens (codemod pass 2)

**Files:**
- Create: `tests/styles.test.mjs`
- Modify: `src/ui/styles.css` (158 light declarations removed)

- [ ] **Step 1: Write the failing test.** Create `tests/styles.test.mjs`:

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Static rules for the renderer's CSS (design board B8). Colors live in tokens.css only.
const read = name => readFileSync(new URL(`../src/ui/${name}`, import.meta.url), 'utf8');
const styles = read('styles.css'); const tokens = read('tokens.css');
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
test('colors come from tokens: no hex values in styles.css or components', () => {
  assert.deepEqual(styles.match(HEX) ?? [], [], 'styles.css');
  for (const file of readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => /\.tsx?$/.test(name) && name !== 'theme.ts'))
    assert.deepEqual(read(file).match(HEX) ?? [], [], file);
});

test('every custom property styles.css uses is defined, in tokens.css', () => {
  assert.doesNotMatch(styles, /[{;]\s*--[a-z]/, 'styles.css defines no custom properties');
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+):/g)].map(match => match[1]));
  // Set at run time by ResizableWorkspace.
  for (const name of ['--sidebar-width', '--knowledge-width', '--workspace-min-width']) defined.add(name);
  const used = [...new Set([...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]))];
  assert.deepEqual(used.filter(name => !defined.has(name)), []);
});

test('the light theme comes from tokens; the few light-only rules change no color', () => {
  const light = [...styles.matchAll(/([^{}]*data-theme=light[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => `${selector.trim()}{${body}}`);
  assert.deepEqual(light, [':root[data-theme=light] .welcome-wordmark{filter:none}', ':root[data-theme=light] .update-notice.compact{background:transparent}']);
});
~~~~

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test tests/styles.test.mjs`
Expected: FAIL: 158 hex values in `styles.css`, and a long list of light-theme rules.

- [ ] **Step 3: Run the light pass.**
Run: `node .cache/tokens-codemod.mjs light | tail -1`
Expected: `158 light-theme declarations removed`.
Run: `grep -c 'data-theme=light' src/ui/styles.css`
Expected: `3`: `.welcome-wordmark{filter:none}`, `.update-notice.compact{background:transparent}` (neither is a color) and the placeholder opacity rule. Placeholders need a color in both themes, so replace that rule and the comment above it:

1. `src/ui/styles.css`: replace

~~~~css
/* Light appearance keeps the same geometry and the royal blue identity. */
:root[data-theme=light] input::placeholder,:root[data-theme=light] textarea::placeholder{opacity:1}
~~~~

   with

~~~~css
input::placeholder,textarea::placeholder{color:var(--tx3);opacity:1}
~~~~

- [ ] **Step 4: Run the checks.**
Run: `node --test tests/styles.test.mjs`, then all four checks, then look at the light screenshots again.
Expected: 231 unit tests and 17 desktop scenarios pass; light and dark show the same structure in the mockup palette.

- [ ] **Step 5: Commit.**

```bash
git add src/ui/styles.css tests/styles.test.mjs
git commit -m "Light theme comes from tokens; styles define no colors of their own" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** no hex color in `styles.css` or any component (`theme.ts` and `tokens.css` excepted); every `var(--…)` used is defined.

### Task 1.1e: Type floor, focus ring and scrollbars

**Files:**
- Modify: `src/ui/styles.css`, `tests/styles.test.mjs`, `tests/desktop-layout.spec.ts:20`, `tests/desktop.spec.ts:78-86`

> **Review note (from the 1.1a quality review):** `--line2` is only about 1.4 to 1.6:1 against the surfaces. That is fine for decorative dividers, but WCAG 1.4.11 asks for 3:1 on the boundary of an interactive control (inputs, text fields, outlined buttons). While doing the focus and control rules here, evaluate which `border-color:var(--line2)` rules belong to controls, and give those a stronger border (a new token such as `--control-line`, tested at 3:1 like the text tokens) or an alternative cue.

- [ ] **Step 1: Write the failing tests.** Replace `tests/styles.test.mjs` with the full version (two more tests: the type floor and hover gating):

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Static rules for the renderer's CSS (design board B8). Colors live in tokens.css only.
const read = name => readFileSync(new URL(`../src/ui/${name}`, import.meta.url), 'utf8');
const styles = read('styles.css'); const tokens = read('tokens.css');
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
test('colors come from tokens: no hex values in styles.css or components', () => {
  assert.deepEqual(styles.match(HEX) ?? [], [], 'styles.css');
  for (const file of readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => /\.tsx?$/.test(name) && name !== 'theme.ts'))
    assert.deepEqual(read(file).match(HEX) ?? [], [], file);
});

test('every custom property styles.css uses is defined, in tokens.css', () => {
  assert.doesNotMatch(styles, /[{;]\s*--[a-z]/, 'styles.css defines no custom properties');
  const defined = new Set([...tokens.matchAll(/(--[a-z0-9-]+):/g)].map(match => match[1]));
  // Set at run time by ResizableWorkspace.
  for (const name of ['--sidebar-width', '--knowledge-width', '--workspace-min-width']) defined.add(name);
  const used = [...new Set([...styles.matchAll(/var\((--[a-z0-9-]+)/g)].map(match => match[1]))];
  assert.deepEqual(used.filter(name => !defined.has(name)), []);
});

test('the light theme comes from tokens; the few light-only rules change no color', () => {
  const light = [...styles.matchAll(/([^{}]*data-theme=light[^{}]*)\{([^{}]*)\}/g)].map(([, selector, body]) => `${selector.trim()}{${body}}`);
  assert.deepEqual(light, [':root[data-theme=light] .welcome-wordmark{filter:none}', ':root[data-theme=light] .update-notice.compact{background:transparent}']);
});

test('type floor: nothing below 11 px', () => {
  const sizes = [...styles.matchAll(/font(?:-size)?:[^;}]*?(\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
  assert.deepEqual(sizes.filter(size => size < 11), []);
});

test('motion and hover: no transition on everything, hover only for fine pointers', () => {
  assert.doesNotMatch(styles, /transition\s*:\s*all\b/);
  const hovers = []; let depth = 0; let hoverBlock = false;
  for (const [, head, open] of styles.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]*)([{}])/g)) {
    if (open === '}') { depth--; if (depth === 0) hoverBlock = false; continue; }
    const selector = head.replace(/^[\s\S]*;/, '').trim();
    if (depth === 0 && selector.startsWith('@media')) hoverBlock = /hover:\s*hover/.test(selector) && /pointer:\s*fine/.test(selector);
    else if (selector.includes(':hover') && !hoverBlock && !selector.includes('::-webkit-scrollbar')) hovers.push(selector);
    depth++;
  }
  assert.deepEqual(hovers, []);
});
~~~~

Run: `node --test tests/styles.test.mjs`
Expected: FAIL in "type floor": 72 sizes below 11 (7, 8, 9 and 10 px). "motion and hover" already passes; it guards the rule from now on.

- [ ] **Step 2: Raise every size below 11 px to 11 px.**

```bash
node -e "
const fs = require('fs'); const file = 'src/ui/styles.css'; let n = 0;
const floor = (m, head, size) => Number(size) < 11 ? (n++, head + '11px') : m;
const css = fs.readFileSync(file, 'utf8').replace(/(font-size:)(\d+(?:\.\d+)?)px/g, floor).replace(/(font:600 )(\d+(?:\.\d+)?)px/g, floor);
fs.writeFileSync(file, css); console.log(n + ' sizes raised');"
```

Expected: `72 sizes raised`. Sizes 12 px and above are untouched (Phase 3 moves them onto the 12/13/16/22 scale with the new screens).

- [ ] **Step 3: Focus ring, scrollbars, captions.** Apply these exact replacements (the caption rule keeps "0/4 active" on one line at 11 px):

1. `src/ui/styles.css`: replace

~~~~css
@import url('./fonts.css');
~~~~

   with

~~~~css
@import url('./fonts.css');
/* Scrollbars: a thin rounded thumb on a transparent track, darker on hover. */
::-webkit-scrollbar{width:10px;height:10px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-thumb{background:var(--line2);border-radius:6px;border:2px solid transparent;background-clip:padding-box}::-webkit-scrollbar-thumb:hover{background:var(--tx3);background-clip:padding-box}
~~~~

2. `src/ui/styles.css`: replace

~~~~css
button:focus-visible,input:focus-visible,textarea:focus-visible,select:focus-visible{outline:2px solid var(--acc);outline-offset:3px}
~~~~

   with

~~~~css
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
~~~~

3. `src/ui/styles.css`: replace

~~~~css
input::placeholder,textarea::placeholder{color:var(--tx3);opacity:1}
~~~~

   with

~~~~css
input::placeholder,textarea::placeholder{color:var(--tx3);opacity:1}.nav-caption>span{white-space:nowrap}
~~~~

4. `tests/desktop-layout.spec.ts`: replace

~~~~ts
    await expect(left).toBeVisible(); await expect(right).toBeVisible();
~~~~

   with

~~~~ts
    await expect(left).toBeVisible(); await expect(right).toBeVisible();
    // Type floor (design board B8): nothing outside the terminal renders below 11 px.
    expect(await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(element => !element.closest('.xterm') && element.getClientRects().length && parseFloat(getComputedStyle(element).fontSize) < 11)
      .map(element => `${element.tagName.toLowerCase()}.${element.className}`))).toEqual([]);
~~~~

5. `tests/desktop.spec.ts`: replace

~~~~ts
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO hello-terminal');
    // A small viewport shows only recent rows. Verify earlier output by scrolling
    // through retained history, rather than requiring it to remain on screen.
    for (let i = 0; i < 8; i++) await page.locator('.xterm-helper-textarea').press('Shift+PageUp');
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    for (let i = 0; i < 8; i++) await page.locator('.xterm-helper-textarea').press('Shift+PageDown');
    await expect(page.locator('.terminal-surface')).toContainText('ECHO hello-terminal');
~~~~

   with

~~~~ts
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    // A small viewport with widened sidebars shows only the last few rows (three at
    // the 11 px type floor). Verify retained history by scrolling through it, a page
    // at a time, rather than requiring earlier output to remain on screen.
    const surface = page.locator('.terminal-surface');
    const scrollTo = async (key: string, text: string) => {
      for (let i = 0; i < 60 && !(await surface.textContent())?.includes(text); i++) await page.locator('.xterm-helper-textarea').press(key);
      await expect(surface).toContainText(text);
    };
    await expect(surface).toContainText('ECHO after-theme');
    await scrollTo('Shift+PageUp', 'PTY_READY true');
    await scrollTo('Shift+PageDown', 'ECHO hello-terminal');
    await scrollTo('Shift+PageDown', 'ECHO after-theme');
~~~~

The focus ring is 2 px `--acc` with a 2 px offset on `:focus-visible` only, for every focusable element (B8); the resizer, tree rows and code editor keep their own, more specific focus styles. Scrollbars use `::-webkit-scrollbar` because the standard `scrollbar-color` cannot darken the thumb on hover; the terminal's own scrollbar takes `scrollbarSlider*` from `theme.ts`. Nothing animates (`emil-design-eng`: these are frequent, keyboard-driven surfaces).

- [ ] **Step 4: Run the checks.**
Run: all four checks; look at the screenshots.
Expected: 233 unit tests pass; 17 desktop scenarios pass, including the new type-floor check in `desktop-layout.spec.ts` and the history scroll in `desktop.spec.ts`.

- [ ] **Step 5: Commit.**

```bash
git add src/ui/styles.css tests/styles.test.mjs tests/desktop-layout.spec.ts tests/desktop.spec.ts
git commit -m "Nothing renders below 11 px; one focus ring; themed scrollbars" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** B8 type floor and focus rule; hover effects only for fine pointers; no `transition: all`; `prefers-reduced-motion` rule unchanged.

### Task 1.2: Plain-language vocabulary

**Files:**
- Create: `src/ui/copy.ts`, `tests/copy.test.mjs`; `.cache/copy-edits.mjs` (not committed)
- Modify: `src/ui/App.tsx`, `KnowledgePanel.tsx`, `KnowledgeForm.tsx`, `ContextPanel.tsx`, `ActivityPanel.tsx`, `DataDialog.tsx`, `ManageProjectDialog.tsx`, `ExplorerPanel.tsx`, `ProviderStatus.tsx`, `ResizableWorkspace.tsx`; `tests/desktop.spec.ts`, `desktop-brief.spec.ts`, `desktop-status.spec.ts`, `desktop-layout.spec.ts`, `desktop-cursor.spec.ts`, `desktop-lifecycle.spec.ts`, `desktop-context-menus.spec.ts`, `desktop-explorer.spec.ts`, `desktop-sessions.spec.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/copy.test.mjs`. The scanner reads every `.tsx` file with the TypeScript parser and collects what a user can see or hear (JSX text, string and template literals) while skipping code positions (types, imports, comparisons, object keys, menu ids, class names, `title` tooltips on elements, and string arguments of IPC and state calls):

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { copy, excludedReason, selectionReason, warningText } from '../src/ui/copy.ts';

// Plain-language vocabulary (design board B8). The technical term may stay in a
// tooltip (the title attribute of an element) but not in visible text or names.
const OLD_TERMS = /\b(?:claims?|knowledge|receipts?|stale|approve[ds]?|proposals?|research|resume[ds]?)\b/i;
// Element attributes that are code, or a tooltip where the precise term is allowed.
const ELEMENT_CODE = new Set(['className', 'key', 'role', 'id', 'htmlFor', 'type', 'title', 'value', 'name', 'dir', 'src', 'data-testid', 'aria-controls', 'aria-labelledby', 'aria-haspopup', 'aria-orientation']);
// Component props that are code (other props, such as a dialog's title or note, are visible).
const COMPONENT_CODE = new Set(['key', 'side', 'provider', 'kind', 'id', 'className']);
// Calls whose string arguments are code: IPC actions, state values, storage keys, DOM queries.
const CODE_CALLS = /^(?:api|setPanel|useState|useRef|getItem|setItem|addEventListener|removeEventListener|querySelector|includes|startsWith|has|get|set|CustomEvent|read)$/;
// Internal identifiers that look like old terms: [file, text, why].
const ALLOWED = [['ResizableWorkspace.tsx', 'knowledge', 'side id, stored in journal-panel-widths']];

// Every string a user can see or hear: JSX text and string or template literals,
// except code positions (types, imports, comparisons, object keys, code attributes and calls).
function visibleStrings(file) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isCaseClause(node)) return;
    if (ts.isBinaryExpression(node) && /^(?:===|!==|in)$/.test(node.operatorToken.getText())) return;
    if (ts.isPropertyAssignment(node)) { if (node.name.getText() !== 'id') visit(node.initializer); return; }
    if (ts.isElementAccessExpression(node)) { visit(node.expression); return; }
    if (ts.isJsxAttribute(node)) {
      const element = /^[a-z]/.test(node.parent.parent.tagName.getText());
      if ((element ? ELEMENT_CODE : COMPONENT_CODE).has(node.name.getText())) return;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && CODE_CALLS.test(node.expression.getText().split('.').pop())) {
      visit(node.expression); for (const arg of node.arguments ?? []) if (!ts.isStringLiteralLike(arg) && !ts.isObjectLiteralExpression(arg)) visit(arg);
      return;
    }
    const text = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text.trim() : '';
    if (text) found.push([`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text, file]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('components use the plain vocabulary in visible text', () => {
  const files = readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => name.endsWith('.tsx'));
  const old = files.flatMap(visibleStrings).filter(([, text, file]) => OLD_TERMS.test(text) && !ALLOWED.some(([f, t]) => f === file && t === text));
  assert.deepEqual(old.map(([at, text]) => `${at}: ${text}`), []);
});

test('the vocabulary itself avoids the old terms, except in tooltips', () => {
  for (const [key, value] of Object.entries(copy)) if (typeof value === 'string') assert.doesNotMatch(value, OLD_TERMS, key);
});

test('core reasons and warnings are shown in the plain vocabulary; packet text is not touched', () => {
  assert.equal(selectionReason('repo overview'), 'About this project');
  assert.equal(selectionReason('branch update'), 'Where this branch stands');
  assert.equal(selectionReason('pinned'), 'Pinned');
  assert.equal(selectionReason('referenced area src/core'), 'In src/core, which you referenced');
  assert.equal(selectionReason('matched docker, tests in src'), 'Matches docker, tests · in src');
  assert.equal(selectionReason('matched task terms'), 'Matches your task');
  assert.equal(selectionReason(undefined), 'Included');
  assert.equal(excludedReason('stale'), 'out of date');
  assert.equal(excludedReason('left-out-for-task'), 'left out by you');
  assert.equal(excludedReason('something-new'), 'something-new');
  assert.equal(warningText('Claims 1234abcd r2 and 5678ef90 r1 may conflict. Review them in Knowledge.'), 'Notes 1234abcd (revision 2) and 5678ef90 (revision 1) may conflict. Check them in Memory.');
  assert.equal(warningText('An unknown warning.'), 'An unknown warning.');
  for (const text of ['Project brief search inspected 100 entries. Retire superseded briefs to include others.', 'Search inspected 1000 matches. Refine the task or retire stale knowledge to search further.',
    'The current branch update is 3 commits behind HEAD. Propose a status update to review recent progress.', 'Only four current project brief entries fit the orientation limit. Consolidate superseded briefs.',
    'A project brief was excluded by the context budget. Shorten or consolidate the reviewed summaries.', 'No current approved project brief is included. Add a checkout-scoped brief to orient every session.'])
    assert.doesNotMatch(warningText(text), OLD_TERMS, text);
});
~~~~

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test tests/copy.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND … src/ui/copy.ts`.

- [ ] **Step 3: Create `src/ui/copy.ts`:**

~~~~ts
// Plain-language vocabulary (design board B8). Visible text and accessible names
// use these words; the technical term may stay in a tooltip (title), so a label
// always matches what a screen reader announces. Receipt and packet text from
// core are immutable and never pass through here.
export const copy = {
  memory: 'Project memory', memoryTab: 'Memory', addNote: 'Add a note', addSummary: 'Add project summary',
  remember: 'Remember', remembered: 'Remembered', needsReview: 'Needs review', archive: 'Archive', suggestions: 'Suggestions',
  aboutProject: 'About this project', branchStands: 'Where this branch stands', projectSummary: 'Project summary',
  outOfDate: 'Out of date', otherBranch: 'Other branch', folderRemoved: 'Folder removed',
  whatWasSent: 'What was sent', willKnow: 'What the agent will know',
  continue: 'Continue', stop: 'Stop', readOnly: 'Read-only', plan: 'Plan', separateCopy: 'Separate copy (worktree)',
} as const;

// Tooltips keep the precise term.
export const tip = {
  remember: 'Approve: agents receive this note from the next session',
  archive: 'Withdraw: agents stop receiving this note',
  continue: 'Resume the same native conversation by its exact ID',
  readOnly: 'Starts in Claude plan mode, the Codex read-only sandbox or Cursor Ask mode; can be changed in the session',
  plan: 'Claude plan mode or Cursor Plan mode',
  memoryTab: 'Reviewed project knowledge that agents receive',
  separateCopy: 'A separate Git worktree on its own branch',
} as const;

export const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const CATEGORIES: Record<string, string> = { constraint: 'Rule', decision: 'Decision', convention: 'Convention', lesson: 'Lesson', issue: 'Known issue' };
// A brief is "About this project" (checkout scope) or "Where this branch stands" (branch scope).
export function category(name: string, scope?: string) {
  if (name === 'brief') return scope === 'branch' ? copy.branchStands : scope === 'checkout' ? copy.aboutProject : copy.projectSummary;
  return CATEGORIES[name] ?? name;
}

export function memoryState(memory: { status: string; validation: string }) {
  if (memory.validation === 'stale') return copy.outOfDate;
  if (memory.validation === 'wrong-branch') return copy.otherBranch;
  if (memory.validation === 'folder-removed') return copy.folderRemoved;
  return ({ active: copy.remembered, candidate: copy.needsReview, rejected: 'Rejected', archived: 'Archived' } as Record<string, string>)[memory.status] ?? memory.status;
}

// Delivery state of what was sent to an agent.
export function deliveryState(state: string | undefined) {
  return ({ prepared: 'preview', submitted: 'sent', failed: 'not sent', uncertain: 'delivery uncertain' } as Record<string, string>)[state ?? 'prepared'] ?? String(state);
}

// Why core selected a note (selection.reason), in plain words.
export function selectionReason(reason: string | undefined) {
  if (!reason || reason === 'selected') return 'Included';
  if (reason === 'repo overview') return copy.aboutProject;
  if (reason === 'branch update') return copy.branchStands;
  if (reason === 'pinned') return 'Pinned';
  const area = /^referenced area (.+)$/.exec(reason);
  if (area) return `In ${area[1]}, which you referenced`;
  const matched = /^matched(?: (.+?))?(?: in (\S.*))?$/.exec(reason);
  if (matched) return `${!matched[1] || matched[1] === 'task terms' ? 'Matches your task' : `Matches ${matched[1]}`}${matched[2] ? ` · in ${matched[2]}` : ''}`;
  return reason;
}

// Why core left a note out (excluded[].reason codes).
const EXCLUDED: Record<string, string> = {
  stale: 'out of date', 'wrong-branch': 'other branch', 'area-not-requested': 'area not in task', duplicate: 'same as a note already included',
  'brief-limit': 'project summary limit', 'folder-removed': 'its folder was removed from the project', budget: 'size limit', 'category-limit': 'too many of one kind', 'left-out-for-task': 'left out by you',
};
export const excludedReason = (code: string) => EXCLUDED[code] ?? code;

// Core warnings are English sentences; map the known ones, show others as they are.
const WARNINGS: [RegExp, (...groups: string[]) => string][] = [
  [/^Project brief search inspected 100 entries\./, () => 'Journal looked at 100 project summaries. Archive old ones so others can be included.'],
  [/^Search inspected 1000 matches\./, () => 'Journal looked at 1,000 matching notes. Narrow the task or archive out-of-date notes to search further.'],
  [/^The current branch update is (\d+) commits? behind HEAD\./, n => `${copy.branchStands} is ${count(Number(n), 'commit')} behind. Draft an update to review recent progress.`],
  [/^Claims (\S+) r(\d+) and (\S+) r(\d+) may conflict\./, (a, ra, b, rb) => `Notes ${a} (revision ${ra}) and ${b} (revision ${rb}) may conflict. Check them in Memory.`],
  [/^Only four current project brief entries fit/, () => 'Only four project summaries fit. Combine or archive older ones.'],
  [/^A project brief was excluded by the context budget\./, () => 'A project summary did not fit the size limit. Shorten or combine summaries.'],
  [/^No current approved project brief is included\./, () => `No “${copy.aboutProject}” note is included. Add one so every session starts oriented.`],
];
export function warningText(text: string) {
  for (const [pattern, render] of WARNINGS) { const match = pattern.exec(text); if (match) return render(...match.slice(1)); }
  return text;
}
~~~~

Run: `node --test tests/copy.test.mjs`
Expected: the two vocabulary tests pass; "components use the plain vocabulary" fails, listing 60 strings such as `App.tsx:291: Research (starts in Claude plan mode, …)`, `ContextPanel.tsx:78: Historical receipts never change.` and `KnowledgePanel.tsx:56: Approve`.

- [ ] **Step 4: Apply the vocabulary.** Save the following as `.cache/copy-edits.mjs` and run `node .cache/copy-edits.mjs`. Each entry is an exact old → new replacement; the script stops at the first entry whose text is not found exactly once (exactly `times` for spec selectors). Component edits change only visible text, tooltips and the internal panel id `'knowledge'` → `'memory'` (`ResizableWorkspace` keeps its side id `knowledge`, which keys the stored widths, and only renames the separator's accessible name).

~~~~js
// Task 1.2: exact text edits. Each `old` must occur exactly once (spec edits: `times` occurrences).
// Run from the repository root: node .cache/copy-edits.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const components = [
  ["src/ui/App.tsx",
   "import { storedAppearance, type Appearance } from './theme';",
   "import { storedAppearance, type Appearance } from './theme';\nimport { copy, tip } from './copy';"],
  ["src/ui/App.tsx",
   "type Panel = 'files' | 'knowledge' | 'context' | 'changes' | 'activity';",
   "type Panel = 'files' | 'memory' | 'context' | 'changes' | 'activity';"],
  ["src/ui/App.tsx",
   "const [panel, setPanel] = useState<Panel>('knowledge');",
   "const [panel, setPanel] = useState<Panel>('memory');"],
  ["src/ui/App.tsx",
   "setPanel(current => current === 'changes' || current === 'activity' ? 'knowledge' : current);",
   "setPanel(current => current === 'changes' || current === 'activity' ? 'memory' : current);"],
  ["src/ui/App.tsx",
   "resumable(target) && { id: 'resume', label: 'Resume', enabled: canStart && !busy },",
   "resumable(target) && { id: 'resume', label: copy.continue, enabled: canStart && !busy },"],
  ["src/ui/App.tsx",
   "<span className=\"optional\">optional · used to select relevant knowledge</span>",
   "<span className=\"optional\">optional · picks relevant notes</span>"],
  ["src/ui/App.tsx",
   "placeholder=\"What are you working on? Mention a module or path to include knowledge scoped to it.\"",
   "placeholder=\"What are you working on? Mention a module or path to include notes about it.\""],
  ["src/ui/App.tsx",
   "<option key={w.id} value={w.id!}>{w.kind === 'managed' ? 'Worktree' : 'Imported'} · {w.branch ?? 'detached'}</option>",
   "<option key={w.id} value={w.id!}>{w.kind === 'managed' ? copy.separateCopy : 'Existing worktree'} · {w.branch ?? 'detached'}</option>"],
  ["src/ui/App.tsx",
   "<label className=\"inline-check\"><input type=\"checkbox\" checked={research} onChange={e => { setResearch(e.target.checked); if (e.target.checked) setPlan(false); }} /> Research (starts in Claude plan mode, the Codex read-only sandbox or Cursor Ask mode; can be changed in the session)</label>",
   "<label className=\"inline-check\" title={tip.readOnly}><input type=\"checkbox\" checked={research} onChange={e => { setResearch(e.target.checked); if (e.target.checked) setPlan(false); }} /> {copy.readOnly}</label>"],
  ["src/ui/App.tsx",
   "<label className=\"inline-check\"><input type=\"checkbox\" checked={plan} onChange={e => { setPlan(e.target.checked); if (e.target.checked) setResearch(false); }} /> Plan (Claude plan mode or Cursor Plan mode)</label>",
   "<label className=\"inline-check\" title={tip.plan}><input type=\"checkbox\" checked={plan} onChange={e => { setPlan(e.target.checked); if (e.target.checked) setResearch(false); }} /> {copy.plan}</label>"],
  ["src/ui/App.tsx",
   "${session.research ? ' · research' : session.plan ? ' · plan' : ''}",
   "${session.research ? ' · read-only' : session.plan ? ' · plan' : ''}"],
  ["src/ui/App.tsx",
   "<button onClick={() => void sessionAction('stop')} disabled={session.status === 'stopping'}>Stop terminal</button>",
   "<button onClick={() => void sessionAction('stop')} disabled={session.status === 'stopping'}>{copy.stop}</button>"],
  ["src/ui/App.tsx",
   "{resumable(session) && <button disabled={busy || !canStart} onClick={() => void start(session.provider, session)}>Resume</button>}",
   "{resumable(session) && <button title={tip.continue} disabled={busy || !canStart} onClick={() => void start(session.provider, session)}>{copy.continue}</button>}"],
  ["src/ui/App.tsx",
   "so it will not signal it. Resume stays blocked until it ends; check it outside Journal.",
   "so it will not signal it. Continuing stays blocked until it ends; check it outside Journal."],
  ["src/ui/App.tsx",
   "End it here, or leave it running; resuming this conversation stays blocked while it runs.",
   "End it here, or leave it running; continuing this conversation stays blocked while it runs."],
  ["src/ui/App.tsx",
   "This session's runtime stopped unexpectedly. Its prompt delivery is marked uncertain and nothing was resent.{resumable(session) ? ' Resume reopens the exact native conversation.' : ''}",
   "This session's runtime stopped unexpectedly. Whether its first message reached the agent is uncertain, and nothing was resent.{resumable(session) ? ' Continue reopens the same conversation.' : ''}"],
  ["src/ui/App.tsx",
   ">Confirm resume ID</button>",
   ">Confirm conversation ID</button>"],
  ["src/ui/App.tsx",
   "{(['files', 'knowledge', 'context', 'changes', 'activity'] as Panel[]).map(",
   "{(['files', 'memory', 'context', 'changes', 'activity'] as Panel[]).map("],
  ["src/ui/App.tsx",
   "<button role=\"tab\" aria-selected={panel === 'knowledge'} onClick={() => setPanel('knowledge')}><span className=\"panel-tab-label\">Knowledge</span></button>",
   "<button role=\"tab\" aria-selected={panel === 'memory'} title={tip.memoryTab} onClick={() => setPanel('memory')}><span className=\"panel-tab-label\">{copy.memoryTab}</span></button>"],
  ["src/ui/App.tsx",
   "{panel === 'knowledge' && <KnowledgePanel",
   "{panel === 'memory' && <KnowledgePanel"],
  ["src/ui/App.tsx",
   "The native Claude, Codex or Cursor session ID and exact resume are unaffected.",
   "The native Claude, Codex or Cursor session ID and continuing the same conversation are unaffected."],
  ["src/ui/App.tsx",
   "onSaved={() => { setEvidenceSource(null); setPanel('knowledge'); setKnowledgeVersion(v => v + 1); }}",
   "onSaved={() => { setEvidenceSource(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }}"],
  ["src/ui/App.tsx",
   "onSaved={() => { setForm(null); setPanel('knowledge'); setKnowledgeVersion(v => v + 1); }}",
   "onSaved={() => { setForm(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }}"],
  ["src/ui/KnowledgePanel.tsx",
   "import { api, type Memory, type MemoryPage, type Project, type Proposal, type StatusDraft } from './types';",
   "import { api, type Memory, type MemoryPage, type Project, type Proposal, type StatusDraft } from './types';\nimport { category, copy, memoryState, tip } from './copy';"],
  ["src/ui/KnowledgePanel.tsx",
   "<h2>Project knowledge</h2></div><button className=\"icon-button\" aria-label=\"Add knowledge\" onClick={() => onEdit({})}>＋</button></div><p className=\"muted panel-intro\">A repo overview and current branch update orient every session. Relevant decisions and lessons add task context.</p>",
   "<h2>{copy.memory}</h2></div><button className=\"icon-button\" aria-label={copy.addNote} onClick={() => onEdit({})}>＋</button></div><p className=\"muted panel-intro\">{copy.aboutProject} and {copy.branchStands} reach every session. Relevant decisions, rules and lessons are added for the task.</p>"],
  ["src/ui/KnowledgePanel.tsx",
   "<button onClick={() => onEdit({ initialCategory: 'brief' })}>Add project brief</button>",
   "<button onClick={() => onEdit({ initialCategory: 'brief' })}>{copy.addSummary}</button>"],
  ["src/ui/KnowledgePanel.tsx",
   "<section className=\"proposal-inbox\" aria-label=\"Proposals\"><span className=\"eyebrow\">INBOX · {proposals.length} PROPOSAL{proposals.length === 1 ? '' : 'S'} FROM OBSERVED EVIDENCE</span>",
   "<section className=\"proposal-inbox\" aria-label={copy.suggestions}><span className=\"eyebrow\">SUGGESTIONS FROM YOUR SESSIONS · {proposals.length}</span>"],
  ["src/ui/KnowledgePanel.tsx",
   "{proposal.kind === 'rule' ? 'Rule line in a task' : proposal.kind === 'test-command' ? 'Observed passing test command' : 'Branch moved after a session'} · {proposal.category}",
   "{proposal.kind === 'rule' ? 'You stated this rule in a task' : proposal.kind === 'test-command' ? 'Seen passing in your sessions' : 'Branch moved after a session'} · {category(proposal.category, proposal.scope)}"],
  ["src/ui/KnowledgePanel.tsx",
   "aria-label=\"Search knowledge\" placeholder=\"Search knowledge…\"",
   "aria-label=\"Search project memory\" placeholder=\"Search project memory…\""],
  ["src/ui/KnowledgePanel.tsx",
   "<button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>Approved</button>",
   "<button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>{copy.remembered}</button>"],
  ["src/ui/KnowledgePanel.tsx",
   "<span>{memory.category}{memory.pinned ? ' · pinned' : ''}",
   "<span>{category(memory.category, memory.scope)}{memory.pinned ? ' · pinned' : ''}"],
  ["src/ui/KnowledgePanel.tsx",
   "<span className={`memory-state ${memory.validation !== 'current' ? 'stale' : memory.status}`}>{memory.validation === 'folder-removed' ? 'folder removed' : memory.validation !== 'current' ? memory.validation : memory.status === 'active' ? 'approved' : memory.status === 'candidate' ? 'needs review' : memory.status}</span>",
   "<span className={`memory-state ${memory.validation !== 'current' ? 'stale' : memory.status}`}>{memoryState(memory)}</span>"],
  ["src/ui/KnowledgePanel.tsx",
   "onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'active' }), { optimistic: true })}>Approve</button>",
   "title={tip.remember} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'active' }), { optimistic: true })}>{copy.remember}</button>"],
  ["src/ui/KnowledgePanel.tsx",
   "{memory.status === 'active' && <button disabled={pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'archived' }), { optimistic: true })}>Withdraw</button>}",
   "{memory.status === 'active' && <button title={tip.archive} disabled={pending} onClick={() => void act(() => api('setMemoryStatus', { id: memory.id, status: 'archived' }), { optimistic: true })}>{copy.archive}</button>}"],
  ["src/ui/KnowledgePanel.tsx",
   "<h3>{search ? 'No matching knowledge' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.'}</h3><p>Add a decision, a constraint, or a lesson.<br />It becomes shared knowledge after you approve it.</p>{!search && <button onClick={() => onEdit({})}>Add knowledge</button>}",
   "<h3>{search ? 'No matching notes' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.'}</h3><p>Add a decision, a rule or a lesson.<br />Agents get it once you remember it.</p>{!search && <button onClick={() => onEdit({})}>{copy.addNote}</button>}"],
  ["src/ui/KnowledgeForm.tsx",
   "import { api, type Memory, type Project, type StatusDraft } from './types';",
   "import { api, type Memory, type Project, type StatusDraft } from './types';\nimport { category as categoryName, copy } from './copy';"],
  ["src/ui/KnowledgeForm.tsx",
   "catch (error) { setError(error instanceof Error ? error.message : 'Could not save knowledge'); }",
   "catch (error) { setError(error instanceof Error ? error.message : 'Could not save the note'); }"],
  ["src/ui/KnowledgeForm.tsx",
   "<span className=\"eyebrow\">PROJECT KNOWLEDGE</span><h2 id=\"knowledge-title\">{draft ? draft.scope === 'branch' ? 'Review branch update' : 'Review repo overview' : supersedes ? 'Replace claim' : memory ? 'Revise knowledge' : 'Add knowledge'}</h2></div><button type=\"button\" onClick={onClose} aria-label=\"Close knowledge form\" className=\"icon-button\">×</button>",
   "<span className=\"eyebrow\">PROJECT MEMORY</span><h2 id=\"knowledge-title\">{draft ? draft.scope === 'branch' ? 'Review branch update' : 'Review repo overview' : supersedes ? 'Replace note' : memory ? 'Revise note' : copy.addNote}</h2></div><button type=\"button\" onClick={onClose} aria-label=\"Close note form\" className=\"icon-button\">×</button>"],
  ["src/ui/KnowledgeForm.tsx",
   "<section className=\"draft-basis\" aria-label=\"Proposal basis\">",
   "<section className=\"draft-basis\" aria-label=\"Draft basis\">"],
  ["src/ui/KnowledgeForm.tsx",
   "Nothing is saved until you choose Save for review, and agents receive it only after you approve it.",
   "Nothing is saved until you choose Save for review, and agents get it only after you remember it."],
  ["src/ui/KnowledgeForm.tsx",
   "'Current approved briefs orient every session. Describe the repo purpose and structure, or the current branch progress and next step. Revise it when the state changes.' : 'Save a claim and its source. Review it before either agent receives it.'",
   "`${copy.aboutProject} and ${copy.branchStands} reach every session. Describe the repo purpose and structure, or the current branch progress and next step. Revise it when the state changes.` : 'Save a note and its source. Agents get it only after you remember it.'"],
  ["src/ui/KnowledgeForm.tsx",
   "<option key={x} value={x}>{x === 'brief' ? 'Project brief / branch update' : x}</option>",
   "<option key={x} value={x}>{x === 'brief' ? `${copy.projectSummary} (${copy.aboutProject} or ${copy.branchStands})` : categoryName(x)}</option>"],
  ["src/ui/KnowledgeForm.tsx",
   "{category === 'brief' ? 'Current branch update' : 'This branch'}",
   "{category === 'brief' ? copy.branchStands : 'This branch'}"],
  ["src/ui/KnowledgeForm.tsx",
   "{category === 'brief' ? 'Repo overview · all branches in this checkout' : 'This checkout'}",
   "{category === 'brief' ? `${copy.aboutProject} · all branches in this checkout` : 'This checkout'}"],
  ["src/ui/KnowledgeForm.tsx",
   "Rewriting or resetting that history marks the update stale.",
   "Rewriting or resetting that history marks it out of date."],
  ["src/ui/ContextPanel.tsx",
   "import { api, PROVIDER_NAMES, type Bootstrap, type FileReference, type Receipt, type Session, type TimelineEvent } from './types';",
   "import { api, PROVIDER_NAMES, type Bootstrap, type FileReference, type Receipt, type Session, type TimelineEvent } from './types';\nimport { category, copy, count, deliveryState, excludedReason, selectionReason, warningText } from './copy';"],
  ["src/ui/ContextPanel.tsx",
   "const reasons: Record<string, string> = {\n  stale: 'evidence changed', 'wrong-branch': 'other branch', 'area-not-requested': 'area not in task', duplicate: 'duplicate of a selected claim',\n  'brief-limit': 'orientation limit', 'folder-removed': 'its folder was removed from the project', budget: 'context budget', 'category-limit': 'too many of one kind', 'left-out-for-task': 'left out by you',\n};\n\n",
   ""],
  ["src/ui/ContextPanel.tsx",
   "<h2>Context inspector</h2>",
   "<h2>{!receipt || preview ? copy.willKnow : copy.whatWasSent}</h2>"],
  ["src/ui/ContextPanel.tsx",
   "<span>{receipt.items.length} claim{receipt.items.length === 1 ? '' : 's'}</span>",
   "<span>{count(receipt.items.length, 'note')}</span>"],
  ["src/ui/ContextPanel.tsx",
   "<span className=\"receipt-state\">{receipt.state}</span>",
   "<span className=\"receipt-state\">{deliveryState(receipt.state)}</span>"],
  ["src/ui/ContextPanel.tsx",
   "{session.research ? ' · research mode' : ''}",
   "{session.research ? ' · read-only mode' : ''}"],
  ["src/ui/ContextPanel.tsx",
   "'Whether the model read or used each claim; tool output; hidden reasoning.' : 'Whether the model read or used each claim; commands and test results; tool output; hidden reasoning.'",
   "'Whether the model read or used each note; tool output; hidden reasoning.' : 'Whether the model read or used each note; commands and test results; tool output; hidden reasoning.'"],
  ["src/ui/ContextPanel.tsx",
   "<div className=\"memory-meta\"><span>{item.category}{item.pinned ? ' · pinned' : ''}</span><span>{item.selection?.reason ?? 'selected'} · {item.selection?.bytes ?? 0} B</span></div>",
   "<div className=\"memory-meta\"><span>{category(item.category, item.scope)}{item.pinned ? ' · pinned' : ''}</span><span>{selectionReason(item.selection?.reason)} · {item.selection?.bytes ?? 0} B</span></div>"],
  ["src/ui/ContextPanel.tsx",
   "{disabled.length} claim{disabled.length === 1 ? '' : 's'} left out for the next start.",
   "{count(disabled.length, 'note')} left out for the next start."],
  ["src/ui/ContextPanel.tsx",
   "<summary>{receipt.excluded.length} considered and excluded</summary>{receipt.excluded.map(x => <p key={x.id + x.reason} className=\"muted\">{x.id.slice(0, 8)} · {reasons[x.reason] ?? x.reason}",
   "<summary>{receipt.excluded.length} not included</summary>{receipt.excluded.map(x => <p key={x.id + x.reason} className=\"muted\">{x.id.slice(0, 8)} · {excludedReason(x.reason)}"],
  ["src/ui/ContextPanel.tsx",
   "{receipt.warnings?.map(warning => <p className=\"hint\" key={warning}>{warning}</p>)}",
   "{receipt.warnings?.map(warning => <p className=\"hint\" key={warning}>{warningText(warning)}</p>)}"],
  ["src/ui/ContextPanel.tsx",
   "'Submitted means the CLI process started with this text. It does not prove the model read or used it.'",
   "'Sent means the CLI process started with this text. It does not prove the model read or used it.'"],
  ["src/ui/ContextPanel.tsx",
   "{receipt.preview ? '' : ' Historical receipts never change.'}",
   "{receipt.preview ? '' : ' This record never changes.'}"],
  ["src/ui/ContextPanel.tsx",
   "<span className=\"eyebrow\">RECENT RECEIPTS</span>{history.slice(0, 10).map(r => <button key={r.id} onClick={() => onSelectReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{r.items.length} claims · {r.state} · {new Date(r.createdAt).toLocaleString()}</small></button>)}",
   "<span className=\"eyebrow\">SENT BEFORE</span>{history.slice(0, 10).map(r => <button key={r.id} onClick={() => onSelectReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{count(r.items.length, 'note')} · {deliveryState(r.state)} · {new Date(r.createdAt).toLocaleString()}</small></button>)}"],
  ["src/ui/ActivityPanel.tsx",
   "import { api, type Session, type TimelineEvent } from './types';",
   "import { api, type Session, type TimelineEvent } from './types';\nimport { count, deliveryState } from './copy';"],
  ["src/ui/ActivityPanel.tsx",
   "case 'resume': return 'Resumed the native conversation';",
   "case 'resume': return 'Continued the same conversation';"],
  ["src/ui/ActivityPanel.tsx",
   "case 'context': return `Context ${b.state ?? 'prepared'}: ${b.claims} claim${b.claims === 1 ? '' : 's'}`;",
   "case 'context': return `Context ${deliveryState(b.state)}: ${count(Number(b.claims ?? 0), 'note')}`;"],
  ["src/ui/DataDialog.tsx",
   "timelines of sessions that ended more than 90 days ago are trimmed automatically. Knowledge is never pruned.",
   "timelines of sessions that ended more than 90 days ago are trimmed automatically. Project memory is never pruned."],
  ["src/ui/DataDialog.tsx",
   "<dt>Records</dt><dd>{info.tables.memories} claims · {info.tables.sessions} sessions · {info.tables.events} timeline events · {info.tables.receipts} receipts</dd>",
   "<dt>Records</dt><dd>{info.tables.memories} notes · {info.tables.sessions} sessions · {info.tables.events} timeline events · {info.tables.receipts} records of what was sent</dd>"],
  ["src/ui/DataDialog.tsx",
   "return r ? `Exported ${r.memories} approved claims to ${r.path}",
   "return r ? `Exported ${r.memories} remembered notes to ${r.path}"],
  ["src/ui/DataDialog.tsx",
   ">Export {project.name} knowledge…</button>",
   ">Export {project.name} memory…</button>"],
  ["src/ui/DataDialog.tsx",
   "return r ? `Imported ${r.imported} claims for review; skipped ${r.skipped.length}. Imported claims wait in Needs review.` : null; })}>Import knowledge…</button>",
   "return r ? `Imported ${r.imported} notes for review; skipped ${r.skipped.length}. They wait in Needs review.` : null; })}>Import notes…</button>"],
  ["src/ui/DataDialog.tsx",
   "Add <code>--force</code> only if Journal crashed and left a stale lock.",
   "Add <code>--force</code> only if Journal crashed and left a lock behind."],
  ["src/ui/ManageProjectDialog.tsx",
   "Context source{root.knowledge ? ` · ${root.knowledge} claim${root.knowledge === 1 ? '' : 's'}` : ''}.",
   "Context source{root.knowledge ? ` · ${root.knowledge} note${root.knowledge === 1 ? '' : 's'}` : ''}."],
  ["src/ui/ManageProjectDialog.tsx",
   "<dt>Knowledge</dt><dd>{details.counts.knowledge} claims · {details.counts.proposals} open proposals</dd>",
   "<dt>Memory</dt><dd>{details.counts.knowledge} notes · {details.counts.proposals} open suggestions</dd>"],
  ["src/ui/ExplorerPanel.tsx",
   "Save as knowledge…",
   "Save as a note…"],
  ["src/ui/ProviderStatus.tsx",
   "so Research and Plan are unavailable for Cursor.",
   "so Read-only and Plan are unavailable for Cursor."],
  ["src/ui/ResizableWorkspace.tsx",
   "export const RAIL_WIDTH = 34;",
   "export const RAIL_WIDTH = 34;\n// Accessible names; the side ids are also the keys of the stored widths.\nconst names: Record<Side, string> = { project: 'project sidebar', knowledge: 'side panel' };"],
  ["src/ui/ResizableWorkspace.tsx",
   "aria-label={`Resize ${side} sidebar`}",
   "aria-label={`Resize ${names[side]}`}"],
];

const specs = [
  ["tests/desktop.spec.ts", "getByRole('button', { name: 'Add knowledge' })", "getByRole('button', { name: 'Add a note' })", 2],
  ["tests/desktop.spec.ts", "getByRole('button', { name: 'Approve', exact: true })", "getByRole('button', { name: 'Remember', exact: true })", 1],
  ["tests/desktop.spec.ts", "getByRole('separator', { name: 'Resize knowledge sidebar', exact: true })", "getByRole('separator', { name: 'Resize side panel', exact: true })", 1],
  ["tests/desktop.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 5],
  ["tests/desktop.spec.ts", "getByRole('button', { name: 'Resume', exact: true })", "getByRole('button', { name: 'Continue', exact: true })", 2],
  ["tests/desktop.spec.ts", "getByRole('button', { name: 'Confirm resume ID' })", "getByRole('button', { name: 'Confirm conversation ID' })", 1],
  ["tests/desktop.spec.ts", "getByRole('tab', { name: /Knowledge/ })", "getByRole('tab', { name: /^Memory/ })", 1],
  ["tests/desktop-brief.spec.ts", "getByRole('button', { name: 'Add project brief', exact: true })", "getByRole('button', { name: 'Add project summary', exact: true })", 2],
  ["tests/desktop-brief.spec.ts", "getByRole('tab', { name: /^Knowledge/ })", "getByRole('tab', { name: /^Memory/ })", 3],
  ["tests/desktop-brief.spec.ts", "getByRole('button', { name: 'Approve', exact: true })", "getByRole('button', { name: 'Remember', exact: true })", 2],
  ["tests/desktop-brief.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 3],
  ["tests/desktop-brief.spec.ts", "card.getByRole('button', { name: 'Withdraw', exact: true })", "card.getByRole('button', { name: 'Archive', exact: true })", 1],
  ["tests/desktop-status.spec.ts", "getByRole('button', { name: 'Close knowledge form' })", "getByRole('button', { name: 'Close note form' })", 1],
  ["tests/desktop-status.spec.ts", "getByRole('tab', { name: /^Knowledge/ })", "getByRole('tab', { name: /^Memory/ })", 3],
  ["tests/desktop-status.spec.ts", "getByRole('button', { name: 'Approve', exact: true })", "getByRole('button', { name: 'Remember', exact: true })", 1],
  ["tests/desktop-layout.spec.ts", "getByRole('separator', { name: 'Resize knowledge sidebar', exact: true })", "getByRole('separator', { name: 'Resize side panel', exact: true })", 1],
  ["tests/desktop-layout.spec.ts", "getByRole('tab', { name: /^Knowledge/ })", "getByRole('tab', { name: /^Memory/ })", 1],
  ["tests/desktop-cursor.spec.ts", "getByLabel(/Research \\(starts/)", "getByLabel('Read-only', { exact: true })", 2],
  ["tests/desktop-cursor.spec.ts", "toContainText('research')", "toContainText('read-only')", 1],
  ["tests/desktop-cursor.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 1],
  ["tests/desktop-cursor.spec.ts", "getByRole('button', { name: 'Resume', exact: true })", "getByRole('button', { name: 'Continue', exact: true })", 1],
  ["tests/desktop-lifecycle.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 2],
  ["tests/desktop-lifecycle.spec.ts", "getByRole('button', { name: 'Resume', exact: true })", "getByRole('button', { name: 'Continue', exact: true })", 3],
  ["tests/desktop-context-menus.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 1],
  ["tests/desktop-explorer.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 1],
  ["tests/desktop-sessions.spec.ts", "getByRole('button', { name: 'Stop terminal' })", "getByRole('button', { name: 'Stop', exact: true })", 3],
  ["tests/desktop-sessions.spec.ts", "selectOption({ label: 'Worktree · journal/isolated' })", "selectOption({ label: 'Separate copy (worktree) · journal/isolated' })", 1],
  ["tests/desktop-sessions.spec.ts", "getByLabel(/Research/)", "getByLabel('Read-only', { exact: true })", 1],
  ["tests/desktop-sessions.spec.ts", "toContainText('worktree · research')", "toContainText('worktree · read-only')", 1],
];

const apply = (file, old, replacement, times = 1) => {
  const text = readFileSync(file, 'utf8'); const found = text.split(old).length - 1;
  if (found !== times) throw new Error(`${file}: expected ${times} occurrence(s), found ${found}:\n${old}`);
  writeFileSync(file, text.split(old).join(replacement));
};
for (const [file, old, replacement] of components) apply(file, old, replacement);
for (const [file, old, replacement, times] of specs) apply(file, old, replacement, times);
console.log(`${components.length} component edits and ${specs.length} spec edits applied`);
~~~~

Expected output: `74 component edits and 29 spec edits applied`.

The spec edits, in short:

| Old selector | New selector | Where |
|---|---|---|
| `button 'Add knowledge'` | `'Add a note'` | desktop.spec 40, 140 |
| `button 'Approve'` (exact) | `'Remember'` | desktop 46; brief 33, 40; status 50 |
| `tab /^Knowledge/`, `/Knowledge/` | `/^Memory/` | brief 32, 53, 62; status 42, 49, 57; layout 59; desktop 138 |
| `button 'Resume'` (exact) | `'Continue'` | desktop 99, 111; cursor 118; lifecycle 77, 78, 109 |
| `button 'Stop terminal'` | `'Stop'` (exact) | 16 places in 7 specs |
| `button 'Withdraw'` (in the card) | `'Archive'` | brief 64 |
| `button 'Add project brief'` | `'Add project summary'` | brief 25, 35 |
| `button 'Confirm resume ID'` | `'Confirm conversation ID'` | desktop 110 |
| `button 'Close knowledge form'` | `'Close note form'` | status 30 |
| `separator 'Resize knowledge sidebar'` | `'Resize side panel'` | desktop 71; layout 19 |
| `label /Research/`, `/Research \(starts/` | `'Read-only'` (exact) | sessions 195; cursor 93, 101 |
| `.terminal-label` `'research'`, `'worktree · research'` | `'read-only'`, `'worktree · read-only'` | cursor 97; sessions 201 |
| option `'Worktree · journal/isolated'` | `'Separate copy (worktree) · journal/isolated'` | sessions 194 |

Unchanged on purpose: the provider prefixes of session rows (`Claude Code: …`, `Codex: …`, `Cursor: …`), `Preview context`, `Save for review`, `Initial task`, `Native session ID`, `Leave out for this task`, `/left out by you/`, `/Show exact/`, the region names `REFERENCED …`, and every `context-packet` text check (packets are immutable core text).

- [ ] **Step 5: Run the checks.**
Run: `node --test tests/copy.test.mjs`, then all four checks.
Expected: 236 unit tests and 17 desktop scenarios pass.

- [ ] **Step 6: Commit.**

```bash
git add src/ui tests/copy.test.mjs tests/desktop*.spec.ts
git commit -m "Use the plain vocabulary: project memory, notes, Remember, Continue, Read-only" -m "Core reasons and warnings are mapped in the renderer; receipt and packet text is unchanged. Technical terms stay in tooltips." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** board B8 vocabulary on every current screen; accessible names equal visible labels; tooltips keep the technical term; no receipt text changed.

### Task 1.3: Provider marks

**Files:**
- Create: `src/ui/ProviderMark.tsx`, `tests/provider-mark.test.mjs`
- Modify: `src/ui/SessionList.tsx`, `App.tsx`, `ContextPanel.tsx`, `ProviderStatus.tsx`, `styles.css`, `scripts/notices.mjs`, `THIRD_PARTY_NOTICES.md` (generated), `tests/release.test.mjs`, `tests/desktop.spec.ts`

- [ ] **Step 1: Write the failing test.** Create `tests/provider-mark.test.mjs` (it compiles the component's JSX with TypeScript and renders it with `react-dom/server`):

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Compiles the component with TypeScript (JSX only; it has no runtime imports) and renders it.
async function load(t) {
  const source = readFileSync(new URL('../src/ui/ProviderMark.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'mark-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ProviderMark.mjs'); writeFileSync(file, outputText);
  return (await import(pathToFileURL(file).href)).ProviderMark;
}

test('provider marks are decorative inline SVG in the provider color', async t => {
  const ProviderMark = await load(t);
  const paths = new Set();
  for (const provider of ['claude', 'codex', 'cursor']) {
    const html = renderToStaticMarkup(createElement(ProviderMark, { provider, size: 20 }));
    assert.match(html, new RegExp(`^<span class="provider-mark ${provider}" style="width:20px;height:20px" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" focusable="false"><path d="[Mm][^"]+" fill="currentColor"></path></svg></span>$`), provider);
    paths.add(html.match(/ d="([^"]+)"/)[1]);
  }
  assert.equal(paths.size, 3, 'Each provider has its own mark');
});
~~~~

Run: `node --test tests/provider-mark.test.mjs`
Expected: FAIL with `ENOENT … src/ui/ProviderMark.tsx`.

- [ ] **Step 2: Create `src/ui/ProviderMark.tsx`** (paths copied from the Simple Icons files `claude.svg`, `openai.svg`, `cursor.svg`; Codex uses the OpenAI mark):

~~~~tsx
import type { Provider } from './types';

// Provider marks: SVG paths from Simple Icons (https://simpleicons.org, CC0 1.0).
// Codex uses the OpenAI mark. The marks are trademarks of Anthropic, OpenAI and
// Anysphere; Journal shows them only to identify the CLI a session runs, always
// next to the provider's name (visible text or the row's accessible name), so the
// mark itself is hidden from assistive technology.
const PATHS: Record<Provider, string> = {
  claude: 'm4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z',
  codex: 'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z',
  cursor: 'M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23',
};

export function ProviderMark({ provider, size = 20 }: { provider: Provider; size?: number }) {
  const glyph = Math.round(size * 0.65);
  return <span className={`provider-mark ${provider}`} style={{ width: size, height: size }} aria-hidden="true">
    <svg viewBox="0 0 24 24" width={glyph} height={glyph} focusable="false"><path d={PATHS[provider]} fill="currentColor" /></svg>
  </span>;
}
~~~~

- [ ] **Step 3: Place the marks and record their source.** Apply these exact replacements (the old `.session-select>span:nth-child(2)` rule would stretch the mark; `.session-text` already has the same rule):

1. `src/ui/SessionList.tsx`: replace

~~~~tsx
import { menuPosition } from './menu';
~~~~

   with

~~~~tsx
import { menuPosition } from './menu';
import { ProviderMark } from './ProviderMark';
~~~~

2. `src/ui/SessionList.tsx`: replace

~~~~tsx
      <span className={`status-dot ${session.status}${label === 'disconnected' ? ' disconnected' : ''}`} />
      <span className="session-text">
~~~~

   with

~~~~tsx
      <span className={`status-dot ${session.status}${label === 'disconnected' ? ' disconnected' : ''}`} />
      <ProviderMark provider={session.provider} size={16} />
      <span className="session-text">
~~~~

3. `src/ui/App.tsx`: replace

~~~~tsx
import { menuPosition, showMenu } from './menu';
~~~~

   with

~~~~tsx
import { menuPosition, showMenu } from './menu';
import { ProviderMark } from './ProviderMark';
~~~~

4. `src/ui/App.tsx`: replace

~~~~tsx
<span className={`status-dot ${session?.status ?? ''}`} /><strong>{session ? PROVIDER_NAMES[session.provider] : 'Terminal'}</strong>
~~~~

   with

~~~~tsx
<span className={`status-dot ${session?.status ?? ''}`} />{session && <ProviderMark provider={session.provider} size={18} />}<strong>{session ? PROVIDER_NAMES[session.provider] : 'Terminal'}</strong>
~~~~

5. `src/ui/App.tsx`: replace

~~~~tsx
'Not found on PATH'}>{PROVIDER_NAMES[a.provider]} {a.available
~~~~

   with

~~~~tsx
'Not found on PATH'}><ProviderMark provider={a.provider} size={16} />{PROVIDER_NAMES[a.provider]} {a.available
~~~~

6. `src/ui/ContextPanel.tsx`: replace

~~~~tsx
import { api, PROVIDER_NAMES,
~~~~

   with

~~~~tsx
import { ProviderMark } from './ProviderMark';
import { api, PROVIDER_NAMES,
~~~~

7. `src/ui/ContextPanel.tsx`: replace

~~~~tsx
{session && <><dt>Route</dt><dd>{PROVIDER_NAMES[session.provider]}
~~~~

   with

~~~~tsx
{session && <><dt>Route</dt><dd><ProviderMark provider={session.provider} size={16} /> {PROVIDER_NAMES[session.provider]}
~~~~

8. `src/ui/ProviderStatus.tsx`: replace

~~~~tsx
import type { AgentInfo } from './types';
~~~~

   with

~~~~tsx
import type { AgentInfo } from './types';
import { ProviderMark } from './ProviderMark';
~~~~

9. `src/ui/ProviderStatus.tsx`: replace

~~~~tsx
  return <section className="provider-status" aria-label="Cursor provider status">{body}
~~~~

   with

~~~~tsx
  return <section className="provider-status" aria-label="Cursor provider status"><ProviderMark provider="cursor" size={20} />{body}
~~~~

10. `src/ui/styles.css`: delete

~~~~css
.session-select>span:nth-child(2){min-width:0;flex:1}
~~~~

11. `src/ui/styles.css`: replace

~~~~css
/* Provider status and visible install/sign-in processes */
~~~~

   with

~~~~css
/* Provider status and visible install/sign-in processes */
.provider-mark{display:inline-grid;place-items:center;flex:none;border-radius:5px;background:var(--hover);color:var(--tx);box-shadow:inset 0 0 0 1px var(--line);vertical-align:middle;margin-right:6px}.provider-mark.claude{background:var(--claude-soft);color:var(--claude);box-shadow:none}.session-select .provider-mark{margin:1px 0 0}.provider-status>.provider-mark{align-self:flex-start}
~~~~

12. `scripts/notices.mjs`: replace

~~~~js
for (const [label, file] of components) if (existsSync(file)) sections.push(`## ${label}\n\nLicense file: ${file.replace('node_modules/', '')}\n\n\`\`\`\n${readFileSync(file, 'utf8').trim()}\n\`\`\``);
~~~~

   with

~~~~js
for (const [label, file] of components) if (existsSync(file)) sections.push(`## ${label}\n\nLicense file: ${file.replace('node_modules/', '')}\n\n\`\`\`\n${readFileSync(file, 'utf8').trim()}\n\`\`\``);
// Artwork kept in Journal's own source rather than installed as a package.
const artwork = [['Provider marks (Simple Icons)', 'CC0-1.0', 'https://github.com/simple-icons/simple-icons', 'src/ui/ProviderMark.tsx',
  'The Claude, OpenAI and Cursor marks are SVG paths from Simple Icons, dedicated to the public domain under CC0 1.0 Universal. The marks are trademarks of Anthropic, OpenAI and Anysphere; Journal shows them only to identify the command-line agent a session runs.']];
for (const [label, license, source, file, text] of artwork) sections.push(`## ${label}\n\nLicense: ${license}\nSource: ${source}\nUsed in: ${file}\n\n${text}`);
~~~~

13. `tests/release.test.mjs`: replace

~~~~js
  assert.match(notices, /^## @fontsource\/jetbrains-mono .*\n\nLicense: OFL-1\.1$/m, 'The bundled monospace font');
~~~~

   with

~~~~js
  assert.match(notices, /^## @fontsource\/jetbrains-mono .*\n\nLicense: OFL-1\.1$/m, 'The bundled monospace font');
  assert.match(notices, /^## Provider marks \(Simple Icons\)\n\nLicense: CC0-1\.0$/m, 'Artwork copied into the source');
~~~~

14. `tests/desktop.spec.ts`: replace

~~~~ts
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
~~~~

   with

~~~~ts
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    await expect(page.locator('.terminal-surface')).toContainText('Fixture tests require Docker');
    // The provider mark sits next to the name; the session row's accessible name is unchanged.
    await expect(page.locator('.terminal-heading .provider-mark.claude svg')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Claude Code: Review Docker tests\./ })).toBeVisible();
~~~~

Run: `npm run notices`
Expected: `Wrote notices for 59 packages`; the new section `## Provider marks (Simple Icons)` with `License: CC0-1.0`.

- [ ] **Step 4: Run the checks.**
Run: all four checks.
Expected: 237 unit tests pass; 17 desktop scenarios pass; session rows keep their `Claude Code: …` accessible names.

- [ ] **Step 5: Commit.**

```bash
git add src/ui scripts/notices.mjs THIRD_PARTY_NOTICES.md tests/provider-mark.test.mjs tests/release.test.mjs tests/desktop.spec.ts
git commit -m "Show provider marks next to provider names" -m "SVG paths from Simple Icons (CC0 1.0), recorded in the generated notices." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** boards B1, B4 and B4b: a Claude tile in its own color, OpenAI and Cursor in `currentColor`, always next to the name, hidden from assistive technology.

### Task 1.4a: Shortcut matcher

**Files:**
- Create: `src/desktop/shortcuts.mjs`, `tests/shortcuts.test.mjs`
- Modify: `src/ui/types.ts:1` (`CommandId`)

- [ ] **Step 1: Write the failing test.** Create `tests/shortcuts.test.mjs`:

~~~~js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { COMMAND_IDS, matchShortcut, shortcutLabels } from '../src/desktop/shortcuts.mjs';

// Electron Input objects as before-input-event delivers them.
const key = (spec, extra = {}) => {
  const parts = spec.split('+'); const name = parts.pop();
  const code = /^\d$/.test(name) ? `Digit${name}` : /^[A-Za-z]$/.test(name) ? `Key${name.toUpperCase()}` : { Enter: 'Enter', '\\': 'Backslash', ',': 'Comma' }[name];
  return { type: 'keyDown', key: name, code, meta: parts.includes('Meta'), control: parts.includes('Control'), alt: parts.includes('Alt'), shift: parts.includes('Shift'), isComposing: false, ...extra };
};

const ROUTED = {
  darwin: [['Meta+N', 'new-session'], ['Meta+O', 'open-project'], ['Meta+Shift+K', 'add-note'], ['Meta+E', 'focus-terminal'], ['Meta+I', 'toggle-inspector'],
    ['Meta+1', 'slot-1'], ['Meta+4', 'slot-4'], ['Meta+Alt+1', 'tab-session'], ['Meta+Alt+2', 'tab-files'], ['Meta+Alt+3', 'tab-memory']],
  win32: [['Control+Shift+N', 'new-session'], ['Control+Shift+K', 'add-note'], ['Control+Shift+E', 'focus-terminal'], ['Control+Shift+B', 'toggle-inspector'],
    ['Alt+1', 'slot-1'], ['Alt+4', 'slot-4'], ['Alt+Shift+1', 'tab-session'], ['Alt+Shift+2', 'tab-files'], ['Alt+Shift+3', 'tab-memory']],
};
ROUTED.linux = ROUTED.win32;

// Keys the terminal and its CLI own: never intercepted.
const TERMINAL = {
  darwin: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+1', 'Alt+1', 'Alt+B', 'Meta+C', 'Meta+V', 'Meta+Q', 'Meta+W', 'Meta+R', 'Meta+5', 'Meta+K', 'Meta+P', 'Meta+Enter'],
  win32: ['Control+C', 'Control+D', 'Control+Z', 'Control+L', 'Control+R', 'Control+O', 'Control+N', 'Control+P', 'Control+K', 'Control+W', 'Control+E', 'Control+B', 'Control+A',
    'Control+1', 'Control+Enter', 'Alt+B', 'Alt+F', 'Alt+5', 'Control+Alt+2', 'Control+Shift+C', 'Control+Shift+V', 'Control+Shift+P', 'Meta+1', 'Meta+N'],
};
TERMINAL.linux = TERMINAL.win32;

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: app shortcuts are routed`, () => {
    for (const [spec, id] of ROUTED[platform]) assert.equal(matchShortcut(key(spec), platform), id, spec);
  });
  test(`${platform}: terminal keys pass through`, () => {
    for (const spec of TERMINAL[platform]) assert.equal(matchShortcut(key(spec), platform), null, spec);
  });
}

test('only key presses outside an input method composition count', () => {
  assert.equal(matchShortcut(key('Meta+N', { type: 'keyUp' }), 'darwin'), null);
  assert.equal(matchShortcut(key('Meta+N', { isComposing: true }), 'darwin'), null);
  assert.equal(matchShortcut(null, 'darwin'), null);
});

test('letters follow the layout; digits and non-Latin layouts follow the physical key', () => {
  // Dvorak: the key labelled N sits where QWERTY has L.
  assert.equal(matchShortcut({ ...key('Meta+N'), code: 'KeyL' }, 'darwin'), 'new-session');
  // Russian layout: ⌘ plus the physical N key types "т".
  assert.equal(matchShortcut({ ...key('Meta+N'), key: 'т' }, 'darwin'), 'new-session');
  // Shift changes key ("N", "|", "!"); macOS Option changes it too ("¡").
  assert.equal(matchShortcut({ ...key('Alt+Shift+1'), key: '!' }, 'linux'), 'tab-session');
  assert.equal(matchShortcut({ ...key('Meta+Alt+1'), key: '¡' }, 'darwin'), 'tab-session');
  // AZERTY: Alt plus the physical 1 key types "&".
  assert.equal(matchShortcut({ ...key('Alt+1'), key: '&' }, 'win32'), 'slot-1');
});

test('every routed command has a label, and the renderer knows every id', () => {
  for (const platform of ['darwin', 'win32']) {
    const labels = shortcutLabels(platform);
    assert.deepEqual(Object.keys(labels).sort(), [...COMMAND_IDS].sort(), platform);
  }
  assert.equal(shortcutLabels('win32')['open-project'], 'Ctrl+O');
  const types = readFileSync(new URL('../src/ui/types.ts', import.meta.url), 'utf8');
  const union = types.match(/export type CommandId = ([^;]+);/)[1].match(/'[^']+'/g).map(id => id.slice(1, -1));
  assert.deepEqual(union.sort(), [...COMMAND_IDS].sort());
});
~~~~

Run: `node --test tests/shortcuts.test.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND … src/desktop/shortcuts.mjs`.

- [ ] **Step 2: Create `src/desktop/shortcuts.mjs`:**

~~~~js
// App shortcuts (design decision D8). The main process matches them in
// before-input-event, so they work while the terminal has focus, and sends
// {type: 'command', id} to the renderer. Any key not listed here reaches the
// page and the terminal untouched.
//
// macOS uses ⌘, which terminals do not receive. Windows and Linux use
// Ctrl+Shift, or Alt+digit for slots: the CLIs own Ctrl+letter (Ctrl+C, Ctrl+R,
// Ctrl+O…) and Alt+letter (word movement). Ctrl+Alt is avoided because it is
// AltGr on many European layouts.
//
// Add a row only together with the renderer code that handles its id: a row
// without a handler would swallow a key and do nothing.
const digit = n => `Digit${n}`;
const MAC = [
  { id: 'new-session', meta: true, key: 'n', label: '⌘N' },
  { id: 'open-project', meta: true, key: 'o', label: '⌘O' },
  { id: 'add-note', meta: true, shift: true, key: 'k', label: '⇧⌘K' },
  { id: 'focus-terminal', meta: true, key: 'e', label: '⌘E' },
  { id: 'toggle-inspector', meta: true, key: 'i', label: '⌘I' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, meta: true, code: digit(n), label: `⌘${n}` })),
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, meta: true, alt: true, code: digit(i + 1), label: `⌥⌘${i + 1}` })),
];
const OTHER = [
  { id: 'new-session', control: true, shift: true, key: 'n', label: 'Ctrl+Shift+N' },
  { id: 'add-note', control: true, shift: true, key: 'k', label: 'Ctrl+Shift+K' },
  { id: 'focus-terminal', control: true, shift: true, key: 'e', label: 'Ctrl+Shift+E' },
  // Ctrl+Shift+I opens developer tools in development builds.
  { id: 'toggle-inspector', control: true, shift: true, key: 'b', label: 'Ctrl+Shift+B' },
  ...[1, 2, 3, 4].map(n => ({ id: `slot-${n}`, alt: true, code: digit(n), label: `Alt+${n}` })),
  ...['session', 'files', 'memory'].map((tab, i) => ({ id: `tab-${tab}`, alt: true, shift: true, code: digit(i + 1), label: `Alt+Shift+${i + 1}` })),
];
const rows = platform => platform === 'darwin' ? MAC : OTHER;

// The letter a key event means: its character on the active layout when that
// is a Latin letter (so Dvorak ⌘N is the key labelled N), otherwise its
// physical position (so ⌘N still works with a Cyrillic layout active).
function letter(input) {
  const key = typeof input.key === 'string' ? input.key.toLowerCase() : '';
  if (/^[a-z]$/.test(key)) return key;
  return /^Key[A-Z]$/.test(input.code ?? '') ? input.code.slice(3).toLowerCase() : null;
}

// input: Electron's before-input-event Input. Returns a command id or null.
export function matchShortcut(input, platform) {
  if (input?.type !== 'keyDown' || input.isComposing) return null;
  const pressed = letter(input);
  for (const row of rows(platform)) {
    if (!!row.meta !== !!input.meta || !!row.control !== !!input.control || !!row.alt !== !!input.alt || !!row.shift !== !!input.shift) continue;
    if (row.code ? input.code === row.code : pressed === row.key) return row.id;
  }
  return null;
}

// Labels for tooltips and menus, by command id. On Windows and Linux, Ctrl+O is
// not routed (the CLI owns it while the terminal has focus); the renderer
// handles it when focus is elsewhere in the window.
export function shortcutLabels(platform) {
  const labels = Object.fromEntries(rows(platform).map(row => [row.id, row.label]));
  return platform === 'darwin' ? labels : { ...labels, 'open-project': 'Ctrl+O' };
}

export const COMMAND_IDS = [...new Set([...MAC, ...OTHER].map(row => row.id))];
~~~~

- [ ] **Step 3: Declare the command ids for the renderer.**

1. `src/ui/types.ts`: replace

~~~~ts
export type Provider = 'claude' | 'codex' | 'cursor';
~~~~

   with

~~~~ts
export type Provider = 'claude' | 'codex' | 'cursor';
// Commands the main process sends for app shortcuts (src/desktop/shortcuts.mjs).
export type CommandId = 'new-session' | 'open-project' | 'add-note' | 'focus-terminal' | 'toggle-inspector' | 'slot-1' | 'slot-2' | 'slot-3' | 'slot-4' | 'tab-session' | 'tab-files' | 'tab-memory';
~~~~

- [ ] **Step 4: Run the checks.**
Run: `node --test tests/shortcuts.test.mjs`, then all four checks.
Expected: 9 new tests pass (246 unit tests); 17 desktop scenarios pass (nothing is wired yet).

- [ ] **Step 5: Commit.**

```bash
git add src/desktop/shortcuts.mjs src/ui/types.ts tests/shortcuts.test.mjs
git commit -m "Add the app shortcut table and matcher for macOS, Windows and Linux" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.4b: Route shortcuts while the terminal has focus (BUG-7)

> **Decision for this task:** while a dialog is open, commands are swallowed by the main-process `preventDefault` because the main process does not know about dialogs. Either accept and document that, or have the renderer report dialog state so the router lets keys through. The router must send a command only when `shouldDispatch(input)` is true (held keys are claimed but not repeated).
>
> **Chosen (implementation):** the renderer reports dialog state. `App.tsx` sends `setModalOpen({ open })` (a validated action on the preload allow-list) whenever one of its modal dialogs opens or closes; while it is open, the router claims no key, so shortcut keys behave natively inside the dialog. A reload resets the flag. The renderer still ignores a command that arrives while a `dialog[open]` exists (a key pressed before main heard about the dialog).

**Files:**
- Create: `tests/support/keys.ts`
- Modify: `src/desktop/main.mjs:22,87,163`, `src/ui/types.ts:16-17,37`, `src/ui/App.tsx:156-175,266,269,318,327`, `src/ui/SessionList.tsx:34-36,58`, `tests/desktop-sessions.spec.ts:92-94`, `tests/desktop-explorer.spec.ts:156-159`, `README.md:106`, `docs/FILE-EXPLORER-DESIGN.md:23`

- [ ] **Step 1: Write the failing desktop tests.** Create `tests/support/keys.ts`:

~~~~ts
import type { ElectronApplication } from '@playwright/test';

// Presses a key the way the operating system delivers it, so it passes through
// Electron's before-input-event and the shortcut router (src/desktop/shortcuts.mjs).
// Playwright's page.keyboard bypasses that hook and reaches the page directly.
export function pressKey(app: ElectronApplication, keyCode: string, modifiers: ('meta' | 'control' | 'alt' | 'shift')[] = []) {
  return app.evaluate(({ BrowserWindow }, key) => {
    BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({ type: 'keyDown', keyCode: key.keyCode, modifiers: key.modifiers });
  }, { keyCode, modifiers });
}
~~~~

Apply the four test replacements from step 3 below (`tests/desktop-sessions.spec.ts` and `tests/desktop-explorer.spec.ts`: the import and the keyboard block in each).
Run: `npx playwright test tests/desktop-sessions.spec.ts -g "four concurrent" && npx playwright test tests/desktop-explorer.spec.ts`
Expected: the explorer scenario FAILS at `Show side panel` (⌘I and Ctrl+Shift+B have no handler yet). The sessions scenario FAILS on Linux and Windows at `aria-current` for `TASK_0` (BUG-7: xterm swallows Alt+4); on macOS it already passes, because ⌘ never reaches the CLI.

- [ ] **Step 2: Implement.** The main process matches keys before the page sees them and sends a command; the renderer handles commands, replacing the window `keydown` switch. On Windows and Linux only Ctrl+O stays a page listener, so it never fires inside the terminal.

- [ ] **Step 3: Apply these exact replacements:**

1. `src/desktop/main.mjs`: replace

~~~~js
import { checkOutcome, menuTemplate } from './menu.mjs';
~~~~

   with

~~~~js
import { checkOutcome, menuTemplate } from './menu.mjs';
import { matchShortcut, shortcutLabels } from './shortcuts.mjs';
~~~~

2. `src/desktop/main.mjs`: replace

~~~~js
  window.webContents.on('will-attach-webview', event => event.preventDefault());
~~~~

   with

~~~~js
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  // App shortcuts work while the terminal has focus (BUG-7): matched here, before
  // the page sees the key, and sent as commands. Other keys reach the page untouched.
  window.webContents.on('before-input-event', (event, input) => {
    const id = matchShortcut(input, process.platform);
    if (id) { event.preventDefault(); send({ type: 'command', id }); }
  });
~~~~

3. `src/desktop/main.mjs`: replace

~~~~js
agents, platform: process.platform, runtime: { state: runtimeState, warning: runtimeWarning },
~~~~

   with

~~~~js
agents, platform: process.platform, shortcuts: shortcutLabels(process.platform), runtime: { state: runtimeState, warning: runtimeWarning },
~~~~

4. `src/ui/types.ts`: replace

~~~~ts
  | { type: 'update'; state: UpdateState } | { type: 'providers'; agents: AgentInfo[] }
~~~~

   with

~~~~ts
  | { type: 'update'; state: UpdateState } | { type: 'providers'; agents: AgentInfo[] } | { type: 'command'; id: CommandId }
~~~~

5. `src/ui/types.ts`: replace

~~~~ts
export interface Bootstrap { projects: Project[]; agents: AgentInfo[]; platform: string; 
~~~~

   with

~~~~ts
export interface Bootstrap { projects: Project[]; agents: AgentInfo[]; platform: string; shortcuts: Partial<Record<CommandId, string>>; 
~~~~

6. `src/ui/App.tsx`: replace

~~~~tsx
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // Switch active sessions: ⌘1–4 on macOS, Alt+1–4 elsewhere (Ctrl+digit stays with the terminal).
      const switching = bootstrap?.platform === 'darwin' ? event.metaKey && !event.altKey : event.altKey && !event.ctrlKey && !event.metaKey;
      if (switching && /^[1-4]$/.test(event.key)) {
        const target = activeOrder(ordered)[Number(event.key) - 1];
        if (target) { event.preventDefault(); void selectSession(target); }
        return;
      }
      if (!mod) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); newSession(); }
      if (event.shiftKey && event.key.toLowerCase() === 'k' && projectRef.current) { event.preventDefault(); setForm({}); }
      // Files: ⌘⇧E / Ctrl+Shift+E. Side panel: ⌘⌥B / Ctrl+Alt+B.
      if (event.shiftKey && event.key.toLowerCase() === 'e' && projectRef.current) { event.preventDefault(); setCollapsed(false); setPanel('files'); setExplorerFocus(n => n + 1); }
      if (event.altKey && event.code === 'KeyB' && projectRef.current) { event.preventDefault(); setCollapsed(value => !value); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
~~~~

   with

~~~~tsx
  // App shortcuts arrive as commands from the main process (src/desktop/shortcuts.mjs),
  // so they also work while the terminal has focus. The ref keeps the handler current.
  const command = useRef<(id: CommandId) => void>(() => {});
  command.current = id => {
    if (document.querySelector('dialog[open]')) return; // an open dialog owns the keyboard
    const slot = /^slot-([1-4])$/.exec(id);
    if (slot) { const target = activeOrder(ordered)[Number(slot[1]) - 1]; if (target && target.id !== selectedId) void selectSession(target); return; }
    if (id === 'new-session') { newSession(); return; }
    if (id === 'open-project') { void openProject(); return; }
    if (!projectRef.current) return;
    if (id === 'add-note') setForm({});
    else if (id === 'toggle-inspector') setCollapsed(value => !value);
    else if (id === 'focus-terminal') { if (session) window.dispatchEvent(new CustomEvent('journal:focus-terminal', { detail: session.id })); }
    // Until the three-tab inspector (Phase 3): Session opens Context, Memory opens the Memory panel.
    else if (id === 'tab-session') { setCollapsed(false); setPanel('context'); }
    else if (id === 'tab-files') { setCollapsed(false); setPanel('files'); setExplorerFocus(n => n + 1); }
    else if (id === 'tab-memory') { setCollapsed(false); setPanel('memory'); }
  };
  useEffect(() => window.journal?.onEvent(event => { if (event.type === 'command') command.current(event.id); }), []);
  // Windows and Linux: Ctrl+O is not routed, because the CLI owns it while the
  // terminal has focus (xterm stops the event there). Elsewhere it opens a project.
  useEffect(() => {
    if (!bootstrap || bootstrap.platform === 'darwin') return;
    const open = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'o') { event.preventDefault(); command.current('open-project'); }
    };
    window.addEventListener('keydown', open); return () => window.removeEventListener('keydown', open);
  }, [bootstrap]);
~~~~

7. `src/ui/App.tsx`: replace

~~~~tsx
import { api, isLive, PROVIDER_NAMES, type Bootstrap,
~~~~

   with

~~~~tsx
import { api, isLive, PROVIDER_NAMES, type Bootstrap, type CommandId,
~~~~

8. `src/ui/App.tsx`: replace

~~~~tsx
<kbd>{bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl'} O</kbd>
~~~~

   with

~~~~tsx
{bootstrap?.shortcuts['open-project'] && <kbd>{bootstrap.shortcuts['open-project']}</kbd>}
~~~~

9. `src/ui/App.tsx`: replace

~~~~tsx
title={`Show side panel (${bootstrap?.platform === 'darwin' ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
~~~~

   with

~~~~tsx
title={`Show side panel (${bootstrap?.shortcuts['toggle-inspector'] ?? ''})`}
~~~~

10. `src/ui/App.tsx`: replace

~~~~tsx
title={`Hide side panel (${bootstrap?.platform === 'darwin' ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
~~~~

   with

~~~~tsx
title={`Hide side panel (${bootstrap?.shortcuts['toggle-inspector'] ?? ''})`}
~~~~

11. `src/ui/App.tsx`: replace

~~~~tsx
onNew={newSession} canStart={!!state && canStart} />
~~~~

   with

~~~~tsx
onNew={newSession} newShortcut={bootstrap?.shortcuts['new-session']} canStart={!!state && canStart} />
~~~~

12. `src/ui/SessionList.tsx`: replace

~~~~tsx
export function SessionList({ sessions, projects, selectedId, currentProjectId, connected, now, onSelect, onMenu, onNew, canStart }: {
~~~~

   with

~~~~tsx
export function SessionList({ sessions, projects, selectedId, currentProjectId, connected, now, onSelect, onMenu, onNew, newShortcut, canStart }: {
~~~~

13. `src/ui/SessionList.tsx`: replace

~~~~tsx
onNew: () => void; canStart: boolean;
~~~~

   with

~~~~tsx
onNew: () => void; newShortcut?: string; canStart: boolean;
~~~~

14. `src/ui/SessionList.tsx`: replace

~~~~tsx
title="New session">＋ New</button>
~~~~

   with

~~~~tsx
title={newShortcut ? `New session (${newShortcut})` : 'New session'}>＋ New</button>
~~~~

15. `tests/desktop-sessions.spec.ts`: replace

~~~~ts
import { execFileSync } from 'node:child_process';
~~~~

   with

~~~~ts
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
~~~~

16. `tests/desktop-sessions.spec.ts`: replace

~~~~ts
    // Keyboard switching: ⌘1–4 on macOS, Alt+1–4 elsewhere.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+4' : 'Alt+4');
    await expect(page.locator('.terminal-label')).toBeVisible();
~~~~

   with

~~~~ts
    // Slot shortcuts work while the terminal has focus (BUG-7): ⌘1–4 on macOS, Alt+1–4 elsewhere.
    await expect(sessionButton(page, 'TASK_2')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await pressKey(app, '4', [process.platform === 'darwin' ? 'meta' : 'alt']); // Active sessions are newest first: slot 4 is TASK_0.
    await expect(sessionButton(page, 'TASK_0')).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.terminal-surface')).toContainText('TASK TASK_0');
    // Keys that are not app shortcuts still reach the CLI.
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
    await pressKey(app, 'C', ['control']);
    await expect(page.locator('.terminal-surface')).toContainText('INTERRUPTED');
~~~~

17. `tests/desktop-explorer.spec.ts`: replace

~~~~ts
import { execFileSync } from 'node:child_process';
~~~~

   with

~~~~ts
import { execFileSync } from 'node:child_process';
import { pressKey } from './support/keys';
~~~~

18. `tests/desktop-explorer.spec.ts`: replace

~~~~ts
    // Collapse and restore the side panel from the keyboard.
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+KeyB' : 'Control+Alt+KeyB');
    await expect(page.getByRole('button', { name: 'Show side panel' })).toBeVisible();
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+KeyE' : 'Control+Shift+KeyE');
~~~~

   with

~~~~ts
    // Collapse the side panel and open Files from the keyboard: ⌘I and ⌥⌘2 on macOS,
    // Ctrl+Shift+B and Alt+Shift+2 elsewhere.
    const mac = process.platform === 'darwin';
    await pressKey(app, mac ? 'I' : 'B', mac ? ['meta'] : ['control', 'shift']);
    await expect(page.getByRole('button', { name: 'Show side panel' })).toBeVisible();
    await pressKey(app, '2', mac ? ['meta', 'alt'] : ['alt', 'shift']);
~~~~

19. `README.md`: replace

~~~~markdown
Keyboard shortcuts: Cmd/Ctrl+O opens a project, Cmd/Ctrl+N starts a new session (focuses the task), ⌘1–4 (macOS) or Alt+1–4 switches active sessions, and Cmd/Ctrl+Shift+K adds knowledge. Ctrl+C in the terminal or **Interrupt** sends an interrupt to the native process.
~~~~

   with

~~~~markdown
Keyboard shortcuts work while the terminal has focus. macOS: ⌘N new session, ⌘O open a project, ⌘1–4 switch active sessions, ⇧⌘K add a note, ⌘E focus the terminal, ⌘I show or hide the side panel, ⌥⌘1–3 open Context, Files or Memory. Windows and Linux: Ctrl+Shift+N, Ctrl+O (outside the terminal), Alt+1–4, Ctrl+Shift+K, Ctrl+Shift+E, Ctrl+Shift+B and Alt+Shift+1–3. Every other key, including Ctrl+C, goes to the terminal; **Interrupt** also sends an interrupt to the native process.
~~~~

20. `docs/FILE-EXPLORER-DESIGN.md`: replace

~~~~markdown
the right panel is collapsible to a rail (⌥⌘B / Ctrl+Alt+B); ⌘⇧E / Ctrl+Shift+E opens Files and focuses the tree. Files sits first among Files, Knowledge, Context, Changes and Activity.
~~~~

   with

~~~~markdown
the right panel is collapsible to a rail (⌘I / Ctrl+Shift+B); ⌥⌘2 / Alt+Shift+2 opens Files and focuses the tree. Files sits first among Files, Memory, Context, Changes and Activity.
~~~~

- [ ] **Step 4: Run the checks.**
Run: all four checks.
Expected: 246 unit tests pass; 17 desktop scenarios pass, including slot 4 selecting `TASK_0` while the terminal has focus, Ctrl+C still reaching the CLI (`INTERRUPTED`), and ⌘I / ⌥⌘2 (Ctrl+Shift+B / Alt+Shift+2) in the explorer scenario.

- [ ] **Step 5: Try it by hand (macOS).** `npm run dev`, open a project, start two fixture or real sessions, click into a terminal and press ⌘1, ⌘2, ⌘E, ⌘I, ⌥⌘2, ⇧⌘K (the dialog opens; ⌘1 inside the dialog does nothing). In the terminal, Ctrl+C, Ctrl+R and Ctrl+O still reach the CLI. Windows and Linux are covered by CI and the table test; a manual Windows pass belongs to Phase 9.

- [ ] **Step 6: Commit.**

```bash
git add src/desktop/main.mjs src/ui/types.ts src/ui/App.tsx src/ui/SessionList.tsx tests/support/keys.ts tests/desktop-sessions.spec.ts tests/desktop-explorer.spec.ts README.md docs/FILE-EXPLORER-DESIGN.md
git commit -m "Route app shortcuts in the main process so they work in the terminal" -m "Fixes BUG-7: Alt+1-4 on Windows and Linux never reached the app while the terminal had focus. Windows and Linux use Ctrl+Shift shortcuts (D8); Ctrl+O stays with the CLI inside the terminal." -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

**Acceptance:** every routed shortcut works with the terminal focused; terminal control keys (Ctrl+C, Ctrl+D, Ctrl+Z, Ctrl+L, Ctrl+R, Ctrl+O, Alt+letter, Ctrl+Shift+C/V) still reach the CLI; tooltips show the platform's keys; no animation on any shortcut.

### Task 1.5: Phase 1 verification and status

- [ ] **Step 1: Run everything and record the counts.**

```bash
npm test && npm run check && npm run build && npm run test:desktop
```

Expected: 246 unit tests pass; `check` and `build` pass (the existing ~545 KiB chunk warning remains); 17 desktop scenarios pass. Check the exit status.

- [ ] **Step 2: Package audit with the fonts (macOS).**

```bash
npm run dist:dir && node scripts/package-audit.mjs release/mac-arm64/Journal.app && npm run smoke:packaged
```

Expected: `Package audit passed: …`, with six `dist/assets/jetbrains-mono-*.woff2` entries on the allow-list; the packaged smoke passes.

- [ ] **Step 3: Visual pass.** Open `.cache/screenshots/` (dark and light) and a real session: compare the palette, the 11 px floor, the focus ring (Tab through the sidebar) and the marks with boards B4 and B8. Check one Claude Code and one Codex session for box-drawing alignment (risk R1). Apply `emil-design-eng`'s review table to the diff: no `transition: all`, hover gated, nothing animated on keyboard actions.

- [ ] **Step 4: Update `docs/IMPLEMENTATION-STATUS.md`.** After the "UX redesign - Phase 0 (bug fixes)" section, add:

```markdown
## UX redesign - Phase 1 (foundation)

Plan: [docs/superpowers/plans/2026-10-04-ux-redesign-phase-1.md](superpowers/plans/2026-10-04-ux-redesign-phase-1.md).

- Design tokens for both themes in `src/ui/tokens.css`; `styles.css` uses tokens only and the light theme comes from them. Every text color is at least 4.5:1 on every surface (tested); the terminal takes its colors from the same values.
- JetBrains Mono (OFL-1.1, from `@fontsource/jetbrains-mono`, Latin and Latin Extended, 400/500/600) is bundled for code, paths, IDs and the terminal; box drawing and other scripts use the next font in the stack.
- Nothing renders below 11 px; one 2 px focus ring on `:focus-visible`; themed scrollbars.
- Plain vocabulary (`src/ui/copy.ts`): Project memory, notes, Remember, Archive, Continue, Stop, Read-only, Separate copy (worktree), What was sent. Core reasons and warnings are mapped in the renderer; receipt and packet text is unchanged. Technical terms stay in tooltips.
- Provider marks (Simple Icons, CC0) next to provider names.
- App shortcuts are routed in the main process and work while the terminal has focus (BUG-7). macOS: ⌘N, ⌘O, ⌘1–4, ⇧⌘K, ⌘E, ⌘I, ⌥⌘1–3. Windows and Linux: Ctrl+Shift+N, Ctrl+O (outside the terminal), Alt+1–4, Ctrl+Shift+K, Ctrl+Shift+E, Ctrl+Shift+B, Alt+Shift+1–3. Every other key goes to the terminal.

Still open: a manual Windows pass of the shortcuts (Phase 9); the terminal shows three rows at 900×640 with widened sidebars until Phase 3 moves the composer.
```

In the "Observed validation (local macOS)" table, change `npm test` to `246 passed` and add "keyboard shortcuts while the terminal has focus" to the desktop coverage list.

- [ ] **Step 5: Commit.**

```bash
git add docs/IMPLEMENTATION-STATUS.md
git commit -m "Record Phase 1 of the UX redesign" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## 7. Replay results (plan validation)

| After task | Unit tests | Unit failures | Desktop passed | Desktop failed | All four checks |
|---|---|---|---|---|---|
| 1.1a | 227 | 0 | 17 | 0 | pass |
| 1.1b | 228 | 0 | 17 | 0 | pass |
| 1.1c | 228 | 0 | 17 | 0 | pass |
| 1.1d | 231 | 0 | 17 | 0 | pass |
| 1.1e | 233 | 0 | 17 | 0 | pass |
| 1.2 | 236 | 0 | 17 | 0 | pass |
| 1.3 | 237 | 0 | 17 | 0 | pass |
| 1.4a | 246 | 0 | 17 | 0 | pass |
| 1.4b | 246 | 0 | 17 | 0 | pass |

Measured on macOS (Apple Silicon), Node 25.6, Electron 44.5.1, headless, from `2a69b4c` with the font package installed from the npm registry tarball. Linux and Windows run in CI after each push.

## 8. Self-review

- Master tasks covered: 1.1 → 1.1a–1.1e; 1.2 → 1.2; 1.3 → 1.3; 1.4 → 1.4a, 1.4b; BUG-7 → 1.4b. F1–F4 and D7–D9 are addressed; corrections are in section 2.
- Names used later: `matchShortcut`, `shortcutLabels`, `COMMAND_IDS`, `CommandId`, `{type:'command', id}`, `bootstrap.shortcuts`, `copy`, `tip`, `category`, `memoryState`, `deliveryState`, `selectionReason`, `excludedReason`, `warningText`, `ProviderMark`, `MONO_FONT`, tokens `--bg … --term`. Phase 2 adds rows for `next-needs-you`; Phase 3 retargets `tab-*` and `toggle-inspector` and adds `toggle-sidebar` and `settings`; Phase 4 owns ⌘↵; Phase 8 adds `palette` and `open-file`.
- Contracts preserved: native CLIs keep login, settings and permissions; no core or runtime change; receipts and packets unchanged; exact-ID resume unchanged (only the button reads "Continue"); no terminal output persisted; no model calls; no motion added.
