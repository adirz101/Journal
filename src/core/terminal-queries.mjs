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
// An escape sequence cut off at the end of a chunk: OSC without its terminator (perhaps
// ending in the ESC of ST) or a CSI without its final byte. Any other ESC ends an OSC, as in xterm.
const INCOMPLETE = /\x1b(?:\][^\x07\x1b]*\x1b?|\[[\d;?]*)?$/;

// Variables naming the terminal Journal was started from (iTerm2, VS Code, tmux…). An agent
// runs in Journal's terminal, so they are removed, and TERM_PROGRAM names Journal.
const INHERITED_TERMINAL = new Set(['TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'LC_TERMINAL', 'LC_TERMINAL_VERSION', 'ITERM_SESSION_ID', 'ITERM_PROFILE',
  'KITTY_WINDOW_ID', 'KITTY_PID', 'KITTY_LISTEN_ON', 'KITTY_PUBLIC_KEY', 'WT_SESSION', 'WT_PROFILE_ID', 'TERM_SESSION_ID', 'TERMINAL_EMULATOR', 'CURSOR_TRACE_ID',
  'TMUX', 'TMUX_PANE', 'STY', 'XTERM_VERSION', 'VTE_VERSION', 'TILIX_ID', 'TERMINATOR_UUID', 'CONEMUANSI', 'CONEMUPID', 'CONEMUTASK', 'COLORFGBG']);
const INHERITED_PREFIXES = ['VSCODE_', 'ALACRITTY_', 'WEZTERM_', 'GHOSTTY_', 'KONSOLE_'];
export function agentTerminalEnv(env, { appearance = 'dark', version = null } = {}) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (!INHERITED_TERMINAL.has(upper) && !INHERITED_PREFIXES.some(prefix => upper.startsWith(prefix))) next[key] = value;
  }
  return { ...next, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Journal', ...(version ? { TERM_PROGRAM_VERSION: String(version) } : {}),
    COLORFGBG: COLORFGBG[appearanceOf(appearance)] };
}

export class QueryResponder {
  constructor() { this.carry = ''; this.themeReports = false; }
  // Reads a chunk of PTY output and returns the bytes to write back to the PTY ('' for none).
  feed(data, { appearance = 'dark', attached = false } = {}) {
    // Most output has no escape at all.
    if (!this.carry && !data.includes('\x1b')) return '';
    const text = this.carry + data; let reply = ''; let consumed = 0;
    const colors = TERMINAL_COLORS[appearanceOf(appearance)];
    for (const match of text.matchAll(SEQUENCES)) {
      consumed = match.index + match[0].length;
      const [whole, code, slots, end, modes, set] = match;
      if (code) {
        // OSC 10;?;? asks for 10 and 11: each slot is the next colour. A sequence that also
        // sets a colour is left to the window's terminal, which applies it (and answers it).
        const parts = slots.split(';'); if (!parts.every(slot => slot === '?')) continue;
        parts.forEach((slot, index) => {
          const ident = Number(code) + index;
          if (slot === '?' && colors[ident]) reply += `\x1b]${ident};${xtermRgb(colors[ident])}${end}`;
        });
      } else if (modes) {
        if (modes.split(';').includes('2031')) this.themeReports = set === 'h';
      } else if (whole === '\x1b[?996n') reply += themeReport(appearance);
      else if (!attached) reply += DA1_REPLY;
    }
    // Only an unfinished sequence after the last one handled is kept, and only the last
    // CARRY_LIMIT characters are searched: a flood of unterminated openers stays linear.
    const from = Math.max(consumed, text.length - CARRY_LIMIT);
    const tail = INCOMPLETE.exec(text.slice(from));
    this.carry = tail ? tail[0] : '';
    return reply;
  }
}
