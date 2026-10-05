import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Compiles the component with TypeScript (JSX only; it has no runtime imports) and renders it.
async function load(t) {
  const source = readFileSync(new URL('../src/ui/ProviderMark.tsx', import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'mark-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'ProviderMark.mjs'); writeFileSync(file, outputText);
  return (await import(pathToFileURL(file).href)).ProviderMark;
}

const SHA256 = { // of each path string; the files they come from are named in THIRD_PARTY_NOTICES.md
  claude: '0442033dcc3824e52ffb0a07849c46becbeeacd75d1287f9081c00510e3bbf84', codex: '3fae9b38d571a5ab5aa662bc279dcda580855d6ca6b35330e4b4ba171367ffb1', cursor: '85eaa79be69a55d712a4843bf8d65a217d0e5b648177c8e5f2ad67fe9a46d9ad',
};

test('provider marks are decorative inline SVG filled with currentColor, styled by a provider class', async t => {
  const ProviderMark = await load(t);
  const paths = new Set();
  for (const provider of ['claude', 'codex', 'cursor']) {
    const html = renderToStaticMarkup(createElement(ProviderMark, { provider, size: 20 }));
    assert.match(html, /^<span /); assert.match(html, new RegExp(`class="provider-mark ${provider}"`));
    assert.match(html, /aria-hidden="true"/); assert.match(html, /<svg [^>]*focusable="false"/); assert.match(html, /fill="currentColor"/);
    assert.match(html, /width:20px;height:20px/);
    const d = html.match(/ d="([^"]+)"/)[1]; paths.add(d);
    assert.equal(createHash('sha256').update(d).digest('hex'), SHA256[provider], `${provider}: path differs from the recorded Simple Icons file`);
  }
  assert.equal(paths.size, 3, 'Each provider has its own mark');
});
