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

test('states: primary hover keeps its text readable, selection survives hover and has a non-color cue', () => {
  const rule = selector => { const at = styles.indexOf(`${selector}{`); assert.ok(at >= 0, selector); return styles.slice(at + selector.length + 1, styles.indexOf('}', at)); };
  // A brightness filter dropped white text below 4.5:1 and gave the button its own compositing layer.
  assert.doesNotMatch(styles, /filter:brightness\(1/);
  assert.match(rule('button.primary:not(:disabled):hover'), /background:var\(--accbtn-hover\)/);
  const selectedHover = '.project-link.selected:not(:disabled):hover,.session-select.selected:not(:disabled):hover,.explorer-tools button[aria-pressed=true]:not(:disabled):hover,.segmented button[aria-pressed=true]:not(:disabled):hover';
  assert.match(rule(selectedHover), /background:var\(--sel-hover\)/);
  for (const selector of ['.project-link.selected', '.session-select.selected']) assert.match(rule(selector), /box-shadow:inset 2px 0 0 var\(--acc\)/, selector);
});

test('accent containers keep an accent border', () => {
  for (const selector of ['.memory-actions .approve', '.branch-badge', '.local-tag', '.receipt-meta>span', '.draft-basis', '.explorer-note', '.update-notice', '.reference-chips li', '.proposal-inbox']) {
    const at = styles.indexOf(`${selector}{`); assert.ok(at >= 0, selector);
    assert.match(styles.slice(at, styles.indexOf('}', at)), /border(?:-color)?:[^;}]*var\(--accline\)/, selector);
  }
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

test('inputs, text areas and selects use the stronger field border (WCAG 1.4.11)', () => {
  const at = styles.indexOf('input,textarea,select{color'); assert.ok(at >= 0);
  assert.match(styles.slice(at, styles.indexOf('}', at)), /border:1px solid var\(--line-field\)/);
});
