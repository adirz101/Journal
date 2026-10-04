// Terminal colour queries, answered by the runtime that owns the PTY.
//
// CLIs ask the terminal for its background to choose light or dark colours:
// Claude Code (theme "Auto (match terminal)") sends OSC 11 followed by a DA1
// sentinel and waits for both without a timeout; Codex asks OSC 10 and 11;
// Cursor asks OSC 11 and gives up after 60 ms. The runtime answers OSC 10/11/12
// as soon as the query is read, whether or not a window shows the session, so an
// answer never depends on the window's timing (a late answer would be typed into
// the agent's input). DA1 is answered only while no window is attached; an
// attached window's terminal answers it in order with any other device query.
// A replayed buffer is never answered (src/ui/TerminalPane.tsx).
//
// Mode 2031 (theme reports): a CLI that enables it is told when Journal switches
// between light and dark, and asks for the background again.

export const APPEARANCES = ['dark', 'light'];
// These repeat terminalThemes in src/ui/theme.ts (foreground, background, cursor);
// tests/tokens.test.mjs keeps the two in step.
export const TERMINAL_COLORS = Object.freeze({
  dark: Object.freeze({ 10: '#E8EAEE', 11: '#0B0D10', 12: '#6AA5FF' }),
  light: Object.freeze({ 10: '#14171C', 11: '#FAFAFB', 12: '#195BCF' }),
});
// COLORFGBG is "foreground;background" as ANSI colour indexes (rxvt's convention):
// 15 is bright white and 0 black. Claude Code and Cursor read the last field.
export const COLORFGBG = Object.freeze({ dark: '15;0', light: '0;15' });
export const appearanceOf = value => value === 'light' ? 'light' : 'dark';
// CSI ? 997 ; 1 n is dark, 2 is light (the mode 2031 report).
export const themeReport = appearance => `\x1b[?997;${appearance === 'light' ? 2 : 1}n`;
// The xterm reply format: 16 bits per channel, as rgb:rrrr/gggg/bbbb.
export const xtermRgb = hex => `rgb:${[1, 3, 5].map(index => hex.slice(index, index + 2).toLowerCase().repeat(2)).join('/')}`;
// What xterm.js answers to DA1: a VT100 with advanced video.
const DA1_REPLY = '\x1b[?1;2c';
const CARRY_LIMIT = 512;

// OSC 10/11/12 with one or more slots, ended by BEL or ST; DA1 (CSI c or CSI 0 c);
// private mode set/reset (for 2031); the theme report request (CSI ? 996 n).
const SEQUENCES = /\x1b\](1[0-2]);([^\x07\x1b]*)(\x07|\x1b\\)|\x1b\[0?c|\x1b\[\?([\d;]+)([hl])|\x1b\[\?996n/g;
// An escape sequence cut off at the end of a chunk: OSC without its terminator or a CSI without its final byte.
const INCOMPLETE = /\x1b(?:\](?:[^\x07\x1b]|\x1b(?!\\))*|\[[\d;?]*)?$/;

export class QueryResponder {
  constructor() { this.carry = ''; this.themeReports = false; }
  // Reads a chunk of PTY output and returns the bytes to write back to the PTY ('' for none).
  feed(data, { appearance = 'dark', attached = false } = {}) {
    const text = this.carry + data; let reply = '';
    const colors = TERMINAL_COLORS[appearanceOf(appearance)];
    SEQUENCES.lastIndex = 0;
    for (const match of text.matchAll(SEQUENCES)) {
      const [whole, code, slots, end, modes, set] = match;
      if (code) {
        // OSC 10;?;? asks for 10 and 11: each slot is the next colour.
        slots.split(';').forEach((slot, index) => {
          const ident = Number(code) + index;
          if (slot === '?' && colors[ident]) reply += `\x1b]${ident};${xtermRgb(colors[ident])}${end}`;
        });
      } else if (modes) {
        if (modes.split(';').includes('2031')) this.themeReports = set === 'h';
      } else if (whole === '\x1b[?996n') reply += themeReport(appearance);
      else if (!attached) reply += DA1_REPLY;
    }
    const tail = INCOMPLETE.exec(text);
    this.carry = tail && tail[0].length <= CARRY_LIMIT ? tail[0] : '';
    return reply;
  }
}
