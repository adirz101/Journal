import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles useShellLayout.ts (React imports stubbed: only the pure exports are tested here;
// tests/desktop-layout.spec.ts and desktop-small-window.spec.ts drive the hook in Electron).
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'layout-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = readFileSync(new URL('../src/ui/useShellLayout.ts', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  writeFileSync(join(dir, 'layout.mjs'), outputText.replace(/^import .* from 'react';$/m, 'const useCallback = f => f, useEffect = () => {}, useRef = v => ({ current: v }), useState = v => [typeof v === "function" ? v() : v, () => {}];'));
  return import(pathToFileURL(join(dir, 'layout.mjs')).href);
}

test('layoutMode boundaries: exactly 1440 is wide, exactly 1180 is medium', async t => {
  const { layoutMode, WIDE_MIN, MEDIUM_MIN } = await load(t);
  assert.deepEqual([WIDE_MIN, MEDIUM_MIN], [1440, 1180]);
  assert.deepEqual([1600, 1440, 1439, 1180, 1179, 900].map(layoutMode), ['wide', 'wide', 'medium', 'medium', 'narrow', 'narrow']);
});

test('paneStates table', async t => {
  const { paneStates } = await load(t);
  const both = [false, true];
  for (const mode of ['wide', 'medium', 'narrow']) for (const sidebarCollapsed of both) for (const inspectorCollapsed of both) for (const sidebar of both) for (const inspector of both) {
    const prefs = { sidebarCollapsed, inspectorCollapsed }; const open = { sidebar, inspector };
    const panes = paneStates(mode, prefs, open, true); const label = JSON.stringify({ mode, prefs, open });
    assert.ok(!(panes.sidebar === 'overlay' && panes.inspector === 'overlay'), `at most one overlay: ${label}`);
    if (mode === 'wide') assert.deepEqual(panes, { sidebar: sidebarCollapsed ? 'rail' : 'full', inspector: inspectorCollapsed ? 'rail' : 'full' }, label);
    if (mode === 'medium') assert.deepEqual(panes, { sidebar: sidebarCollapsed ? 'rail' : 'full', inspector: inspector ? 'overlay' : 'rail' }, label);
    if (mode === 'narrow') {
      // Stored preferences do not matter in a narrow window.
      assert.deepEqual(panes, paneStates(mode, { sidebarCollapsed: !sidebarCollapsed, inspectorCollapsed: !inspectorCollapsed }, open, true), label);
      assert.equal(panes.inspector, inspector ? 'overlay' : 'rail', label);
      assert.equal(panes.sidebar, sidebar && !inspector ? 'overlay' : 'rail', label);
    }
    assert.equal(paneStates(mode, prefs, open, false).inspector, 'none', `no inspector without a project: ${label}`);
  }
});

test('automatic rails never write the stored preferences', async t => {
  const writes = []; const stored = { 'journal-sidebar-collapsed': '0', 'journal-panel-collapsed': '0' };
  globalThis.localStorage = { getItem: key => stored[key] ?? null, setItem: (key, value) => writes.push([key, value]), removeItem: key => writes.push([key, null]) };
  t.after(() => { delete globalThis.localStorage; });
  const { paneStates, layoutMode } = await load(t);
  for (const width of [1600, 1300, 1000, 1300, 1600]) paneStates(layoutMode(width), { sidebarCollapsed: false, inspectorCollapsed: false }, { sidebar: false, inspector: false }, true);
  assert.deepEqual(writes, []);
  // Resizing across the breakpoints in the real window writes nothing either: desktop-layout.spec.ts checks localStorage.
});
