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
  const allowed = { 'theme.ts': new Set(['#0B0D10', '#E8EAEE', '#6AA5FF', '#21466A', '#3A414B', '#8E97A6', '#2A2F37', '#F49A88', '#7DD39A', '#F2C46B', '#7FB2FF', '#BBA9FF', '#7FD8B8', '#B3BAC6', '#7C8594', '#ECEEF2',
    '#FAFAFB', '#14171C', '#195BCF', '#C8DCFA', '#B4BBC6', '#5E6776', '#AE321E', '#17713A', '#8A5300', '#1A5FD8', '#5B40C9', '#0F6B52', '#454D5A', '#6B7380']) };
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
  // A brightness filter dropped white text below 4.5:1 and gave the button its own compositing layer.
  assert.doesNotMatch(styles, /filter:brightness\(1/);
  assert.ok(rulesFor('button.primary:not(:disabled):hover').some(rule => declares(rule, 'background', 'var(--accbtn-hover)')));
  const selectedHover = RULES.filter(rule => declares(rule, 'background', 'var(--sel-hover)')).flatMap(rule => rule.selectors);
  for (const selector of ['.session-select.selected:not(:disabled):hover', '.rail-tile[aria-current=true]:not(:disabled):hover', '.explorer-tools button[aria-pressed=true]:not(:disabled):hover', '.segmented button[aria-pressed=true]:not(:disabled):hover'])
    assert.ok(selectedHover.includes(selector), `${selector} uses --sel-hover`);
  // The generic button hover (0,2,1) would replace the approve button's accent tint with grey.
  assert.ok(rulesFor('.memory-actions .approve:not(:disabled):hover').some(rule => declares(rule, 'background', 'var(--accsoft-hover)') && rule.at.some(at => /hover:hover/.test(at) && /pointer:fine/.test(at))), 'approve keeps an accent hover');
  // Selected rows carry an accent bar as a ::before, not a box-shadow, so focus styles and the
  // rounded corners never fight it; it is out of flow and inside the row.
  // Session rows mark the selection with .selected, rail tiles with aria-current.
  for (const [host, selected] of [['.session-select', '.session-select.selected'], ['.rail-tile', '.rail-tile[aria-current=true]']]) {
    assert.ok(rulesFor(host).some(rule => declares(rule, 'position', 'relative')), `${host} positions its bar`);
    assert.ok(!rulesFor(selected).some(rule => declares(rule, 'box-shadow')), `${selected} has no box-shadow`);
    const bar = rulesFor(`${selected}::before`).filter(rule => rule.at.length === 0);
    for (const [property, value] of [['content', '""'], ['position', 'absolute'], ['inset-block', '6px'], ['left', '0'], ['width', '2px'], ['border-radius', '1px'], ['background', 'var(--acc)']])
      assert.ok(bar.some(rule => declares(rule, property, value)), `${selected}::before ${property}:${value}`);
    // Forced colors replace backgrounds with Canvas; the bar opts out and uses the system highlight.
    assert.ok(rulesFor(`${selected}::before`).some(rule => rule.at.some(at => /forced-colors:\s*active/.test(at)) && declares(rule, 'forced-color-adjust', 'none') && declares(rule, 'background', 'Highlight')), `${host} bar in forced colors`);
  }
});

test('row states: attention rows are amber and never take the selection fill; rail tiles select like rows', () => {
  const attention = rulesFor('.session-select.attention').filter(rule => rule.at.length === 0);
  assert.ok(attention.some(rule => declares(rule, 'background', 'var(--ambsoft)') && declares(rule, 'border-color', 'var(--ambline)')), '.session-select.attention');
  assert.ok(!attention.some(rule => /var\(--sel/.test(rule.body)), '.session-select.attention never uses --sel');
  // An attention row that is also selected stays amber (the accent bar marks the selection), on hover too.
  assert.ok(rulesFor('.session-select.attention.selected').some(rule => declares(rule, 'background', 'var(--ambsoft)')));
  assert.ok(rulesFor('.session-select.attention.selected:not(:disabled):hover').some(rule => declares(rule, 'background', 'var(--ambsoft)') && rule.at.some(at => /pointer:fine/.test(at))));
  assert.ok(rulesFor('.rail-tile[aria-current=true]').some(rule => rule.at.length === 0 && declares(rule, 'background', 'var(--sel)')), '.rail-tile[aria-current=true]');
  assert.ok(rulesFor('.rail-tile.attention').some(rule => declares(rule, 'background', 'var(--ambsoft)')), '.rail-tile.attention');
  assert.ok(rulesFor('.tree-row.selected:hover').some(rule => declares(rule, 'background', 'var(--sel-hover)') && rule.at.some(at => /pointer:fine/.test(at))), '.tree-row.selected:hover');
});

test('borderless tab and link buttons hover by color, not with the generic background patch', () => {
  // These have no border, no horizontal padding or a zero radius, so a --hover patch looks like a stray block.
  const family = ['.text-button', '.source-button', '.filter-tabs button:not([aria-pressed=true])', '.error-banner button', '.archived-toggle', '.reference-chips li button'];
  for (const selector of family) assert.ok(rulesFor(`${selector}:not(:disabled):hover`).some(rule => declares(rule, 'background', 'transparent') && declares(rule, 'color', 'var(--tx)') && rule.at.some(at => /pointer:fine/.test(at))), selector);
  // The pressed filter tab keeps its accent text and gets no patch either.
  const pressed = '.filter-tabs button[aria-pressed=true]:not(:disabled):hover';
  assert.ok(rulesFor(pressed).some(rule => declares(rule, 'background', 'transparent') && !declares(rule, 'color') && rule.at.some(at => /pointer:fine/.test(at))), pressed);
});

test('accent badges share one fill', () => {
  for (const selector of ['.branch-badge', '.count-badge']) assert.ok(rulesFor(selector).some(rule => rule.at.length === 0 && declares(rule, 'background', 'var(--accsoft)')), selector);
});

test('focus rings inside scroll and clipping containers are drawn where they cannot be clipped', () => {
  const has = (selector, property, value) => assert.ok(rulesFor(selector).some(rule => declares(rule, property, value)), `${selector} ${property}:${value}`);
  // Panel tabs fill a 60 px scroll strip: the ring goes on the label, like the hover patch.
  has('.panel-tabs button:focus-visible', 'outline', 'none');
  has('.panel-tabs button:focus-visible .panel-tab-label', 'outline', '2px solid var(--acc)');
  has('.panel-tabs .panel-collapse:focus-visible', 'outline-offset', '-2px');
  // Full-width rows in scrolling lists and the sticky search field draw the ring inside their border edge.
  for (const selector of ['.session-select:focus-visible', '.archived-toggle:focus-visible', '.changed-row:focus-visible', '.tree-search:focus-visible', '.tree-row:focus-visible']) has(selector, 'outline-offset', '-2px');
  // File tree rows use the shared 2 px outline, not a box-shadow ring that forced colors would drop.
  has('.tree-row:focus-visible', 'outline', '2px solid var(--acc)');
  assert.ok(!rulesFor('.tree-row:focus-visible').some(rule => declares(rule, 'box-shadow')), '.tree-row:focus-visible has no box-shadow');
  // The segmented control rounds its end buttons instead of clipping them.
  assert.ok(!rulesFor('.segmented').some(rule => declares(rule, 'overflow')), '.segmented does not clip');
  has('.segmented button:first-child', 'border-radius', '5px 0 0 5px');
  has('.segmented button:last-child', 'border-radius', '0 5px 5px 0');
});

test('accent containers keep an accent border', () => {
  for (const selector of ['.memory-actions .approve', '.branch-badge', '.count-badge', '.receipt-meta>span', '.draft-basis', '.explorer-note', '.update-notice', '.reference-chips li', '.proposal-inbox']) {
    assert.ok(rulesFor(selector).some(rule => /(?:^|;)\s*border(?:-color)?\s*:[^;]*var\(--accline\)/.test(rule.body)), selector);
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

test('scrollbar thumbs use their token and darken on hover and while dragged', () => {
  assert.ok(rulesFor('::-webkit-scrollbar-thumb').some(rule => declares(rule, 'background', 'var(--scroll-thumb)')));
  const used = RULES.filter(rule => declares(rule, 'background', 'var(--tx3)')).flatMap(rule => rule.selectors);
  for (const selector of ['::-webkit-scrollbar-thumb:hover', '::-webkit-scrollbar-thumb:active']) assert.ok(used.includes(selector), selector);
});

test('inputs, text areas and selects use the stronger field border (WCAG 1.4.11)', () => {
  for (const selector of ['input', 'textarea', 'select']) assert.ok(rulesFor(selector).some(rule => declares(rule, 'border', '1px solid var(--line-field)')), selector);
});

test('Phase 5 notes: Check needed is amber everywhere, never animated; note hovers are pointer-gated', () => {
  // A changed source asks the user to look (decision 4): the chip, the evidence line and the toggle share amber.
  assert.ok(rulesFor('.memory-state.stale').some(rule => declares(rule, 'background', 'var(--ambsoft)') && declares(rule, 'color', 'var(--amb)')), '.memory-state.stale');
  assert.ok(!RULES.some(rule => rule.selectors.includes('.memory-state.stale') && /var\(--red/.test(rule.body)), '.memory-state.stale is no longer red');
  assert.ok(rulesFor('.note-line.note-evidence.amber').some(rule => declares(rule, 'color', 'var(--amb)') && declares(rule, 'background', 'var(--ambsoft)')), 'evidence line');
  assert.ok(rulesFor('.filter-tabs .attention-toggle.amber').some(rule => declares(rule, 'color', 'var(--amb)')), 'Check needed toggle');
  // Pressed chips use the accent tint; pressed toggles add an underline, a cue that is not color.
  assert.ok(rulesFor('.category-chips button[aria-pressed=true]').some(rule => declares(rule, 'background', 'var(--accsoft)') && declares(rule, 'border-color', 'var(--accline)')));
  assert.ok(rulesFor('.filter-tabs .attention-toggle[aria-pressed=true]').some(rule => declares(rule, 'text-decoration', 'underline')));
  // No motion on cards, chips or toggles: they change with typing, scans and terminal events.
  const own = RULES.filter(rule => rule.selectors.some(selector => /\.(?:note-|category-chips|attention-toggle|memory-search)/.test(selector)));
  assert.ok(own.length >= 15, 'the Phase 5 rules were found');
  assert.deepEqual(own.filter(rule => /(?:^|;)\s*(?:transition|animation)/.test(rule.body)).map(rule => rule.selectors.join(',')), []);
  for (const selector of ['.category-chips button:not([aria-pressed=true]):not(:disabled):hover', '.category-chips button[aria-pressed=true]:not(:disabled):hover', '.note-origin button.link:not(:disabled):hover'])
    assert.ok(rulesFor(selector).some(rule => rule.at.some(at => /hover:hover/.test(at) && /pointer:fine/.test(at))), selector);
});

test('Phase 5 notes: only compact cards keep one line; pressed chips stay visible in forced colors', () => {
  // A preview card (the Session tab before a start) wraps its statement; compact (hover by default) keeps one line.
  const oneLine = RULES.filter(rule => declares(rule, 'white-space', 'nowrap') && rule.selectors.some(selector => selector.startsWith('.note-card')));
  assert.ok(oneLine.some(rule => rule.selectors.includes('.note-card.compact>.note-statement')), 'compact statement is one line');
  assert.deepEqual(oneLine.flatMap(rule => rule.selectors).filter(selector => /\.(?:preview|hover|memory|receipt)\b/.test(selector)), []);
  // Forced colors drop the accent tint: a pressed chip keeps a Highlight border and an outline.
  const forced = rulesFor('.category-chips button[aria-pressed=true]').filter(rule => rule.at.some(at => /forced-colors:\s*active/.test(at)));
  assert.ok(forced.some(rule => declares(rule, 'border-color', 'Highlight') && declares(rule, 'outline', '1px solid Highlight')), 'pressed chip in forced colors');
  assert.ok(rulesFor('.category-chips button[aria-pressed=true]:focus-visible').some(rule => rule.at.some(at => /forced-colors/.test(at)) && declares(rule, 'outline', '3px solid Highlight')), 'focus stays distinct from pressed');
});

test('Phase 4 composer: selection, focus and the underline mirror survive forced colors', () => {
  const forced = selector => rulesFor(selector).filter(rule => rule.at.some(at => /forced-colors:\s*active/.test(at)));
  for (const selector of ['.agent-option[aria-checked=true]', '.mode-switch button[aria-checked=true]']) {
    assert.ok(forced(selector).some(rule => declares(rule, 'outline', '2px solid Highlight')), `${selector} selected in forced colors`);
    assert.ok(forced(`${selector}:focus-visible`).some(rule => declares(rule, 'outline', '3px solid Highlight')), `${selector} focus stays distinct from selected`);
  }
  assert.ok(forced('.task-field textarea.task-input:focus-visible').some(rule => declares(rule, 'outline', '2px solid Highlight')), 'task box focus');
  assert.ok(forced('.task-mirror').some(rule => declares(rule, 'forced-color-adjust', 'none') && declares(rule, 'color', 'transparent')), 'mirror text stays transparent');
  assert.ok(forced('.task-mirror mark').some(rule => declares(rule, 'text-decoration-color', 'Highlight')), 'underline in a system color');
});

test('Phase 4 composer: empty live regions collapse without leaving the accessibility tree', () => {
  for (const selector of ['.start-reason:empty', '.preview-error:empty']) {
    assert.ok(rulesFor(selector).length > 0, selector);
    assert.ok(!rulesFor(selector).some(rule => declares(rule, 'display', 'none') || declares(rule, 'visibility', 'hidden')), `${selector} stays in the tree`);
    assert.ok(rulesFor(selector).some(rule => declares(rule, 'position', 'absolute') && declares(rule, 'width', '1px')), `${selector} collapses`);
  }
});
