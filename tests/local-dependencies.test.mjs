import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'journal-dependencies-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: '4.6.5' } }));
  writeFileSync(join(root, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/zod': { version: '4.6.5' } } }));
  const check = () => spawnSync(process.execPath, [resolve('scripts/check-local-dependencies.mjs')], { cwd: root, env: {}, encoding: 'utf8' });
  const install = version => { mkdirSync(join(root, 'node_modules/zod'), { recursive: true }); writeFileSync(join(root, 'node_modules/zod/package.json'), JSON.stringify({ version })); };
  return { root, check, install };
}
test('local startup refuses a missing dependency with an actionable install command', t => {
  const f = fixture(t), result = f.check();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /zod/);
  assert.match(result.stderr, /npm ci/);
});
test('local startup catches an older installed dependency after switching branches', t => {
  const f = fixture(t); f.install('3.0.0');
  assert.match(f.check().stderr, /zod.*npm ci/s);
  f.install('4.6.5');
  assert.equal(f.check().status, 0, 'the same checkout works once its dependencies match');
});
