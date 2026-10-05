// Native window background per theme. These repeat --bg from src/ui/tokens.css
// (tests/tokens.test.mjs keeps them equal), so the window never flashes the
// wrong color before the renderer paints.
export const WINDOW_BACKGROUND = { dark: '#0F1115', light: '#FFFFFF' };

// The colours of the page main shows after a renderer crash (crash-page.mjs), which cannot
// load the renderer's stylesheet. Each repeats a token of src/ui/tokens.css (tests/tokens.test.mjs
// keeps them equal): bg --bg, text --tx, body --tx2, button --accbtn, onButton --on-acc, ring --acc.
export const CRASH_COLORS = {
  dark: { bg: '#0F1115', text: '#E8EAEE', body: '#B3BAC6', button: '#2D6BE6', onButton: '#FFFFFF', ring: '#6AA5FF' },
  light: { bg: '#FFFFFF', text: '#14171C', body: '#454D5A', button: '#195BCF', onButton: '#FFFFFF', ring: '#195BCF' },
};
