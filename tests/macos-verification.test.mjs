import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeLater } from './support/cleanup.mjs';
import { verificationEnvironment } from '../src/runtime/verification.mjs';
const { MacVerificationExecutor } = await import('../src/runtime/macos-verification.mjs').catch(() => ({}));

test('macOS verification permits a fixture test but denies outside files, symlink escapes, children and network', { skip: process.platform !== 'darwin' }, async t => {
  assert.equal(typeof MacVerificationExecutor, 'function');
  const root = mkdtempSync(join(tmpdir(), 'journal-sandbox-')); t.after(() => removeLater(root));
  const cwd = join(root, 'result'); mkdirSync(cwd); const secret = join(root, 'outside'); writeFileSync(secret, 'fixture-only-canary');
  symlinkSync(secret, join(cwd, 'link'));
  writeFileSync(join(cwd, 'test.cjs'), `const fs=require('fs'),cp=require('child_process'),net=require('net');
const assert=require('assert/strict');
for(const path of [${JSON.stringify(secret)},'link']) { assert.throws(()=>fs.readFileSync(path),e=>['EPERM','EACCES'].includes(e.code)); assert.throws(()=>fs.writeFileSync(path,'changed'),e=>['EPERM','EACCES'].includes(e.code)); }
assert.notEqual(cp.spawnSync('/bin/cat',[${JSON.stringify(secret)}]).status,0);
fs.writeFileSync('allowed','yes');
const socket=net.connect({host:'127.0.0.1',port:9}); socket.on('connect',()=>process.exit(20)); socket.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:21)); setTimeout(()=>process.exit(22),2000).unref();`);
  const executor = new MacVerificationExecutor({ node: process.execPath });
  const result = await executor.execute({ command: ['node', 'test.cjs'], cwd, env: verificationEnvironment(cwd, executor.bin), timeoutMs: 5000 });
  assert.equal(result.exit, 0, result.stderr); assert.equal(readFileSync(secret, 'utf8'), 'fixture-only-canary'); assert.equal(readFileSync(join(cwd, 'allowed'), 'utf8'), 'yes');
  assert.ok(result.isolation); assert.equal(existsSync(join(root, 'created-outside')), false);
});

test('macOS verification runs npm test in the pinned copy and kills an over-time process', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'journal-sandbox-npm-')); t.after(() => removeLater(root));
  const cwd = join(root, 'result'); mkdirSync(cwd);
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'tested\',\'yes\')"' } }));
  const executor = new MacVerificationExecutor({ node: process.execPath });
  assert.ok(executor.npm, 'This acceptance test requires npm next to Node');
  const env = verificationEnvironment(cwd, executor.bin);
  const outcome = await executor.execute({ command: ['npm', 'test'], cwd, env, timeoutMs: 5000 });
  assert.equal(outcome.exit, 0, outcome.stderr); assert.equal(readFileSync(join(cwd, 'tested'), 'utf8'), 'yes');
  const timeout = await executor.execute({ command: ['node', '-e', 'setInterval(()=>{},1000)'], cwd, env, timeoutMs: 80 });
  assert.equal(timeout.timedOut, true); assert.equal(timeout.exit, null);
});

test('verification executes the argv contract without shell interpolation', { skip: process.platform !== 'darwin' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'journal-sandbox-argv-')); t.after(() => removeLater(root)); const cwd = join(root, 'result'); mkdirSync(cwd);
  const executor = new MacVerificationExecutor({ node: process.execPath });
  const outcome = await executor.execute({ command: ['node', '-e', "require('fs').writeFileSync('argv',process.argv[1])", 'literal; touch injected'], cwd, env: verificationEnvironment(cwd, executor.bin), timeoutMs: 3000 });
  assert.equal(outcome.exit, 0, outcome.stderr); assert.equal(readFileSync(join(cwd, 'argv'), 'utf8'), 'literal; touch injected'); assert.equal(existsSync(join(cwd, 'injected')), false);
});

test('the packaged runtime Node mode can verify a result under the same isolation policy', { skip: process.platform !== 'darwin' }, async t => {
  const { fixtureEnv } = await import('./support/env.ts');
  const { execFileSync } = await import('node:child_process'); const { createRequire } = await import('node:module');
  const root = mkdtempSync(join(tmpdir(), 'journal-sandbox-electron-')); t.after(() => removeLater(root)); const cwd = join(root, 'result'); mkdirSync(cwd); const bin = join(root, 'bin'); mkdirSync(bin);
  const script = join(root, 'probe.mjs');
  writeFileSync(script, `import { MacVerificationExecutor } from ${JSON.stringify(new URL('../src/runtime/macos-verification.mjs', import.meta.url).href)}; import { verificationEnvironment } from ${JSON.stringify(new URL('../src/runtime/verification.mjs', import.meta.url).href)};const executor=new MacVerificationExecutor();const result=await executor.execute({command:['node','-e','process.exit(0)'],cwd:${JSON.stringify(cwd)},env:verificationEnvironment(${JSON.stringify(cwd)},executor.bin),timeoutMs:3000}); if(result.exit!==0)throw new Error(JSON.stringify(result));`);
  const env = fixtureEnv({ root, bin, extra: { ELECTRON_RUN_AS_NODE: '1' } });
  execFileSync(createRequire(import.meta.url)('electron'), [script], { env, timeout: 10000, stdio: 'pipe' });
});
test('library discovery excludes environment variables from Node diagnostic reports', () => {
  const original = process.report.getReport; const before = process.report.excludeEnv; let excluded;
  process.report.getReport = function () { excluded = this.excludeEnv; return { sharedObjects: [] }; };
  try { new MacVerificationExecutor(); assert.equal(excluded, true); assert.equal(process.report.excludeEnv, before); }
  finally { process.report.getReport = original; process.report.excludeEnv = before; }
});
