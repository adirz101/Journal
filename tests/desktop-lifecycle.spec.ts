import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { resolve, delimiter } from 'node:path';
import { execFileSync } from 'node:child_process';

// This verifies owned real processes, not assistant text or a simulated interrupt.
test('running child cancellation, terminal stop and app exit leave no owned fixture processes', async () => {
  test.skip(process.platform === 'win32', 'Native Windows lifecycle requires a local Windows fixture');
  mkdirSync(resolve('.cache/tmp'), { recursive: true });
  const root = mkdtempSync(resolve('.cache/tmp', 'lifecycle-'));
  const project = resolve(root, 'fixture project'); const bin = resolve(root, 'bin');
  mkdirSync(project); mkdirSync(bin);
  writeFileSync(resolve(root, 'package.json'), '{"type":"commonjs"}\n');
  const ledger = resolve(root, 'launches.jsonl'); const childRecord = resolve(root, 'child.json');
  const heartbeat = resolve(root, 'heartbeat');
  const git = (...args: string[]) => execFileSync('git', ['-C', project, ...args], { stdio: 'pipe' });
  git('init', '-b', 'main');
  const childCode = `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(childRecord)},JSON.stringify({pid:process.pid}));
process.on('SIGINT',()=>{console.log('CHILD_CANCELLED');process.exit(0)});
setInterval(()=>fs.writeFileSync(${JSON.stringify(heartbeat)},String(Date.now())),100);
setTimeout(()=>process.exit(0),45000);
console.log('CHILD_READY '+process.pid);`;
  const fixture = `#!${process.execPath}
const fs=require('node:fs');const {spawn}=require('node:child_process');
if(process.argv.includes('--version')){console.log('fixture 1.0');process.exit(0)}
fs.appendFileSync(${JSON.stringify(ledger)},JSON.stringify({pid:process.pid,argv:process.argv.slice(2)})+'\\n');
console.log('PTY_READY '+process.stdout.isTTY); console.log('ARGS '+JSON.stringify(process.argv.slice(2)));
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let input='';let child;
process.stdin.on('data',data=>{for(const char of data){
if(char==='\\x03'){if(child)child.kill('SIGINT');continue}
if(char!=='\\r'&&char!=='\\n'){input+=char;continue}
const command=input;input='';
if(command==='run'){child=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});child.stdout.pipe(process.stdout);child.on('exit',()=>{console.log('CHILD_EXIT');child=null})}
else console.log('ECHO '+command);
}});`;
  for (const name of ['claude', 'codex']) { writeFileSync(resolve(bin, name), fixture); chmodSync(resolve(bin, name), 0o755); }
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), PATH: `${bin}${delimiter}${process.env.PATH}`, JOURNAL_DATA_DIR: resolve(root, 'data') };
  delete env.ELECTRON_RUN_AS_NODE;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } };
  const launches = () => existsSync(ledger) ? readFileSync(ledger, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const ownedChildren: number[] = [];
  let app = await electron.launch({ args: ['.'], env });
  try {
    await app.evaluate(({ dialog }, selected) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] }); }, project);
    let page = await app.firstWindow();
    await page.getByRole('button', { name: 'Open project', exact: true }).first().click();
    await page.getByLabel('Initial task').fill('LIFECYCLE_INITIAL_TASK');
    await page.getByRole('button', { name: 'Start Claude' }).click();
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    const firstArgs = launches()[0].argv; const nativeId = firstArgs[firstArgs.indexOf('--session-id') + 1];
    const runChild = async () => {
      rmSync(childRecord, { force: true });
      await page.locator('.xterm-helper-textarea').pressSequentially('run');
      await page.locator('.xterm-helper-textarea').press('Enter');
      await expect.poll(() => existsSync(childRecord)).toBe(true);
      const pid = JSON.parse(readFileSync(childRecord, 'utf8')).pid; ownedChildren.push(pid);
      await expect(page.locator('.terminal-surface')).toContainText('CHILD_READY ' + pid);
      expect(alive(pid)).toBe(true); return pid;
    };
    const interrupted = await runChild();
    await page.getByRole('button', { name: /^Interrupt/ }).click();
    await expect(page.locator('.terminal-surface')).toContainText('CHILD_CANCELLED');
    await expect.poll(() => alive(interrupted)).toBe(false);
    expect(alive(launches()[0].pid)).toBe(true);

    const stopped = await runChild();
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect.poll(() => alive(stopped)).toBe(false);
    await expect.poll(() => alive(launches()[0].pid)).toBe(false);
    await expect(page.getByRole('button', { name: 'Resume', exact: true }).first()).toBeEnabled();
    await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await expect.poll(() => launches().length).toBe(2);
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    expect(launches()[1].argv).toContain(nativeId);
    expect(launches()[1].argv).toContain('--resume');
    expect(launches()[1].argv.join(' ')).not.toContain('LIFECYCLE_INITIAL_TASK');
    const quitting = await runChild(); const quittingParent = launches()[1].pid;
    const before = await page.evaluate(async () => {
      const boot = await (window as any).journal.request('bootstrap');
      return (window as any).journal.request('project', { projectId: boot.projects[0].id });
    });
    await app.close();
    await expect.poll(() => alive(quitting)).toBe(false);
    await expect.poll(() => alive(quittingParent)).toBe(false);
    const count = launches().length;
    app = await electron.launch({ args: ['.'], env }); page = await app.firstWindow();
    await page.getByRole('button', { name: /fixture project/ }).click();
    const after = await page.evaluate(async () => {
      const boot = await (window as any).journal.request('bootstrap');
      return { active: boot.activeSession, project: await (window as any).journal.request('project', { projectId: boot.projects[0].id }) };
    });
    expect(after.active).toBeNull(); expect(launches()).toHaveLength(count);
    expect(after.project.sessions.some((s: any) => s.status === 'interrupted' && s.nativeId === nativeId)).toBe(true);
    for (const receipt of before.receipts) {
      const retained = after.project.receipts.find((r: any) => r.id === receipt.id);
      expect(retained.launchPrompt).toBe(receipt.launchPrompt);
      expect(retained.items).toEqual(receipt.items);
    }
    expect(after.project.receipts[0].state).toBe('uncertain');
    await page.getByRole('button', { name: 'Resume', exact: true }).first().click();
    await expect.poll(() => launches().length).toBe(count + 1);
    await expect(page.locator('.terminal-surface')).toContainText('PTY_READY true');
    expect(launches()[count].argv).toEqual(['--resume', nativeId, '--settings', launches()[count].argv[3]]);
    await page.getByRole('button', { name: 'Stop terminal' }).click();
    await expect.poll(() => alive(launches()[count].pid)).toBe(false);
  } finally {
    await app.close();
    // Every listed process was created by this bounded fixture. Cleanup after a
    // failing assertion so manual validation itself never leaves a timer behind.
    for (const pid of [...ownedChildren, ...launches().map(x => x.pid)]) {
      try {
        const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', stdio: 'pipe' });
        if (command.includes(root)) process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(root, { recursive: true, force: true });
  }
});
