import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeLater } from './support/cleanup.mjs';

// The Claude hook observer: PermissionRequest relies on the same tool fields as
// the tool events (tool_use_id, Bash command, file path), already redacted here.
const hook = fileURLToPath(new URL('../src/desktop/hook.mjs', import.meta.url));
function observe(t, payload) {
  const dir = mkdtempSync(resolve(process.env.JOURNAL_TEST_TMP ?? tmpdir(), 'hook-')); t.after(() => removeLater(dir));
  const target = join(dir, 'events.jsonl');
  const result = spawnSync(process.execPath, [hook, target, 'token-value'], { input: JSON.stringify({ session_id: 'native-1', cwd: dir, ...payload }),
    env: { ...process.env, JOURNAL_SESSION_ID: 'session-1' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return existsSync(target) ? readFileSync(target, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
}

test('PermissionRequest for Bash keeps command, tool id and redaction', t => {
  const [line] = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'API_KEY=abcd1234 rm -rf build' } });
  assert.equal(line.event, 'PermissionRequest'); assert.equal(line.id, 'session-1'); assert.equal(line.token, 'token-value');
  assert.equal(line.tool, 'Bash'); assert.equal(line.toolUseId, 't1');
  assert.equal(line.command, 'API_KEY=[redacted] rm -rf build');
  assert.ok(!JSON.stringify(line).includes('abcd1234'));
});

test('PermissionRequest for Write keeps filePath', t => {
  const [line] = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_use_id: 'w1', tool_input: { file_path: '/repo/src/a.mjs', content: 'secret body' } });
  assert.equal(line.filePath, '/repo/src/a.mjs'); assert.equal(line.toolUseId, 'w1');
  assert.ok(!JSON.stringify(line).includes('secret body'), 'File contents are never forwarded');
});

test('a payload without tool_input gives command \'\' and no filePath', t => {
  const [bash] = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  assert.equal(bash.command, ''); assert.equal(bash.toolUseId, null); assert.equal('filePath' in bash, false);
  const [write] = observe(t, { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
  assert.equal(write.filePath, ''); assert.equal('command' in write, false);
});
