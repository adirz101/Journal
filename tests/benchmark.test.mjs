import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentsMarkdown, evaluate, materialize, parseTranscript, validateSuite, wilson } from '../scripts/benchmark.mjs';
import suite from '../benchmarks/ledger-round1/suite.mjs';

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
  const dir = mkdtempSync(join(tmpdir(), 'bench-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
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
