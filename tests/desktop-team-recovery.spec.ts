import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { fixtureEnv } from './support/env';

test.skip(process.platform !== 'darwin', 'macOS team acceptance; Windows is deferred');

const request = (page: Page, action: string, input: any = {}) => page.evaluate(({ action, input }) => (window as any).journal.request(action, input), { action, input });

for (const mode of ['settled', 'live', 'cold restart']) test(`a team survives Main absence and runtime death without replay (${mode})`, async () => {
  const liveWorker = mode !== 'settled';
  test.setTimeout(90000);
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'team-recovery-'));
  const project = join(root, 'project'), bin = join(root, 'bin'), data = join(root, 'data');
  for (const dir of [project, bin, data]) mkdirSync(dir);
  writeFileSync(join(root, 'package.json'), '{"type":"commonjs"}');
  writeFileSync(join(data, 'preferences.json'), JSON.stringify({ coordinatedRuns: true }));
  const env = fixtureEnv({ root, bin, extra: { JOURNAL_DATA_DIR: data, JOURNAL_QUIT_POLICY: 'stop' } });
  const git = (...args: string[]) => execFileSync('git', ['-C', project, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', ...args], { env, stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); writeFileSync(join(project, 'README.md'), 'before\n'); git('add', '.'); git('commit', '-qm', 'initial');
  for (const [name, output] of [['vm_stat', 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: 1000000.\nPages inactive: 1000000.\nPages speculative: 10000.'], ['sysctl', '1']]) {
    writeFileSync(join(bin, name), `#!${process.execPath}\nconsole.log(${JSON.stringify(output)})`); chmodSync(join(bin, name), 0o755);
  }
  const clientUrl = pathToFileURL(resolve('src/agent-tools/client.mjs')).href;
  writeFileSync(join(bin, 'claude'), `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('2.1.286 (Claude Code)');process.exit(0)}
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true,authMethod:'fixture'}));process.exit(0)}
if(!process.env.JOURNAL_TOOL_ID){console.log('fixture help');process.exit(0)}
const root=${JSON.stringify(root)},coordinator=!process.env.JOURNAL_TASK_ID;
fs.appendFileSync(path.join(root,'launches.jsonl'),JSON.stringify({pid:process.pid,coordinator})+'\\n');
process.stdin.resume();process.stdin.on('data',d=>fs.appendFileSync(path.join(root,'input.txt'),String(d)));
console.log('Recovery fixture ready');
if(coordinator){const timer=setInterval(()=>{if(!fs.existsSync(path.join(root,'launch-worker')))return;clearInterval(timer);(async()=>{
const {clientFromEnv}=await import(${JSON.stringify(clientUrl)});const client=clientFromEnv();
const task=await client.call('create_task',{requestId:'absent-task',title:'Work while Main is absent'});
await client.call('create_worker',{requestId:'absent-worker',taskId:task.id,provider:'claude'});
client.close();fs.writeFileSync(path.join(root,'requested'),'ok');
})().catch(e=>fs.writeFileSync(path.join(root,'fixture-error'),e.stack))},50)}
else {fs.writeFileSync('README.md','result produced with Main absent\\n');fs.writeFileSync(path.join(root,'worker-finished'),'ok');if(!${liveWorker})setTimeout(()=>process.exit(0),100)}
`); chmodSync(join(bin, 'claude'), 0o755);
  execFileSync(process.execPath, ['--check', join(bin, 'claude')], { env, stdio: 'pipe' });
  let app: ElectronApplication | undefined;
  const runtimeInfo = () => JSON.parse(readFileSync(join(data, 'runtime.json'), 'utf8'));
  const launches = () => readFileSync(join(root, 'launches.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  try {
    app = await electron.launch({ args: ['.'], env }); let page = await app.firstWindow();
    const opened = await request(page, 'openProjectPath', { path: project });
    const run = await request(page, 'createRun', { projectId: opened.id, requestId: 'recovery-run', provider: 'claude', goal: 'Recovery acceptance' });
    await expect.poll(() => existsSync(join(root, 'launches.jsonl')), { timeout: 20000, message: JSON.stringify(run) }).toBe(true);
    const message = await request(page, 'sendMessage', { runId: run.id, requestId: 'held-message', recipient: 'coordinator', kind: 'instruction', text: 'Do not replay this into the terminal' });
    const before = runtimeInfo();
    await page.reload(); await expect.poll(async () => (await request(page, 'getRun', { runId: run.id })).messages.some((item: any) => item.id === message.id)).toBe(true);
    app.process().kill('SIGKILL'); await app.close().catch(() => {}); app = undefined;
    writeFileSync(join(root, 'launch-worker'), 'go');
    await expect.poll(() => existsSync(join(root, 'worker-finished')), { timeout: 20000 }).toBe(true);
    expect(existsSync(join(root, 'fixture-error'))).toBe(false);
    expect(runtimeInfo().runtimeId).toBe(before.runtimeId);
    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await expect.poll(async () => (await request(page, 'getRun', { runId: run.id })).attempts[0]?.state, { timeout: 15000 }).toBe(liveWorker ? 'working' : 'result_available');
    const captured = await request(page, 'getRun', { runId: run.id });
    expect(captured.tasks).toHaveLength(1); expect(captured.attempts).toHaveLength(1); expect(captured.results).toHaveLength(liveWorker ? 0 : 1);
    const resultId = captured.results[0]?.id;
    if (!liveWorker) expect(resultId).toBeTruthy(); expect(captured.attempts[0].presence).toBe(liveWorker ? 'live' : 'paused'); expect(launches()).toHaveLength(2);
    // Capture a real process inventory before this drill kills the runtime. A crash
    // before any inventory must instead remain lost/unknown, never presumed writer-free.
    if (liveWorker) await expect.poll(async () => Array.isArray((await request(page, 'getSession', { id: captured.attempts[0].currentSessionId })).processTracking?.descendants), { timeout: 10000 }).toBe(true);
    if (mode === 'cold restart') { app.process().kill('SIGKILL'); await app.close().catch(() => {}); app = undefined; }
    process.kill(before.pid, 'SIGKILL');
    if (mode === 'cold restart') { app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow(); }
    await expect.poll(() => { try { return runtimeInfo().runtimeId !== before.runtimeId; } catch { return false; } }, { timeout: 20000 }).toBe(true);
    await expect.poll(async () => (await request(page, 'getRun', { runId: run.id })).state, { timeout: 15000 }).toBe('detached');
    await expect.poll(async () => (await request(page, 'getRun', { runId: run.id })).attempts[0].state, { timeout: 15000 }).toBe('result_available');
    const recovered = await request(page, 'getRun', { runId: run.id });
    expect(recovered.attempts[0].state).toBe('result_available'); expect(recovered.results).toHaveLength(1);
    if (resultId) expect(recovered.results[0].id).toBe(resultId);
    expect(recovered.attempts[0].presence).toBe('paused');
    expect(recovered.messages.find((item: any) => item.id === message.id).state).toMatch(/queued|held/);
    expect(recovered.tasks).toHaveLength(1); expect(recovered.attempts).toHaveLength(1); expect(launches()).toHaveLength(2);
    expect(existsSync(join(root, 'input.txt')) ? readFileSync(join(root, 'input.txt'), 'utf8') : '').not.toContain(message.text);
  } catch (error) { console.error('Recovery drill failed:', error); throw error; } finally {
    if (!app && existsSync(join(data, 'runtime.json'))) { app = await electron.launch({ args: ['.'], env }); await app.firstWindow(); }
    await app?.close().catch(() => {});
    await expect.poll(() => existsSync(join(data, 'runtime.json')), { timeout: 20000 }).toBe(false);
    rmSync(root, { recursive: true, force: true });
  }
});
