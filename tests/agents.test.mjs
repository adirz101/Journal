import { test } from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/core/agents.mjs').catch(() => ({}));
const id = 'f1b5cc71-364f-4136-bbc7-20acf06f1435';

test('agent launch builder exists', () => assert.equal(typeof module.buildAgentLaunch, 'function'));
test('Claude preassigns a fresh UUID and passes prompts as literal argv', () => {
  const prompt = 'Check $(touch /tmp/no) `echo nope` "quote"\n\u05e2\u05d1\u05e8\u05d9\u05ea';
  const launch = module.buildAgentLaunch({ provider: 'claude', nativeId: id, prompt });
  assert.equal(launch.executable, 'claude');
  assert.deepEqual(launch.argv, ['--session-id', id, '--', prompt]);
});
test('targeted resume never falls back to the latest conversation', () => {
  assert.deepEqual(module.buildAgentLaunch({ provider: 'claude', nativeId: id, resume: true }).argv, ['--resume', id]);
  assert.deepEqual(module.buildAgentLaunch({ provider: 'codex', nativeId: id, resume: true }).argv, ['resume', id]);
  for (const provider of ['claude', 'codex']) {
    assert.throws(() => module.buildAgentLaunch({ provider, resume: true }), /session ID/);
    assert.throws(() => module.buildAgentLaunch({ provider, nativeId: 'id;bad', resume: true }), /session ID/);
  }
});
test('Codex literal prompt uses -- and native permissions are untouched', () => {
  const launch = module.buildAgentLaunch({ provider: 'codex', prompt: '--help; echo unsafe' });
  assert.deepEqual(launch.argv, ['--', '--help; echo unsafe']);
  assert.ok(!JSON.stringify(launch).includes('bypass'));
  assert.throws(() => module.buildAgentLaunch({ provider: 'other' }), /provider/);
});
test('Codex capture accepts only the explicit native resume banner, marked unconfirmed', () => {
  assert.equal(module.captureCodexId(`Random UUID ${id}`), null);
  assert.equal(module.captureCodexId(`To continue this session, run codex resume ${id}`), id);
});
test('Codex captures the current multiline native resume banner with terminal styling', () => {
  assert.equal(module.captureCodexId(`To continue this session, run:\r\n  \x1b[32mcodex resume ${id}\x1b[0m\r\nOr run codex resume and select the session.`), id);
});
test('Codex rejects an invalid latest banner instead of suggesting an older native ID', () => {
  assert.equal(module.captureCodexId(`To continue this session, run codex resume ${id}\nTo continue this session, run:\n  codex resume not-a-uuid\n`), null);
  assert.equal(module.captureCodexId(`Example command: codex resume ${id}`), null);
});
test('unknown native session IDs cannot be used to construct a Claude launch', () => {
  assert.throws(() => module.buildAgentLaunch({ provider: 'claude', nativeId: 'not-a-uuid' }), /session ID/);
});
