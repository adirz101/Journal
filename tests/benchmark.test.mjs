import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { JournalStore } from '../src/core/store.mjs';
import { aliasesFor } from '../src/core/retrieval.mjs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentsMarkdown, evaluate, materialize, parseTranscript, validateSuite, wilson } from '../scripts/benchmark.mjs';
import suite from '../benchmarks/ledger-round1/suite.mjs';
import { removeLater } from './support/cleanup.mjs';

const rows = (spec) => Object.entries(spec).flatMap(([key, passes]) => { const [condition, task] = key.split('/'); return passes.map((pass, i) => ({ condition, task, rep: i + 1, grade: { pass } })); });

test('suites are validated before anything runs', () => {
  assert.deepEqual(validateSuite(suite), []);
  assert.ok(validateSuite({ name: 'x', tasks: [{ id: 'Bad Id' }], repository: { kind: 'frozen', commit: 'abc' }, timeline: [] }).length >= 3);
});

test('Wilson intervals and GO/MODIFY/ABANDON follow the frozen criteria', () => {
  const ci = wilson(8, 10); assert.ok(ci.low > 0.45 && ci.high < 0.97);
  const tasks = [{ id: 'easy' }, { id: 'hard', differentiating: true }];
  const five = v => Array(5).fill(v);
  const base = { 'none/easy': five(true), 'agents/easy': five(true), 'memory/easy': five(true), 'journal/easy': five(true) };
  assert.equal(evaluate(rows({ ...base, 'none/hard': five(false), 'agents/hard': five(false), 'memory/hard': five(false), 'journal/hard': five(true) }), tasks).verdict, 'GO');
  assert.equal(evaluate(rows({ ...base, 'none/hard': five(true), 'agents/hard': five(true), 'memory/hard': five(true), 'journal/hard': five(true) }), tasks).verdict, 'MODIFY');
  assert.equal(evaluate(rows({ ...base, 'journal/easy': five(false), 'none/hard': five(true), 'agents/hard': five(true), 'memory/hard': five(true), 'journal/hard': five(false) }), tasks).verdict, 'ABANDON');
  const few = evaluate(rows({ 'none/hard': [true], 'agents/hard': [true], 'memory/hard': [true], 'journal/hard': [true], 'none/easy': [true], 'agents/easy': [true], 'memory/easy': [true], 'journal/easy': [true] }), tasks);
  assert.equal(few.verdict, 'MODIFY'); assert.match(few.reasons[0], /repetitions/);
  const costly = evaluate(rows({ ...base, 'none/hard': five(false), 'agents/hard': five(false), 'memory/hard': five(false), 'journal/hard': five(true) }), tasks, { journal: 5000, agents: 1000, memory: 1200 });
  assert.equal(costly.verdict, 'MODIFY', 'Excess maintenance blocks GO');
});

test('the round-1 suite materializes with knowledge recorded at the right point in history', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-')); t.after(() => removeLater(dir));
  const labels = [];
  const heads = await materialize(suite, join(dir, 'repo'), async (label, git) => { labels.push([label, git('rev-parse', '--abbrev-ref', 'HEAD')]); });
  assert.deepEqual(labels, [['main', 'main'], ['refunds', 'feature/refunds'], ['sqlite', 'experiment/sqlite']]);
  assert.deepEqual(Object.keys(heads).sort(), ['feature/refunds', 'main']);
  assert.ok(existsSync(join(dir, 'repo', 'src/storage/repo.mjs')), 'The refactor lands after the knowledge was recorded');
  const markdown = agentsMarkdown([{ kind: 'overview', statement: 'Purpose: x' }, { kind: 'claim', scope: 'checkout', statement: 'Rule A' }, { kind: 'status', branch: 'feature/refunds', statement: 'Next: y' }]);
  assert.match(markdown, /## Overview[\s\S]*Rule A[\s\S]*Current branch status \(feature\/refunds\)/);
});

test('transcript metrics read the result event and tool uses', () => {
  const text = [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Edit' }] } }),
    JSON.stringify({ type: 'result', is_error: false, num_turns: 3, total_cost_usd: 0.05, usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } })].join('\n');
  assert.deepEqual(parseTranscript(text), { isError: false, turns: 3, costUsd: 0.05, durationMs: null, inputTokens: 100, outputTokens: 5, toolCalls: 2, toolsBeforeEditTool: 1 });
  void readFileSync;
});

test('freezing covers the evaluated suite, including imported tasks and graders', async () => {
  const { suiteHash } = await import('../scripts/benchmark.mjs');
  const dir = fileURLToPath(new URL('../benchmarks/ledger-round1', import.meta.url));
  const before = suiteHash(dir, suite);
  const changed = { ...suite, tasks: suite.tasks.map((t, i) => i ? t : { ...t, grader: t.grader + '\n// edited' }) };
  assert.notEqual(suiteHash(dir, changed)['(evaluated suite)'], before['(evaluated suite)']);
});

// The typing preview must never cost more than the full check it stands in for.
// Medians of repeated runs on a 600-note project; logged, with no absolute bound.
test('previewSelection is no slower than prepareContext on a large project', t => {
  const dir = mkdtempSync(join(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'bench-preview-')); t.after(() => removeLater(dir));
  const repo = join(dir, 'repo'); mkdirSync(join(repo, 'src/payments'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  for (let i = 0; i < 20; i++) writeFileSync(join(repo, `src/payments/retry${i}.mjs`), `export const retries${i} = ${i};\n`.repeat(40));
  git('add', '.'); git('-c', 'user.name=a', '-c', 'user.email=a@a', 'commit', '-qm', 'init');
  const store = new JournalStore(join(dir, 'journal.sqlite')); t.after(() => store.close());
  const project = store.openProject(repo);
  const seeds = [store.proposeMemory(project.id, { statement: 'Payment retries use exponential backoff.', category: 'lesson', scope: 'checkout', area: '', source: { kind: 'file', path: 'src/payments/retry0.mjs', startLine: 1, endLine: 2 } }),
    store.proposeMemory(project.id, { statement: 'Refund webhooks verify signatures first.', category: 'decision', scope: 'checkout', area: '', source: { kind: 'user', note: 'Fixture' } })];
  // Copies of the two seeds with distinct statements, inserted as remembered notes.
  const insert = { memory: store.db.prepare("INSERT INTO memories(id,project_id,current_revision,status) VALUES(?,?,?,'active')"), revision: store.db.prepare('INSERT INTO revisions VALUES(?,?,1,?)'),
    fts: store.db.prepare('INSERT INTO memory_fts(revision_id,statement,aliases) VALUES(?,?,?)') };
  store.transaction(() => {
    for (const seed of seeds) store.db.prepare("UPDATE memories SET status='active' WHERE id=?").run(seed.id);
    for (let i = 0; i < 598; i++) {
      const seed = seeds[i % 2]; const file = `src/payments/retry${i % 20}.mjs`;
      const item = { ...seed, id: randomUUID(), revisionId: randomUUID(), statement: `${seed.statement} Case ${i} for payment retries in queue ${i % 37}.`,
        source: seed.source.kind === 'file' ? { ...seed.source, path: file } : seed.source };
      insert.memory.run(item.id, project.id, item.revisionId); insert.revision.run(item.revisionId, item.id, JSON.stringify(item)); insert.fts.run(item.revisionId, item.statement, aliasesFor(item));
    }
  });
  const task = 'Fix payment retries and refund webhooks';
  const median = run => { const times = []; for (let i = 0; i < 9; i++) { const start = process.hrtime.bigint(); run(); times.push(Number(process.hrtime.bigint() - start) / 1e6); } return times.sort((a, b) => a - b)[4]; };
  const full = () => store.prepareContext(project.id, task, { persist: false });
  const preview = () => store.previewSelection(project.id, task, { branch: 'main' });
  full(); preview();
  const fullMs = median(full); const previewMs = median(preview);
  t.diagnostic(`600 notes: prepareContext ${fullMs.toFixed(1)} ms, previewSelection ${previewMs.toFixed(1)} ms (medians of 9)`);
  assert.deepEqual(preview().items.map(item => item.id), full().items.map(item => item.id), 'the same notes, every source current');
  assert.ok(previewMs <= fullMs, `previewSelection ${previewMs} ms > prepareContext ${fullMs} ms`);
});
