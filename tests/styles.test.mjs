import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

// Static rules for the renderer's CSS (design board B8). Colors live in tokens.css only.
const UI = new URL('../src/ui/', import.meta.url);
const read = name => readFileSync(new URL(name, UI), 'utf8');
const styles = read('styles.css'); const tokens = read('tokens.css');
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/.*$/gm, '$1');

// Every style rule as { selectors, body, at }: selectors split on top-level commas and normalized
// (whitespace collapsed, none around combinators, attribute values unquoted), body without the
// braces, at the enclosing at-rule preludes. Assertions use this instead of exact source spelling.
const normalize = selector => selector.trim().replace(/\s+/g, ' ').replace(/\s*([>+~,])\s*/g, '$1').replace(/\[([\w-]+)=(["'])(.*?)\2\]/g, '[$1=$3]');
const splitList = list => { const parts = []; let depth = 0; let part = ''; for (const char of list) { if (char === '(' || char === '[') depth++; if (char === ')' || char === ']') depth--; if (char === ',' && depth === 0) { parts.push(part); part = ''; } else part += char; } return [...parts, part].map(normalize).filter(Boolean); };
const parseRules = css => {
  const rules = []; const at = [];
  for (const [, text, brace] of stripComments(css).matchAll(/([^{}]*)([{}])/g)) {
    if (brace === '}') { if (rules.at(-1)?.open) Object.assign(rules.at(-1), { body: text.trim(), open: false }); else at.pop(); continue; }
    const prelude = text.replace(/^[\s\S]*;/, '').trim(); // drop statements such as @import before it
    if (prelude.startsWith('@')) at.push(normalize(prelude));
    else rules.push({ selectors: splitList(prelude), body: '', at: [...at], open: true });
  }
  return rules.map(({ open, ...rule }) => rule);
};
const RULES = parseRules(styles);
const rulesFor = selector => RULES.filter(rule => rule.selectors.includes(normalize(selector)));
const declares = (rule, property, value) => rule.body.split(';').some(declaration => { const [name, ...rest] = declaration.split(':'); return name.trim() === property && (value === undefined || rest.join(':').trim().replace(/\s+/g, ' ') === value); });

test('colors come from tokens: no hex, rgb() or hsl() literal outside tokens.css', () => {
  // xterm takes literal colors; tokens.test.mjs checks that the ones mirroring tokens match them.
  const allowed = { 'theme.ts': new Set(['#0B0D10', '#E8EAEE', '#6AA5FF', '#21466A', '#30363F', '#8E97A6', '#2A2F37', '#F49A88', '#7DD39A', '#F2C46B', '#7FB2FF', '#BBA9FF', '#7FD8B8', '#B3BAC6', '#7C8594', '#ECEEF2',
    '#FAFAFB', '#14171C', '#195BCF', '#C8DCFA', '#CDD3DB', '#5E6776', '#AE321E', '#17713A', '#8A5300', '#1A5FD8', '#5B40C9', '#0F6B52', '#454D5A', '#6B7380']) };
  const files = readdirSync(UI, { recursive: true }).map(String).filter(name => /\.(css|[cm]?[jt]sx?)$/.test(name) && name !== 'tokens.css');
  assert.ok(files.includes('styles.css') && files.includes('App.tsx'), 'the scan sees the renderer sources');
  const found = [];
  for (const file of files) for (const [color] of stripComments(read(file)).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\(/g))
    if (!allowed[file]?.has(color)) found.push(`${file}: ${color}`);
  assert.deepEqual(found, []);
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
  const light = RULES.filter(rule => rule.selectors.some(selector => selector.includes('[data-theme=light]'))).map(rule => `${rule.selectors.join(',')}{${rule.body}}`);
  assert.deepEqual(light, [':root[data-theme=light] .welcome-wordmark{filter:none}', ':root[data-theme=light] .update-notice.compact{background:transparent}']);
});

test('states: primary hover keeps its text readable, selection survives hover and has a non-color cue', () => {
  const rule = selector => { const at = styles.indexOf(`${selector}{`); assert.ok(at >= 0, selector); return styles.slice(at + selector.length + 1, styles.indexOf('}', at)); };
  // A brightness filter dropped white text below 4.5:1 and gave the button its own compositing layer.
  assert.doesNotMatch(styles, /filter:brightness\(1/);
  assert.match(rule('button.primary:not(:disabled):hover'), /background:var\(--accbtn-hover\)/);
  const selectedHover = RULES.filter(rule => declares(rule, 'background', 'var(--sel-hover)')).flatMap(rule => rule.selectors);
  for (const selector of ['.project-link.selected:not(:disabled):hover', '.session-select.selected:not(:disabled):hover', '.explorer-tools button[aria-pressed=true]:not(:disabled):hover', '.segmented button[aria-pressed=true]:not(:disabled):hover'])
    assert.ok(selectedHover.includes(selector), `${selector} uses --sel-hover`);
  for (const selector of ['.project-link.selected', '.session-select.selected']) assert.ok(rulesFor(selector).some(rule => declares(rule, 'box-shadow', 'inset 2px 0 0 var(--acc)')), selector);
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
