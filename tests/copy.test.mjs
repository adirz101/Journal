import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { copy, excludedReason, selectionReason, warningText } from '../src/ui/copy.ts';

// Plain-language vocabulary (design board B8). The technical term may stay in a
// tooltip (the title attribute of an element) but not in visible text or names.
const OLD_TERMS = /\b(?:claims?|knowledge|receipts?|stale|approve[ds]?|proposals?|research|resume[ds]?)\b/i;
// Element attributes that are code, or a tooltip where the precise term is allowed.
const ELEMENT_CODE = new Set(['className', 'key', 'role', 'id', 'htmlFor', 'type', 'title', 'value', 'name', 'dir', 'src', 'data-testid', 'aria-controls', 'aria-labelledby', 'aria-haspopup', 'aria-orientation']);
// Component props that are code (other props, such as a dialog's title or note, are visible).
const COMPONENT_CODE = new Set(['key', 'side', 'provider', 'kind', 'id', 'className']);
// Calls whose string arguments are code: IPC actions, state values, storage keys, DOM queries.
const CODE_CALLS = /^(?:api|setPanel|useState|useRef|getItem|setItem|addEventListener|removeEventListener|querySelector|includes|startsWith|has|get|set|CustomEvent|read)$/;
// Internal identifiers that look like old terms: [file, text, why].
const ALLOWED = [['ResizableWorkspace.tsx', 'knowledge', 'side id, stored in journal-panel-widths']];

// Every string a user can see or hear: JSX text and string or template literals,
// except code positions (types, imports, comparisons, object keys, code attributes and calls).
function visibleStrings(file, code = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isTypeNode(node) || ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) return;
    // A case label is a compared value (code); its statements can be visible.
    if (ts.isCaseClause(node)) { for (const statement of node.statements) visit(statement); return; }
    if (ts.isBinaryExpression(node) && /^(?:===|!==|in)$/.test(node.operatorToken.getText())) return;
    if (ts.isPropertyAssignment(node)) { if (node.name.getText() !== 'id') visit(node.initializer); return; }
    if (ts.isElementAccessExpression(node)) { visit(node.expression); return; }
    if (ts.isJsxAttribute(node)) {
      const element = /^[a-z]/.test(node.parent.parent.tagName.getText());
      if ((element ? ELEMENT_CODE : COMPONENT_CODE).has(node.name.getText())) return;
    }
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && CODE_CALLS.test(node.expression.getText().split('.').pop())) {
      visit(node.expression); for (const arg of node.arguments ?? []) if (!ts.isStringLiteralLike(arg) && !ts.isObjectLiteralExpression(arg)) visit(arg);
      return;
    }
    const text = ts.isJsxText(node) || ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) ? node.text.trim() : '';
    if (text) found.push([`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text, file]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('components use the plain vocabulary in visible text', () => {
  const files = readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => name.endsWith('.tsx'));
  const old = files.flatMap(file => visibleStrings(file)).filter(([, text, file]) => OLD_TERMS.test(text) && !ALLOWED.some(([f, t]) => f === file && t === text));
  assert.deepEqual(old.map(([at, text]) => `${at}: ${text}`), []);
});

test('the scanner reads case bodies and skips only the case label', () => {
  const probe = "function f(kind) { switch (kind) { case 'stale': return 'Shown text'; default: return 'Fallback'; } }";
  assert.deepEqual(visibleStrings('probe.tsx', probe).map(([, text]) => text), ['Shown text', 'Fallback']);
});

test('the vocabulary itself avoids the old terms, except in tooltips', () => {
  for (const [key, value] of Object.entries(copy)) if (typeof value === 'string') assert.doesNotMatch(value, OLD_TERMS, key);
});

test('core reasons and warnings are shown in the plain vocabulary; packet text is not touched', () => {
  assert.equal(selectionReason('repo overview'), 'About this project');
  assert.equal(selectionReason('branch update'), 'Where this branch stands');
  assert.equal(selectionReason('pinned'), 'Pinned');
  assert.equal(selectionReason('referenced area src/core'), 'In src/core, which you referenced');
  assert.equal(selectionReason('matched docker, tests in src'), 'Matches docker, tests · in src');
  assert.equal(selectionReason('matched task terms'), 'Relevant to your task');
  assert.equal(selectionReason('matched'), 'Relevant to your task');
  assert.equal(selectionReason(undefined), 'Included');
  assert.equal(copy.onlyOn('main'), 'Only on main');
  assert.equal(copy.onlyOn(null), 'Only on this branch');
  assert.equal(excludedReason('stale'), 'out of date');
  assert.equal(excludedReason('left-out-for-task'), 'left out by you');
  assert.equal(excludedReason('something-new'), 'something-new');
  assert.equal(warningText('Claims 1234abcd r2 and 5678ef90 r1 may conflict. Review them in Knowledge.'), 'Notes 1234abcd (revision 2) and 5678ef90 (revision 1) may conflict. Check them in Memory.');
  assert.equal(warningText('An unknown warning.'), 'An unknown warning.');
  for (const text of ['Project brief search inspected 100 entries. Retire superseded briefs to include others.', 'Search inspected 1000 matches. Refine the task or retire stale knowledge to search further.',
    'The current branch update is 3 commits behind HEAD. Propose a status update to review recent progress.', 'Only four current project brief entries fit the orientation limit. Consolidate superseded briefs.',
    'A project brief was excluded by the context budget. Shorten or consolidate the reviewed summaries.', 'No current approved project brief is included. Add a checkout-scoped brief to orient every session.'])
    assert.doesNotMatch(warningText(text), OLD_TERMS, text);
});
