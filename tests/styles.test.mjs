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
