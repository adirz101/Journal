import type { ITheme } from '@xterm/xterm';

export type Appearance = 'dark' | 'light';

export function storedAppearance(): Appearance {
  try { return localStorage.getItem('journal-theme') === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export const terminalThemes: Record<Appearance, ITheme> = {
  dark: {
    background: '#101216', foreground: '#d5d9e0', cursor: '#3b82f6', selectionBackground: '#17325b',
    black: '#23272f', red: '#e59a93', green: '#a9c293', yellow: '#d9c18c', blue: '#8faac8', magenta: '#b6a0c5', cyan: '#92bfbd', white: '#d5d9e0',
  },
  light: {
    background: '#ffffff', foreground: '#253044', cursor: '#2563eb', cursorAccent: '#ffffff',
    selectionBackground: '#dbeafe', selectionForeground: '#172554',
    black: '#253044', red: '#b42332', green: '#227044', yellow: '#8a5a0c', blue: '#1d4ed8', magenta: '#7e3fab', cyan: '#087078', white: '#526174',
    brightBlack: '#637188', brightRed: '#b42332', brightGreen: '#227044', brightYellow: '#8a5a0c',
    brightBlue: '#2563eb', brightMagenta: '#7e3fab', brightCyan: '#087078', brightWhite: '#253044',
  },
};
