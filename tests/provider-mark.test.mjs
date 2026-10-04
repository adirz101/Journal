import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

test('provider marks are decorative inline SVG in the provider color', async t => {
  const ProviderMark = await load(t);
  const paths = new Set();
  for (const provider of ['claude', 'codex', 'cursor']) {
    const html = renderToStaticMarkup(createElement(ProviderMark, { provider, size: 20 }));
    assert.match(html, new RegExp(`^<span class="provider-mark ${provider}" style="width:20px;height:20px" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" focusable="false"><path d="[Mm][^"]+" fill="currentColor"></path></svg></span>$`), provider);
    paths.add(html.match(/ d="([^"]+)"/)[1]);
  }
  assert.equal(paths.size, 3, 'Each provider has its own mark');
});
