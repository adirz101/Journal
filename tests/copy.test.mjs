import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { copy, excludedReason, memoryState, selectionReason, tip, warningText } from '../src/ui/copy.ts';

// Plain-language vocabulary (design board B8). The technical term may stay in a
// tooltip (the title attribute of an element) but not in visible text or names.
const OLD_TERMS = /\b(?:claims?|knowledge|receipts?|stale|approve[ds]?|proposals?|research|resume[ds]?|overviews?|branch updates?|orientation|briefs?|inbox|withdraw(?:n|s)?|packets?|constraints?)\b/i;
// Element attributes that are code, or a tooltip where the precise term is allowed.
const ELEMENT_CODE = new Set(['className', 'key', 'role', 'id', 'htmlFor', 'type', 'title', 'value', 'name', 'dir', 'src', 'data-testid', 'aria-controls', 'aria-labelledby', 'aria-haspopup', 'aria-orientation']);
// Component props that are code (other props, such as a dialog's title or note, are visible).
const COMPONENT_CODE = new Set(['key', 'side', 'provider', 'kind', 'id', 'className']);
// Calls whose string arguments are code: IPC actions, state values, storage keys, DOM queries.
// Object literals passed to these calls are not scanned at all (IPC payloads are code).
const CODE_CALLS = /^(?:api|setPanel|useState|useRef|getItem|setItem|addEventListener|removeEventListener|querySelector|includes|startsWith|has|get|set|CustomEvent|read)$/;
// Code values that look like old terms: [file, text, why]. Each must still be present.
const ALLOWED = [
  ['KnowledgeForm.tsx', 'brief', 'category code (stored data)'], ['KnowledgeForm.tsx', 'constraint', 'category code (stored data)'],
  ['KnowledgePanel.tsx', 'brief', 'category code passed to the note form'],
];
// Visible strings kept until a later phase of the UX redesign replaces them: [file, text, phase].
// Each must still be present, so an entry is removed when its phase lands.
const DEFERRED = [
  ['KnowledgePanel.tsx', 'Propose branch update', 'Phase 7'], ['KnowledgePanel.tsx', 'Propose overview', 'Phase 7'],
  ['App.tsx', 'Preview context ↗', 'Phase 4'], ['App.tsx', 'Initial task', 'Phase 4'],
  ['KnowledgeForm.tsx', 'Save for review', 'Phase 6'], ['App.tsx', 'Native session ID', 'Phase 6'],
];
const exempt = (file, text) => [...ALLOWED, ...DEFERRED].some(([f, t]) => f === file && t === text);

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
  const strings = files.flatMap(file => visibleStrings(file));
  const old = strings.filter(([, text, file]) => OLD_TERMS.test(text) && !exempt(file, text));
  assert.deepEqual(old.map(([at, text]) => `${at}: ${text}`), []);
  const missing = [...ALLOWED, ...DEFERRED].filter(([f, t]) => !strings.some(([, text, file]) => file === f && text === t));
  assert.deepEqual(missing, [], 'remove allow-list entries whose string is gone');
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
  assert.equal(selectionReason('matched docker, tests in src', 'src'), 'Matches docker, tests · in src');
  assert.equal(selectionReason('matched sign in, tests in src/sign in', 'src/sign in'), 'Matches sign in, tests · in src/sign in');
  assert.equal(selectionReason('matched sign in, tests'), 'Matches sign in, tests');
  assert.equal(selectionReason('matched sign in flow in src', 'src'), 'Matches sign in flow · in src');
  assert.equal(selectionReason('matched task terms in src', 'src'), 'Relevant to your task · in src');
  assert.equal(selectionReason('matched task terms'), 'Relevant to your task');
  assert.equal(selectionReason('matched'), 'Relevant to your task');
  assert.equal(selectionReason(undefined), 'Included');
  assert.equal(copy.onlyOn('main'), 'Only on main');
  // Forget pairs with Remember; the tooltip keeps the technical meaning.
  assert.equal(copy.forget, 'Forget…'); assert.match(tip.forget, /^Archive: agents stop receiving it/);
  assert.equal(memoryState({ status: 'archived', validation: 'current' }), 'Forgotten');
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

// Every string core produces for the renderer to map, read from core's source,
// so a new or reworded core string cannot silently bypass the mapping.
// A template's substitutions are sampled: literals in conditionals and
// fallbacks, and '1' for any other value.
function samples(node, inTemplate = false) {
  if (ts.isParenthesizedExpression(node)) return samples(node.expression, inTemplate);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isConditionalExpression(node)) return [...samples(node.whenTrue, inTemplate), ...samples(node.whenFalse, inTemplate)];
  if (ts.isBinaryExpression(node) && /^(?:\?\?|\|\|)$/.test(node.operatorToken.getText())) return [...samples(node.left, inTemplate), ...samples(node.right, inTemplate)];
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) { const values = samples(span.expression, true); out = out.flatMap(prefix => values.map(value => prefix + value + span.literal.text)); }
    return out;
  }
  return inTemplate ? ['1'] : [];
}
function coreStrings(file) {
  const source = ts.createSourceFile(file, readFileSync(new URL(`../src/core/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const found = { warnings: [], excluded: [], selection: [], validation: [] };
  const reasonOf = object => object.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'reason')?.initializer;
  const visit = node => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'push' && node.arguments[0]) {
      const target = node.expression.expression.getText(); const arg = node.arguments[0];
      if (target === 'warnings') found.warnings.push(...samples(arg));
      if (target === 'excluded' && ts.isObjectLiteralExpression(arg)) { const reason = reasonOf(arg); if (reason && ts.isIdentifier(reason)) found.excluded.push(`<${reason.text}>`); else if (reason) found.excluded.push(...samples(reason)); }
      if (target === 'matches' && ts.isObjectLiteralExpression(arg) && reasonOf(arg)) found.selection.push(...samples(reasonOf(arg)));
    }
    if (ts.isPropertyAssignment(node) && node.name.getText() === 'selection' && ts.isObjectLiteralExpression(node.initializer) && reasonOf(node.initializer)) found.selection.push(...samples(reasonOf(node.initializer)));
    if (ts.isMethodDeclaration(node) && node.name.getText() === 'validation') {
      const returns = n => { if (ts.isReturnStatement(n) && n.expression) found.validation.push(...samples(n.expression)); ts.forEachChild(n, returns); };
      returns(node.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('every warning and reason core can produce has a plain-language mapping', () => {
  const core = coreStrings('store.mjs');
  assert.ok(core.warnings.length >= 7 && core.selection.length >= 4 && core.validation.includes('stale'), 'the parse found core strings');
  for (const warning of core.warnings) assert.notEqual(warningText(warning), warning, `unmapped warning: ${warning}`);
  for (const warning of core.warnings) assert.doesNotMatch(warningText(warning), OLD_TERMS, warning);
  // A code taken from validation() is every non-current validation result.
  const codes = core.excluded.flatMap(code => code === '<validation>' ? core.validation.filter(v => v !== 'current') : [code]);
  assert.ok(codes.length >= 9 && !codes.some(code => code.startsWith('<')), `excluded codes: ${codes}`);
  for (const code of codes) assert.notEqual(excludedReason(code), code, `unmapped excluded code: ${code}`);
  for (const reason of core.selection) assert.notEqual(selectionReason(reason, '1'), reason, `unmapped selection reason: ${reason}`);
});

// Native dialogs in the desktop main process: every string in a dialog call,
// and in variables those calls interpolate (such as a list of counts).
function dialogStrings() {
  const source = ts.createSourceFile('main.mjs', readFileSync(new URL('../src/desktop/main.mjs', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const calls = []; const names = new Set(); const found = [];
  const findCalls = node => {
    if (ts.isCallExpression(node) && /^dialog\.show\w+$/.test(node.expression.getText())) calls.push(node);
    ts.forEachChild(node, findCalls);
  };
  findCalls(source);
  const collect = node => {
    if (ts.isIdentifier(node)) names.add(node.text);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) { if (node.text.trim()) found.push([`main.mjs:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, node.text.trim()]); }
    ts.forEachChild(node, collect);
  };
  for (const call of calls) call.arguments.forEach(collect);
  const declarations = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.has(node.name.text) && node.initializer) collect(node.initializer);
    ts.forEachChild(node, declarations);
  };
  declarations(source);
  return { calls: calls.length, found };
}

test('native dialogs use the plain vocabulary', () => {
  const { calls, found } = dialogStrings();
  assert.ok(calls >= 10 && found.some(([, text]) => text.startsWith('Your files will not be deleted')), 'the scan found the dialogs');
  assert.deepEqual(found.filter(([, text]) => OLD_TERMS.test(text)).map(([at, text]) => `${at}: ${text}`), []);
});
