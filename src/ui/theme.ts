import type { ITheme } from '@xterm/xterm';

export type Appearance = 'dark' | 'light';

export function storedAppearance(): Appearance {
  try { return localStorage.getItem('journal-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

// The --font-mono stack from src/ui/tokens.css (xterm measures glyphs on a canvas).
export const MONO_FONT = '"JetBrains Mono", "SF Mono", ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace';

// xterm cannot read CSS variables: these repeat src/ui/tokens.css (--term, --tx,
// --acc, --scroll-thumb, --tx3); tests/tokens.test.mjs keeps the two in step.
export const terminalThemes: Record<Appearance, ITheme> = {
  dark: {
    background: '#0B0D10', foreground: '#E8EAEE', cursor: '#6AA5FF', cursorAccent: '#0B0D10', selectionBackground: '#21466A',
    scrollbarSliderBackground: '#3A414B', scrollbarSliderHoverBackground: '#8E97A6', scrollbarSliderActiveBackground: '#8E97A6',
    black: '#2A2F37', red: '#F49A88', green: '#7DD39A', yellow: '#F2C46B', blue: '#7FB2FF', magenta: '#BBA9FF', cyan: '#7FD8B8', white: '#B3BAC6',
    brightBlack: '#7C8594', brightRed: '#F49A88', brightGreen: '#7DD39A', brightYellow: '#F2C46B', brightBlue: '#7FB2FF', brightMagenta: '#BBA9FF', brightCyan: '#7FD8B8', brightWhite: '#ECEEF2',
  },
  light: {
    background: '#FAFAFB', foreground: '#14171C', cursor: '#195BCF', cursorAccent: '#FAFAFB', selectionBackground: '#C8DCFA', selectionForeground: '#14171C',
    scrollbarSliderBackground: '#B4BBC6', scrollbarSliderHoverBackground: '#5E6776', scrollbarSliderActiveBackground: '#5E6776',
    black: '#14171C', red: '#AE321E', green: '#17713A', yellow: '#8A5300', blue: '#1A5FD8', magenta: '#5B40C9', cyan: '#0F6B52', white: '#454D5A',
    brightBlack: '#6B7380', brightRed: '#AE321E', brightGreen: '#17713A', brightYellow: '#8A5300', brightBlue: '#1A5FD8', brightMagenta: '#5B40C9', brightCyan: '#0F6B52', brightWhite: '#14171C',
  },
};
