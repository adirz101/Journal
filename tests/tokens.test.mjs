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

test('the terminal font stack is the --font-mono token', async () => {
  const { MONO_FONT } = await import('../src/ui/theme.ts');
  const tokens = readFileSync(new URL('../src/ui/tokens.css', import.meta.url), 'utf8');
  const stack = tokens.match(/--font-mono:([^;]+);/)[1];
  assert.equal(MONO_FONT.replace(/\s*,\s*/g, ','), stack.replace(/\s*,\s*/g, ','));
  assert.match(stack, /^"JetBrains Mono",/);
});
