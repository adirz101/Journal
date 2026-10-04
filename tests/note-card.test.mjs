import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

// Transpiles noteCardModel.ts with the renderer modules it imports into one
// temporary directory, so the test runs the renderer's own code.
async function load(t) {
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tmp', 'note-card-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ['types', 'copy', 'noteCardModel']) {
    const source = readFileSync(new URL(`../src/ui/${name}.ts`, import.meta.url), 'utf8');
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
    writeFileSync(join(dir, `${name}.mjs`), outputText.replace(/from '\.\/(types|copy)'/g, "from './$1.mjs'"));
  }
  return import(pathToFileURL(join(dir, 'noteCardModel.mjs')).href);
}

// The words tests/copy.test.mjs keeps out of visible text, plus "used": Journal sees delivery only.
const BANNED = /\b(?:used|claims?|knowledge|receipts?|stale|approve[ds]?|proposals?|research|resume[ds]?|overviews?|branch updates?|orientation|briefs?|inbox|withdraw(?:n|s)?|packets?|constraints?)\b/i;

// 4 October 2026, 10:00 local time: day boundaries are the user's midnight.
const NOW = new Date(2026, 9, 4, 10, 0).getTime();
const local = (day, hour = 9, month = 9) => new Date(2026, month, day, hour).toISOString();
const origin = (fields = {}) => ({ kind: 'manual', createdAt: local(1), approvedAt: local(4, 8), approvedRevision: 1, ...fields });
const session = (fields = {}) => ({ id: 's1', title: 'Fix the Docker tests', provider: 'claude', date: '2026-10-02', state: 'present', ...fields });
const note = (fields = {}) => ({ id: 'm1', projectId: 'p', revisionId: 'r1', revision: 1, statement: 'Integration tests need Docker', category: 'lesson', scope: 'checkout', area: '', branch: null,
  source: { kind: 'file', path: 'tests.md', startLine: 3, endLine: 5 }, status: 'active', validation: 'current', ...fields });

test('whenText: today, yesterday, days ago under a week, then a date', async t => {
  const { whenText, dateText } = await load(t);
  assert.equal(whenText(local(4, 0), NOW), 'today');
  assert.equal(whenText(local(4, 23), NOW), 'today', 'later today (another clock) is still today');
  assert.equal(whenText(local(3, 23), NOW), 'yesterday');
  assert.equal(whenText(local(3, 0), NOW), 'yesterday');
  assert.equal(whenText(local(28, 12, 8), NOW), '6 days ago');
  assert.equal(whenText(local(27, 12, 8), NOW), '27 Sept 2026'.replace('Sept', new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date(2026, 8, 1))), '7 days → a date');
  assert.equal(whenText(local(2), NOW), '2 days ago');
  assert.equal(whenText('not a date', NOW), '');
  assert.equal(dateText('2026-10-04'), '4 Oct 2026', 'a date-only value is a local day');
  assert.equal(dateText(null), '');
});

test('originLine: every kind, present, removed and purged sessions, active and not', async t => {
  const { originLine } = await load(t);
  const active = { status: 'active' }; const candidate = { status: 'candidate' };
  // Loading and unavailable render nothing.
  assert.equal(originLine(active, undefined, NOW), null);
  assert.equal(originLine(active, null, NOW), null);
  // Session, present: the title and provider, with the session to open.
  assert.deepEqual(originLine(active, origin({ kind: 'session', session: session() }), NOW), { text: "You remembered this today, from the session 'Fix the Docker tests' (Claude Code)", sessionId: 's1' });
  assert.deepEqual(originLine(candidate, origin({ kind: 'session', session: session({ provider: 'codex' }) }), NOW), { text: "From the session 'Fix the Docker tests' (Codex)", sessionId: 's1' });
  assert.equal(originLine(active, origin({ kind: 'session', approvedAt: local(2), session: session({ provider: 'cursor' }) }), NOW).text, "You remembered this 2 days ago, from the session 'Fix the Docker tests' (Cursor)");
  assert.equal(originLine(active, origin({ kind: 'session', approvedAt: local(1, 9, 8) }), NOW).text, 'You remembered this on 1 Sept 2026. From a removed session'.replace('Sept', new Intl.DateTimeFormat('en-GB', { month: 'short' }).format(new Date(2026, 8, 1))));
  // approvedAt unknown (approved before Phase 5 recorded it).
  assert.equal(originLine(active, origin({ kind: 'session', approvedAt: null, session: session() }), NOW).text, "You remembered this, from the session 'Fix the Docker tests' (Claude Code)");
  // A long title is shortened.
  assert.match(originLine(active, origin({ kind: 'session', session: session({ title: 'x'.repeat(200) }) }), NOW).text, /'x{59}…'/);
  // Removed and purged: one wording, never a title or a link.
  for (const state of ['removed', 'purged']) {
    const removed = origin({ kind: 'session', session: session({ id: null, title: null, state }) });
    assert.deepEqual(originLine(active, removed, NOW), { text: 'You remembered this today. From a removed session (Claude Code, 2 Oct 2026)', sessionId: null });
    assert.deepEqual(originLine(candidate, removed, NOW), { text: 'From a removed session (Claude Code, 2 Oct 2026)', sessionId: null });
    // An unknown provider leaves only the date.
    assert.equal(originLine(active, origin({ kind: 'session', session: session({ id: null, title: null, provider: null, state }) }), NOW).text, 'You remembered this today. From a removed session (2 Oct 2026)');
    assert.equal(originLine(candidate, origin({ kind: 'session', session: session({ id: null, title: null, provider: 'nope', state }) }), NOW).text, 'From a removed session (2 Oct 2026)');
  }
  // A removed session's title is withheld even if one were sent.
  assert.doesNotMatch(originLine(active, origin({ kind: 'session', session: session({ state: 'removed' }) }), NOW).text, /Docker/);
  // Manual, Git, import, promoted.
  assert.deepEqual(originLine(active, origin(), NOW), { text: 'You added this on 1 Oct 2026', sessionId: null });
  assert.equal(originLine(candidate, origin(), NOW).text, 'You added this on 1 Oct 2026');
  const git = origin({ kind: 'git', git: { base: 'abcdef0123456789', head: '0123456789abcdef' } });
  assert.equal(originLine(active, git, NOW).text, 'Drafted from Git (abcdef0..0123456), remembered by you');
  assert.equal(originLine(candidate, git, NOW).text, 'Drafted from Git (abcdef0..0123456)');
  assert.equal(originLine(active, origin({ kind: 'git', git: { base: null, head: '0123456789abcdef' } }), NOW).text, 'Drafted from Git (up to 0123456), remembered by you');
  assert.equal(originLine(active, origin({ kind: 'import' }), NOW).text, 'Imported on 1 Oct 2026, remembered by you');
  assert.equal(originLine({ status: 'archived' }, origin({ kind: 'import' }), NOW).text, 'Imported on 1 Oct 2026');
  assert.equal(originLine(active, origin({ kind: 'promoted', promotedFrom: { branch: 'feature/x' } }), NOW).text, 'Proposed for all branches from ⑂ feature/x, remembered by you');
  assert.equal(originLine({ status: 'rejected' }, origin({ kind: 'promoted', promotedFrom: { branch: 'feature/x' } }), NOW).text, 'Proposed for all branches from ⑂ feature/x');
});

test('evidenceLine: every validation, one line, a folder and the receipt suffix', async t => {
  const { evidenceLine } = await load(t);
  assert.deepEqual(evidenceLine(note()), { text: 'Based on tests.md:3–5 · file unchanged since you saved it', tone: 'quiet', title: 'tests.md:3–5' });
  assert.deepEqual(evidenceLine(note({ validation: 'stale' })), { text: 'Check needed · file changed', tone: 'amber', title: 'tests.md:3–5' });
  assert.equal(evidenceLine(note({ validation: 'wrong-branch', scope: 'branch', branch: 'feature/x' })).text, 'Based on tests.md:3–5 · only on ⑂ feature/x');
  assert.equal(evidenceLine(note({ validation: 'folder-removed' }), 'docs').text, 'Based on docs/tests.md:3–5 · its folder was removed from the project');
  assert.equal(evidenceLine(note({ source: { kind: 'file', path: 'a.md', startLine: 7, endLine: 7 } })).text, 'Based on a.md:7 · file unchanged since you saved it');
  assert.equal(evidenceLine(note(), 'api').text, 'Based on api/tests.md:3–5 · file unchanged since you saved it');
  // A delivered snapshot says what was checked when it was sent, whatever the file says now.
  assert.equal(evidenceLine(note({ validation: 'stale' }), undefined, 'receipt').text, 'Based on tests.md:3–5 · checked when the session started');
  // Git and statements have no evidence line.
  assert.equal(evidenceLine(note({ source: { kind: 'git', base: null, head: 'abc' } })), null);
  assert.equal(evidenceLine(note({ source: { kind: 'user', note: 'because' } })), null);
});

test('sentLine counts conversations and never says used', async t => {
  const { sentLine } = await load(t);
  assert.equal(sentLine(undefined), null); assert.equal(sentLine(null), null);
  assert.equal(sentLine(0), 'Not sent yet');
  assert.equal(sentLine(1), 'Sent to 1 session');
  assert.equal(sentLine(2), 'Sent to 2 sessions');
});

test('category chips keep their order and labels', async t => {
  const { CATEGORY_ORDER, chipLabel } = await load(t);
  assert.deepEqual(CATEGORY_ORDER, ['all', 'brief', 'decision', 'constraint', 'lesson', 'convention', 'issue']);
  assert.deepEqual(CATEGORY_ORDER.map(chipLabel), ['All', 'Project and branch', 'Decisions', 'Rules', 'Lessons', 'Conventions', 'Known issues']);
});

test('no line uses a banned word', async t => {
  const { originLine, evidenceLine, sentLine, chipLabel, CATEGORY_ORDER } = await load(t);
  const lines = [];
  for (const status of ['active', 'candidate', 'archived']) {
    for (const value of [origin(), origin({ kind: 'import' }), origin({ kind: 'git', git: { base: 'a', head: 'b' } }), origin({ kind: 'promoted', promotedFrom: { branch: 'x' } }),
      ...['present', 'removed', 'purged'].map(state => origin({ kind: 'session', session: session({ state }) }))]) lines.push(originLine({ status }, value, NOW).text);
  }
  for (const validation of ['current', 'stale', 'wrong-branch', 'folder-removed']) lines.push(evidenceLine(note({ validation })).text, evidenceLine(note({ validation }), 'x', 'receipt').text);
  lines.push(...[0, 1, 5].map(sentLine), ...CATEGORY_ORDER.map(chipLabel));
  assert.equal(lines.length, 39);
  assert.deepEqual(lines.filter(line => BANNED.test(line)), []);
});

test('a newer check marks a current note out of date, but not a delivered snapshot', async t => {
  const { shownNote, stateClass } = await load(t);
  assert.equal(shownNote(note(), true, 'memory').validation, 'stale');
  assert.equal(shownNote(note(), true, 'receipt').validation, 'current');
  assert.equal(shownNote(note(), false, 'memory').validation, 'current');
  assert.equal(stateClass(note({ validation: 'stale' })), 'stale');
  assert.equal(stateClass(note({ validation: 'wrong-branch' })), 'other');
  assert.equal(stateClass(note({ status: 'candidate' })), 'candidate');
});

test('the Session tab shows a delivered snapshot as a receipt and a preview as a preview', async t => {
  const { receiptVariant } = await load(t);
  assert.equal(receiptVariant('prepared'), 'preview');
  for (const state of ['submitted', 'uncertain', 'failed']) assert.equal(receiptVariant(state), 'receipt');
});
