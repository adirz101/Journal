import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { terminalThemes } from '../src/ui/theme.ts';
import { TERMINAL_COLORS } from '../src/core/terminal-queries.mjs';
import { CRASH_COLORS, WINDOW_BACKGROUND } from '../src/desktop/window-colors.mjs';
import { crashPageHtml } from '../src/desktop/crash-page.mjs';

// Token values per theme, read from src/ui/tokens.css (comments stripped).
const css = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
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

const SYNTAX = ['keyword', 'string', 'comment', 'number', 'type', 'property', 'inserted', 'deleted', 'invalid'].map(name => `syn-${name}`);
const GIT = ['modified', 'added', 'deleted', 'renamed', 'conflict', 'submodule', 'ignored'].map(name => `git-${name}`);
const TEXT = ['tx', 'tx2', 'tx3', 'acc', 'amb', 'grn', 'red', 'claude', 'sensitive', ...GIT, ...SYNTAX];
const SURFACES = ['bg', 'side', 'panel', 'raised', 'field', 'hover', 'sel', 'term'];
const TINTS = { acc: 'accsoft', amb: 'ambsoft', grn: 'grnsoft', red: 'redsoft', claude: 'claude-soft' };

for (const [name, t] of Object.entries(themes)) {
  test(`${name} theme: text and surface tokens are opaque, and no syntax or Git token is missing from the contrast set`, () => {
    for (const token of [...TEXT, ...SURFACES, 'accbtn', 'on-acc']) assert.match(t[token] ?? '', /^#[0-9a-f]{6}$/i, `--${token} must be an opaque #RRGGBB`);
    const colored = Object.keys(t).filter(token => /^(syn|git)-/.test(token));
    assert.deepEqual(colored.filter(token => !TEXT.includes(token)), [], 'Every syntax and Git color is text and must be tested');
  });

  test(`${name} theme: every text token is at least 4.5:1 on every surface and on its own tint`, () => {
    const solid = token => mix(t[token], rgba(t.bg).slice(0, 3));
    const low = [];
    for (const text of TEXT) for (const surface of SURFACES) {
      const ratio = contrast(solid(text), solid(surface));
      if (ratio < 4.5) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
    for (const [text, tint] of Object.entries(TINTS)) for (const surface of SURFACES) {
      const ratio = contrast(solid(text), mix(t[tint], solid(surface)));
      if (ratio < 4.5) low.push(`${text} on ${tint} over ${surface}: ${ratio.toFixed(2)}`);
    }
    assert.ok(contrast(solid('on-acc'), solid('accbtn')) >= 4.5, 'Text on the primary button');
    assert.deepEqual(low, []);
  });

  // State surfaces are not text, so WCAG sets no ratio for them. These minimums keep a state
  // visible against what it replaces: hover against the surfaces controls sit on (1.1:1), and the
  // hovered selection against the selection (1.05:1; text on it must stay at 4.5:1, which leaves
  // no more room, and the accent bar on selected rows carries the selection by itself).
  test(`${name} theme: hover, selection and primary-button states are distinguishable and keep text readable`, () => {
    const solid = token => mix(t[token], rgba(t.bg).slice(0, 3));
    for (const token of ['hover', 'sel-hover', 'accbtn-hover']) assert.match(t[token] ?? '', /^#[0-9a-f]{6}$/i, `--${token} must be an opaque #RRGGBB`);
    const low = [];
    for (const surface of ['raised', 'side', 'panel']) {
      const ratio = contrast(solid('hover'), solid(surface));
      if (ratio < 1.1) low.push(`hover against ${surface}: ${ratio.toFixed(2)}`);
    }
    const selection = contrast(solid('sel-hover'), solid('sel'));
    if (selection < 1.05) low.push(`sel-hover against sel: ${selection.toFixed(2)}`);
    // Text that sits on selected rows and pressed toggles.
    for (const text of ['tx', 'tx2', 'tx3', 'acc', 'amb', 'grn', 'red']) {
      const ratio = contrast(solid(text), solid('sel-hover'));
      if (ratio < 4.5) low.push(`${text} on sel-hover: ${ratio.toFixed(2)}`);
    }
    // The approve button: an accent tint that hovers to a stronger accent tint on the card and panels.
    for (const surface of ['raised', 'side', 'panel']) {
      const base = solid(surface); const hovered = mix(t['accsoft-hover'], base);
      const ratio = contrast(hovered, mix(t.accsoft, base));
      if (ratio < 1.1) low.push(`accsoft-hover against accsoft over ${surface}: ${ratio.toFixed(2)}`);
      const text = contrast(solid('tx'), hovered);
      if (text < 4.5) low.push(`tx on accsoft-hover over ${surface}: ${text.toFixed(2)}`);
    }
    const button = contrast(solid('on-acc'), solid('accbtn-hover'));
    if (button < 4.5) low.push(`on-acc on accbtn-hover: ${button.toFixed(2)}`);
    const press = contrast(solid('accbtn'), solid('accbtn-hover'));
    if (press < 1.1) low.push(`accbtn-hover against accbtn: ${press.toFixed(2)}`);
    assert.deepEqual(low, []);
  });

  // Highlights in the file preview are exempt from 4.5:1 (see tokens.css): code text and every
  // syntax color stay at 3:1 on them, and matches stay apart from each other and the editor.
  test(`${name} theme: code text stays at 3:1 on selection and search highlights`, () => {
    const solid = token => mix(t[token], rgba(t.bg).slice(0, 3));
    const low = [];
    for (const surface of ['code-selection', 'code-match', 'code-match-current']) for (const text of ['tx', ...SYNTAX]) {
      const ratio = contrast(solid(text), solid(surface));
      if (ratio < 3) low.push(`${text} on ${surface}: ${ratio.toFixed(2)}`);
    }
    for (const [a, b] of [['code-match-current', 'code-match'], ['code-match', 'field']]) {
      const ratio = contrast(solid(a), solid(b));
      if (ratio < 1.2) low.push(`${a} against ${b}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(low, []);
  });

  // WCAG 1.4.11: a provider mark is a non-text graphic next to the provider's name. The neutral tile
  // is the opaque --hover, so --tx on it is one fixed ratio; the Claude tile is the translucent
  // --claude-soft, which composites over whatever surface the mark sits on (including selected rows),
  // so --claude is checked per surface. Both are at least 3:1.
  test(`${name} theme: provider marks are at least 3:1 on their tile on every surface they sit on`, () => {
    const base = rgba(t.bg).slice(0, 3); const solid = token => mix(t[token], base);
    assert.equal(rgba(t.hover)[3], 1, 'The neutral mark tile (--hover) is opaque');
    // An attention row composites --ambsoft over the sidebar.
    const surfaceColor = surface => surface === 'ambsoft-over-side' ? mix(t.ambsoft, solid('side')) : solid(surface);
    const low = [];
    for (const surface of [...SURFACES, 'sel-hover', 'ambsoft-over-side']) {
      const tile = surfaceColor(surface);
      const ratio = contrast(solid('tx'), solid('hover')); if (ratio < 3) low.push(`tx on the mark tile: ${ratio.toFixed(2)}`);
      const claude = contrast(solid('claude'), mix(t['claude-soft'], tile)); if (claude < 3) low.push(`claude on its tile over ${surface}: ${claude.toFixed(2)}`);
    }
    assert.deepEqual(low, []);
  });

  // WCAG 1.4.11: a rail tile's state dot is a graphic that carries the state (its name says it too).
  test(`${name} theme: state dots are at least 3:1 on the rail`, () => {
    const base = rgba(t.bg).slice(0, 3); const solid = token => mix(t[token], base);
    const surfaces = { side: solid('side'), sel: solid('sel'), 'ambsoft over side': mix(t.ambsoft, solid('side')) };
    const low = [];
    for (const dot of ['amb', 'grn', 'red', 'tx3']) for (const [surface, color] of Object.entries(surfaces)) {
      const ratio = contrast(solid(dot), color); if (ratio < 3) low.push(`${dot} on ${surface}: ${ratio.toFixed(2)}`);
    }
    assert.deepEqual(low, []);
  });

  // WCAG 1.4.11: the boundary of an input is at least 3:1 against what it sits on and against its fill.
  // --line2 (about 1.4 to 1.6:1) stays for decorative dividers and panel borders.
  test(`${name} theme: the input border token is at least 3:1 on every surface an input sits on`, () => {
    assert.match(t['line-field'] ?? '', /^#[0-9a-f]{6}$/i, '--line-field must be an opaque #RRGGBB');
    const low = ['field', 'bg', 'side', 'panel', 'raised'].map(surface => [surface, contrast(mix(t['line-field'], rgba(t.bg).slice(0, 3)), mix(t[surface], rgba(t.bg).slice(0, 3)))]).filter(([, ratio]) => ratio < 3);
    assert.deepEqual(low, []);
  });

  // Scrollbar thumbs: subtle but findable at rest (1.6:1 on every surface a scroll area has),
  // and clearly stronger when hovered or dragged (--tx3, 2.5:1 against the resting thumb).
  test(`${name} theme: the scrollbar thumb is findable at rest and darker when used`, () => {
    assert.match(t['scroll-thumb'] ?? '', /^#[0-9a-f]{6}$/i, '--scroll-thumb must be an opaque #RRGGBB');
    const solid = token => mix(t[token], rgba(t.bg).slice(0, 3));
    const low = SURFACES.filter(surface => !['hover', 'sel'].includes(surface)).map(surface => [surface, contrast(solid('scroll-thumb'), solid(surface))]).filter(([, ratio]) => ratio < 1.6).map(([surface, ratio]) => `scroll-thumb on ${surface}: ${ratio.toFixed(2)}`);
    const used = contrast(solid('tx3'), solid('scroll-thumb'));
    if (used < 2.5) low.push(`tx3 against scroll-thumb: ${used.toFixed(2)}`);
    assert.deepEqual(low, []);
  });

  test(`${name} theme: a translucent tint or line is its base color with alpha`, () => {
    const bases = { accsoft: 'acc', 'accsoft-hover': 'acc', accline: 'acc', ambsoft: 'amb', ambline: 'amb', grnsoft: 'grn', redsoft: 'red', redline: 'red', 'claude-soft': 'claude' };
    for (const [tint, base] of Object.entries(bases)) {
      assert.ok(t[tint], `--${tint} is defined`);
      const [r, g, b, a] = rgba(t[tint]);
      if (a < 1) assert.deepEqual([r, g, b], rgba(t[base]).slice(0, 3), `--${tint} uses the RGB of --${base}`);
    }
  });

  test(`${name} theme: the terminal uses the same colors as the tokens`, () => {
    const terminal = terminalThemes[name];
    const mirrored = [['background', 'term'], ['foreground', 'tx'], ['cursor', 'acc'], ['cursorAccent', 'term'], ['selectionBackground', 'code-selection'],
      ['scrollbarSliderBackground', 'scroll-thumb'], ['scrollbarSliderHoverBackground', 'tx3'], ['scrollbarSliderActiveBackground', 'tx3']];
    if (name === 'light') mirrored.push(['selectionForeground', 'tx']);
    for (const [key, token] of mirrored) assert.equal(terminal[key]?.toUpperCase(), t[token].toUpperCase(), `${key} = --${token}`);
  });

  test(`${name} theme: the runtime answers colour queries with the terminal's colours`, () => {
    const terminal = terminalThemes[name];
    assert.deepEqual(TERMINAL_COLORS[name], { 10: terminal.foreground, 11: terminal.background, 12: terminal.cursor });
  });

  test(`${name} theme: the window background is the --bg token`, () => {
    assert.equal(WINDOW_BACKGROUND[name].toUpperCase(), t.bg.toUpperCase());
  });

  // Phase 9: the page main shows after a renderer crash cannot load tokens.css; its colours repeat the tokens.
  test(`${name} theme: the crash page uses the tokens' colours`, () => {
    const mirrored = { bg: 'bg', text: 'tx', body: 'tx2', button: 'accbtn', onButton: 'on-acc', ring: 'acc' };
    for (const [key, token] of Object.entries(mirrored)) assert.equal(CRASH_COLORS[name][key].toUpperCase(), t[token].toUpperCase(), `${key} = --${token}`);
    assert.deepEqual(Object.keys(CRASH_COLORS[name]).sort(), Object.keys(mirrored).sort());
    const html = crashPageHtml(name);
    for (const colour of Object.values(CRASH_COLORS[name])) assert.ok(html.includes(colour), colour);
    assert.match(html, new RegExp(`color-scheme:${name}`));
  });
}

test('the terminal font stack is the --font-mono token', async () => {
  const { MONO_FONT } = await import('../src/ui/theme.ts');
  const tokens = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
  const found = [...tokens.matchAll(/--font-mono:([^;]+);/g)];
  assert.equal(found.length, 1, '--font-mono is defined exactly once (a per-theme override would be ignored here)');
  const stack = found[0][1];
  assert.equal(MONO_FONT.replace(/\s*,\s*/g, ','), stack.replace(/\s*,\s*/g, ','));
  assert.match(stack, /^"JetBrains Mono",/);
});

test('a terminal opened before the bundled font loads switches to it once it has loaded', async () => {
  const { MONO_FONT, MONO_FALLBACK, monoFontFamily } = await import('../src/ui/theme.ts');
  assert.equal(MONO_FONT, `"JetBrains Mono", ${MONO_FALLBACK}`);
  const fakeFonts = loaded => Object.assign(new EventTarget(), { loaded, check(font) { assert.match(font, /^(?:400|600) 13px "JetBrains Mono"$/); return this.loaded.has(font.split(' ')[0]); } });
  // Already loaded: the full stack at once, nothing to watch.
  let calls = 0; const ready = fakeFonts(new Set(['400', '600']));
  const now = monoFontFamily(ready, () => calls++);
  assert.equal(now.family, MONO_FONT); ready.dispatchEvent(new Event('loadingdone')); assert.equal(calls, 0); now.stop();
  // Late: the fallback first, then one switch after both weights have loaded.
  const late = fakeFonts(new Set()); const watched = monoFontFamily(late, () => calls++);
  assert.equal(watched.family, MONO_FALLBACK);
  late.loaded.add('400'); late.dispatchEvent(new Event('loadingdone')); assert.equal(calls, 0, 'waits for the bold weight too');
  late.loaded.add('600'); late.dispatchEvent(new Event('loadingdone')); late.dispatchEvent(new Event('loadingdone')); assert.equal(calls, 1);
  // Unmounted before the font loads: no switch afterwards.
  const gone = fakeFonts(new Set()); monoFontFamily(gone, () => calls++).stop();
  gone.loaded.add('400'); gone.loaded.add('600'); gone.dispatchEvent(new Event('loadingdone')); assert.equal(calls, 1);
});

test('fonts: italic faces are bundled and ligatures are off for the terminal and the editor', () => {
  const fonts = readFileSync(new URL('../src/ui/fonts.css', import.meta.url), 'utf8');
  for (const weight of [400, 600]) for (const subset of ['latin', 'latin-ext']) assert.ok(fonts.includes(`jetbrains-mono-${subset}-${weight}-italic.woff2`), `${subset} ${weight} italic`);
  assert.equal([...fonts.matchAll(/font-style:italic/g)].length, 4, 'four italic faces');
  const main = readFileSync(new URL('../src/ui/main.tsx', import.meta.url), 'utf8');
  for (const font of ['italic 400 13px', 'italic 600 13px']) assert.ok(main.includes(`'${font}'`), `${font} is preloaded`);
  // Parse the rules rather than matching one spelling: some rule whose selector list covers both .xterm and .cm-scroller turns ligatures off.
  const styles = readFileSync(new URL('../src/ui/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...styles.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selectors: selector.split(',').map(part => part.trim()), body }));
  assert.ok(rules.some(rule => rule.selectors.includes('.xterm') && rule.selectors.includes('.cm-scroller') && /font-variant-ligatures\s*:\s*none/.test(rule.body)));
});
