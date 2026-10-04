import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { composer, copy, excludedReason, memoryState, selectionReason, shell, tip, warningText, wrapUp } from '../src/ui/copy.ts';

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
// Code values that look like old terms: [file, text, position, why]. The position
// (see where()) keeps the same word elsewhere in the file visible to the scan.
// Each entry must still be present.
const ALLOWED = [
  ['KnowledgeForm.tsx', 'brief', 'array element', 'category codes offered as select option values'],
  ['KnowledgeForm.tsx', 'constraint', 'array element', 'category codes offered as select option values'],
  ['KnowledgeForm.tsx', 'constraint', 'operand of ??', 'default category code for a new note'],
  ['KnowledgeForm.tsx', 'brief', 'conditional value', 'category code of a reviewed draft'],
  ['KnowledgePanel.tsx', 'brief', 'property initialCategory', 'category code passed to the note form'],
];
// Visible strings kept until a later phase of the UX redesign replaces them: [file, text, phase].
// Each must still be present, so an entry is removed when its phase lands.
const DEFERRED = [
  ['KnowledgePanel.tsx', 'Propose branch update', 'Phase 7'], ['KnowledgePanel.tsx', 'Propose overview', 'Phase 7'],
  ['KnowledgeForm.tsx', 'Save for review', 'Phase 6'],
];
const exempt = ([, text, file, position]) => ALLOWED.some(([f, t, p]) => f === file && t === text && p === position) || DEFERRED.some(([f, t]) => f === file && t === text);
// The syntactic position of a string, so an allow-list entry names one use.
function where(node) {
  const parent = node.parent;
  if (ts.isPropertyAssignment(parent)) return `property ${parent.name.getText()}`;
  if (ts.isArrayLiteralExpression(parent)) return 'array element';
  if (ts.isBinaryExpression(parent)) return `operand of ${parent.operatorToken.getText()}`;
  if (ts.isJsxAttribute(parent)) return `attribute ${parent.name.getText()}`;
  if (ts.isConditionalExpression(parent)) return 'conditional value';
  return ts.isJsxText(node) ? 'JSX text' : ts.SyntaxKind[parent.kind];
}

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
    if (text) found.push([`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`, text, file, where(node)]);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

test('components use the plain vocabulary in visible text', () => {
  const files = readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => name.endsWith('.tsx'));
  const strings = files.flatMap(file => visibleStrings(file));
  const old = strings.filter(entry => OLD_TERMS.test(entry[1]) && !exempt(entry));
  assert.deepEqual(old.map(([at, text]) => `${at}: ${text}`), []);
  const missing = [...ALLOWED.filter(([f, t, p]) => !strings.some(([, text, file, position]) => file === f && text === t && position === p)),
    ...DEFERRED.filter(([f, t]) => !strings.some(([, text, file]) => file === f && text === t))];
  assert.deepEqual(missing, [], 'remove allow-list entries whose string is gone');
});

test('the scanner reads case bodies and skips only the case label', () => {
  const probe = "function f(kind) { switch (kind) { case 'stale': return 'Shown text'; default: return 'Fallback'; } }";
  assert.deepEqual(visibleStrings('probe.tsx', probe).map(([, text]) => text), ['Shown text', 'Fallback']);
});

test('an allowed code value does not exempt the same word shown elsewhere in the file', () => {
  const probe = "export const F = () => { const [c] = useLocal(x ?? 'constraint'); return <p title={c}>constraint</p>; };";
  const strings = visibleStrings('KnowledgeForm.tsx', probe);
  assert.deepEqual(strings.map(([, text, , position]) => [text, position]), [['constraint', 'operand of ??'], ['constraint', 'JSX text']]);
  assert.deepEqual(strings.filter(entry => !exempt(entry)).map(([, text, , position]) => [text, position]), [['constraint', 'JSX text']]);
});

// Shell strings that use a listed word in its everyday sense: [key, why].
const SHELL_ALLOWED = [['neverApproves', 'tool approval in the CLI, not note review: "Journal never approves for you."']];
// Every shell string, functions called with sample arguments (a count and a size, or a name).
const shellStrings = () => Object.entries(shell).flatMap(([key, value]) => typeof value === 'function'
  ? (value.length === 2 ? [[key, value(2, '1.9 KB')]] : [[key, value(1)], [key, value(2)], [key, value('Codex')]]) : [[key, value]]);
const CAPS_RUN = /\b[A-Z]{2,}\s+[A-Z]{2,}\b/;

test('the vocabulary itself avoids the old terms, except in tooltips', () => {
  for (const [key, value] of Object.entries(copy)) if (typeof value === 'string') assert.doesNotMatch(value, OLD_TERMS, key);
  // The composer's strings, nested help and functions called with sample arguments.
  const samples = { checkoutLine: ['Journal', 'main', 'abc1234'], start: ['Claude Code'], installed: ['2.1.0'], noPlan: ['Codex'], agentMissing: ['Codex'],
    notesMatch: [2], notesMatching: ['retry'], leaveOutTip: [true], previewFailed: ['the task looks like a credential'],
    matchesTerms: [['retries', 'payment']], notIncludedChip: [2, 'out of date'], currentCheckout: ['main'], existingWorktree: ['main'], folder: ['docs'] };
  const values = Object.entries(composer).flatMap(([key, value]) => typeof value === 'function' ? [[key, value(...(samples[key] ?? []))]]
    : typeof value === 'object' ? Object.entries(value).map(([inner, text]) => [`${key}.${inner}`, text]) : [[key, value]]);
  assert.ok(Object.entries(composer).filter(([, value]) => typeof value === 'function').every(([key]) => key in samples), 'every function has sample arguments');
  for (const [key, value] of values) { assert.equal(typeof value, 'string', key); assert.doesNotMatch(value, OLD_TERMS, key); }
  assert.equal(composer.installed(null), 'Installed'); assert.equal(composer.notesMatch(1), '1 note matches'); assert.equal(composer.leaveOutTip(false), 'Tip: press Delete on a note to leave it out of this session only.');
  const strings = shellStrings();
  assert.ok(strings.length > 60 && strings.some(([key, text]) => key === 'activityHiddenBody' && text.startsWith('Codex ')), 'the shell strings were read');
  for (const [key, text] of strings) {
    assert.equal(typeof text, 'string', key);
    if (!SHELL_ALLOWED.some(([allowed]) => allowed === key)) assert.doesNotMatch(text, OLD_TERMS, key);
    assert.doesNotMatch(text, CAPS_RUN, key);
  }
  assert.deepEqual(SHELL_ALLOWED.filter(([key]) => !(key in shell)), [], 'remove allow-list entries whose key is gone');
});

// Eyebrows and region names read as sentence case (Phase 1 review): no
// uppercase eyebrow, and no run of all-caps words in an accessible name or a
// component's title (such as a reference list's region name). Abbreviations
// may stand alone.
const ABBREVIATIONS = new Set(['KB', 'ID', 'PID', 'UUID', 'CLI', 'PATH', 'HEAD', 'URL']);
function caseIssues(file, code = readFileSync(new URL(`../src/ui/${file}`, import.meta.url), 'utf8')) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = []; let eyebrows = 0; let names = 0;
  const at = node => `${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  // Literal text of an attribute value or of JSX children, template parts included.
  const texts = node => {
    const out = []; const visit = n => {
      if (ts.isJsxText(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) { if (n.text.trim()) out.push(n.text.trim()); }
      if (ts.isJsxElement(n) && n !== node) return; // nested elements are checked on their own
      ts.forEachChild(n, visit);
    };
    visit(node); return out;
  };
  const visit = node => {
    if (ts.isJsxElement(node)) {
      const className = node.openingElement.attributes.properties.find(a => ts.isJsxAttribute(a) && a.name.getText() === 'className');
      if (className?.initializer && ts.isStringLiteral(className.initializer) && className.initializer.text.split(/\s+/).includes('eyebrow')) {
        eyebrows++;
        for (const text of texts(node)) if (text.split(/[^A-Za-z]+/).some(word => word.length > 1 && word === word.toUpperCase() && !ABBREVIATIONS.has(word))) found.push(`${at(node)}: eyebrow ${text}`);
      }
    }
    if (ts.isJsxAttribute(node) && node.initializer) {
      const tag = node.parent.parent.tagName.getText(); const name = node.name.getText();
      if (name === 'aria-label' || (name === 'title' && /^[A-Z]/.test(tag))) {
        names++;
        for (const text of texts(node.initializer)) if (CAPS_RUN.test(text)) found.push(`${at(node)}: ${name} ${text}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { found, eyebrows, names };
}

test('eyebrows are sentence case', () => {
  const files = readdirSync(new URL('../src/ui/', import.meta.url)).filter(name => name.endsWith('.tsx'));
  const results = files.map(file => caseIssues(file));
  // Floors only prove the scan sees the sources (the Phase 3 shell dropped several decorative eyebrows).
  assert.ok(results.reduce((n, r) => n + r.eyebrows, 0) >= 10 && results.reduce((n, r) => n + r.names, 0) >= 40, 'the scan found eyebrows and names');
  assert.deepEqual(results.flatMap(r => r.found), []);
  // The scanner itself: uppercase eyebrows, caps runs in names and component titles fail; abbreviations pass.
  const probe = caseIssues('probe.tsx', `const A = () => <><span className="eyebrow">COMMANDS</span><span className="eyebrow">Timeline · {n} KB</span>
    <section aria-label="WHAT IT DID" /><References title={\`REFERENCED FOR THIS TASK · \${n}\`} /><p aria-label="Session ID" title="NOT A NAME" /></>;`);
  assert.deepEqual(probe.found.map(entry => entry.replace(/^probe\.tsx:\d+: /, '')), ['eyebrow COMMANDS', 'aria-label WHAT IT DID', 'title REFERENCED FOR THIS TASK ·']);
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
  assert.match(copy.leaveOut, /^Leave out /, 'the action and its result share one verb');
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

// Errors from core and the desktop main process can reach the app's error
// banner, so they use the plain vocabulary too. Internal invariant errors
// (programming errors or tampered input, never reached by normal use) are
// listed with their reason: [file, text, why].
const INTERNAL_ERRORS = [
  ['core/store.mjs', 'Invalid disabled claims', 'malformed IPC input; the renderer sends note IDs it got from core'],
  ['core/store.mjs', 'Unknown receipt', 'the renderer asks only for receipt IDs core listed'],
  ['core/store.mjs', 'Receipt delivery is already recorded', 'runtime invariant: delivery is recorded once by the runtime'],
  ['core/store.mjs', 'Unknown proposal', 'the renderer acts only on suggestion IDs core listed'],
];
function errorStrings(dir) {
  return readdirSync(new URL(`../src/${dir}/`, import.meta.url)).filter(name => name.endsWith('.mjs')).flatMap(file => {
    const source = ts.createSourceFile(file, readFileSync(new URL(`../src/${dir}/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const found = [];
    const collect = node => {
      if (ts.isBinaryExpression(node) && /^(?:===|!==)$/.test(node.operatorToken.getText())) return; // a compared value is code
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) { if (node.text.trim()) found.push([`${dir}/${file}`, node.text.trim(), source.getLineAndCharacterOfPosition(node.getStart()).line + 1]); }
      ts.forEachChild(node, collect);
    };
    const visit = node => {
      if (ts.isNewExpression(node) && node.expression.getText() === 'Error' && node.arguments?.[0]) collect(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  });
}

test('errors from core and the desktop main process use the plain vocabulary', () => {
  const errors = [...errorStrings('core'), ...errorStrings('desktop')];
  assert.ok(errors.length > 100 && errors.some(([, text]) => text === 'A note needs a source'), 'the scan found the errors');
  const old = errors.filter(([file, text]) => OLD_TERMS.test(text) && !INTERNAL_ERRORS.some(([f, t]) => f === file && t === text));
  assert.deepEqual(old.map(([file, text, line]) => `${file}:${line}: ${text}`), []);
  const missing = INTERNAL_ERRORS.filter(([f, t]) => !errors.some(([file, text]) => file === f && text === t));
  assert.deepEqual(missing, [], 'remove allow-list entries whose error is gone');
});

test('the wrap-up vocabulary avoids the old terms', () => {
  const samples = { exited: [0, '18m'], stopped: ['11m'], endedBy: ['SIGTERM', '3m'], alreadyChanged: [2], testsHidden: ['Codex'], passed: [3], failed: [1],
    rememberAll: [3], branchUnreachable: ['feature/x'], staleHead: ['process.mjs', 1], whatChanged: ['process.mjs:41'], renamedTo: ['b.js'], ended: [2],
    unknown: [1], rangeLabel: ['First'], checkFailed: ['The file changed again; check it once more.'],
    moreSuggestions: [2], moreSuggestionsLabel: [2], source: ['src/a.js:3–5'], editOnBranch: ['feature/x'], finishOnBranch: ['feature/x'] };
  const values = Object.entries(wrapUp).flatMap(([key, value]) => typeof value === 'function' ? [[key, value(...(samples[key] ?? []))]]
    : typeof value === 'object' ? Object.entries(value).map(([inner, text]) => [`${key}.${inner}`, text]) : [[key, value]]);
  assert.ok(Object.entries(wrapUp).filter(([, value]) => typeof value === 'function').every(([key]) => key in samples), 'every function has sample arguments');
  for (const [key, value] of values) { assert.equal(typeof value, 'string', key); assert.doesNotMatch(value, OLD_TERMS, key); assert.doesNotMatch(value, CAPS_RUN, key); }
  assert.equal(wrapUp.exited(0, '18m'), 'Exited 0 after 18m');
  assert.equal(wrapUp.staleHead('process.mjs', 1), 'This session changed process.mjs. 1 note is based on it.');
  assert.equal(wrapUp.ended(1), 'Session ended. 1 suggestion.');
  assert.equal(wrapUp.moreSuggestions(2), 'More suggestions from this session');
  assert.equal(wrapUp.moreSuggestionsLabel(1), '1 more suggestion from this session');
  assert.doesNotMatch(wrapUp.notSavedFailed, /was not saved|no longer available/, 'a failed start does not claim it had output');
});
