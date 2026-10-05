import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, win32 } from 'node:path';

// Process ownership. A PID alone is never authority to signal: after a runtime
// restart a PID may belong to an unrelated program. Journal signals a process
// only through a live PTY handle it still holds, or after the PID's recorded
// start time (to the second, in UTC) still matches. The command line is not
// part of identity: Node CLIs rewrite their process title after start.
//
// Lookups are asynchronous so they never block terminal streaming.

// C locale and UTC keep ps start times in one parseable, DST-stable format.
const options = timeout => ({ encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' } });
const run = (file, args, timeout = 3000) => new Promise((resolve, reject) => execFile(file, args, options(timeout), (error, stdout) => error ? reject(error) : resolve(stdout)));
const LSTART = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/;

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// { started } or null when the platform cannot report it.
export async function processIdentity(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const value = (await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.StartTime.ToFileTimeUtc())|$($p.Path)"`], 6000)).trim();
      const [started, command] = value.split('|');
      void command; return started ? { started } : null;
    }
    const line = (await run('ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)])).trim();
    const match = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/);
    return match ? { started: match[1].replace(/\s+/g, ' ') } : null;
  } catch { return null; }
}

export function sameIdentity(a, b) {
  return !!a && !!b && !!a.started && a.started === b.started;
}

// Parse `ps -A -o pid= -o ppid= -o pgid= -o lstart= -o command=` output.
export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(LSTART);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, ' '), command: match[5].slice(0, 200) });
  }
  return rows;
}

export async function processTable(platform = process.platform) {
  if (platform === 'win32') return null; // Unknown: no portable cheap process table without extra tooling.
  try {
    const output = await run('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=']);
    const rows = parseProcessTable(output);
    // Unparseable output means unknown, never "no processes".
    return rows.length || !output.trim() ? rows : null;
  } catch { return null; }
}

// Descendants by parent links plus the root's process group (children that
// were reparented but kept the group). Processes that called setsid and were
// reparented before a snapshot cannot be attributed; periodic snapshots
// narrow that window but cannot close it.
export function descendants(table, rootPid) {
  if (!table) return null;
  const children = new Map();
  for (const row of table) { if (!children.has(row.ppid)) children.set(row.ppid, []); children.get(row.ppid).push(row); }
  const found = new Map(); const queue = [rootPid];
  while (queue.length) for (const row of children.get(queue.shift()) ?? []) if (!found.has(row.pid)) { found.set(row.pid, row); queue.push(row.pid); }
  for (const row of table) if (row.pgid === rootPid && row.pid !== rootPid && !found.has(row.pid)) found.set(row.pid, row);
  return [...found.values()];
}

// Signal only if the process still has the identity Journal recorded.
export async function signalVerified(pid, identity, signal, platform = process.platform) {
  if (!identity || !sameIdentity(await processIdentity(pid, platform), identity)) return { signalled: false, reason: 'identity-mismatch' };
  try {
    if (platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]);
    else process.kill(pid, signal);
    return { signalled: true };
  } catch (error) { return { signalled: false, reason: error.code ?? 'failed' }; }
}

// Survivors among recorded descendants: alive with an unchanged identity.
export function survivors(recorded, table) {
  if (!table) return null;
  const current = new Map(table.map(row => [row.pid, row]));
  return recorded.filter(row => sameIdentity(current.get(row.pid), row));
}

// Test isolation (app side). In a headless test run (JOURNAL_HEADLESS=1) that names its fixture
// folder in JOURNAL_TEST_PROVIDER_DIR, a provider CLI may be probed or launched only when its
// real path lies inside that folder: a real claude, codex or agent elsewhere on the computer is
// treated as not installed and never run. Outside such runs every path is allowed.
export function testProviderAllowed(path, env = process.env) {
  const dir = env.JOURNAL_TEST_PROVIDER_DIR;
  if (env.JOURNAL_HEADLESS !== '1' || !dir) return true;
  if (typeof path !== 'string' || !path) return false;
  try {
    const inside = relative(realpathSync(dir), realpathSync(path));
    return !!inside && !inside.startsWith('..') && !isAbsolute(inside);
  } catch { return false; }
}

// PATH lookup including Windows PATHEXT, so `claude` resolves to claude.cmd.
export function resolveExecutable(name, env = process.env, platform = process.platform) {
  if (isAbsolute(name)) return existsSync(name) ? name : null;
  const extensions = platform === 'win32' ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      try { if (statSync(candidate).isFile()) return candidate; } catch { /* keep searching */ }
    }
  }
  return null;
}

// cmd.exe cannot carry multi-line arguments, and Journal prompts contain
// newlines. npm installs Windows CLIs as .cmd shims that call a Node script;
// launch that script directly instead of routing knowledge through cmd.exe.
// Unverified on a real Windows machine; see docs/WINDOWS.md.
export function launchTarget(executable, argv, { env = process.env, platform = process.platform, read, node: nodePath } = {}) {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(executable)) return { file: executable, args: argv };
  let shim = '';
  try { shim = (read ?? (path => readFileSync(path, 'utf8')))(executable); } catch { /* handled below */ }
  const script = shim.match(/"%~?dp0%?\\([^"%]+\.(?:c|m)?js)"/i)?.[1];
  if (!script) throw new Error(`${executable} is a cmd.exe launcher without a recognizable Node script; multi-line prompts cannot be passed safely through cmd.exe`);
  const dir = win32.dirname(executable);
  const localNode = win32.join(dir, 'node.exe');
  const node = nodePath ?? (existsSync(localNode) ? localNode : resolveExecutable('node', env, platform));
  if (!node) throw new Error('Node.js is required to start this CLI on Windows');
  return { file: node, args: [win32.join(dir, script), ...argv] };
}

// Child processes never inherit Electron's Node mode, and never open a browser.
export const childEnv = env => { const next = { ...env, NO_OPEN_BROWSER: '1' }; delete next.ELECTRON_RUN_AS_NODE; return next; };

// One short, bounded, asynchronous run of a CLI (detection, help, status): resolves
// with stdout; rejects with the error, its exit code, stdout and stderr. On timeout
// the whole process tree is ended (POSIX: the process group; Windows: taskkill /T),
// since a launcher's child may outlive its parent. Never a shell; stdin is ignored by default.
// output 'both' resolves { stdout, stderr } (a status line may be printed on stderr).
const KILL_DEADLINE = 2500;
export function runFile(path, args, env = process.env, { platform = process.platform, cwd, timeout = 8000, stdin = 'ignore', output = 'stdout', maxBuffer = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    // runFile runs only provider CLIs (detection, help and sign-in checks).
    if (!testProviderAllowed(path, env)) { reject(Object.assign(new Error('Outside the test provider folder'), { testGuard: true })); return; }
    let target;
    try { target = launchTarget(path, args, { env, platform }); } catch (error) { error.unlaunchable = true; reject(error); return; }
    // spawn, not execFile: execFile drops `detached`, and the group is what a timeout ends.
    let child;
    try { child = spawn(target.file, target.args, { cwd, env: childEnv(env), windowsHide: true, detached: platform !== 'win32', stdio: [stdin === 'ignore' ? 'ignore' : 'pipe', 'pipe', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let stdout = ''; let stderr = ''; let size = 0; let done = false; let timedOut = false; let overflow = false; let deadline = null;
    // How a killed run settled: 'close' (its pipes ended) or 'deadline' (they were dropped). Set on
    // the timeout and overflow errors, so callers and tests can tell without timing the run.
    let settledBy = 'close';
    const end = () => {
      // 'close' waits for stdout and stderr to end. A grandchild that left the group
      // (setsid or detached) can hold them open forever, so after the kill the run
      // settles by a hard deadline, dropping the pipes, whether or not 'close' came.
      deadline ??= setTimeout(() => { settledBy = 'deadline'; child.stdout.destroy(); child.stderr.destroy(); finish(null); }, KILL_DEADLINE);
      if (!child.pid) return;
      if (platform === 'win32') { execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); return; }
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
      setTimeout(() => { try { process.kill(-child.pid, 0); process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ } }, 2000).unref();
    };
    const collect = which => data => {
      size += data.length;
      if (size > maxBuffer) { if (!overflow) { overflow = true; end(); } return; }
      if (which === 'out') stdout += data; else stderr += data;
    };
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', collect('out')); child.stderr.on('data', collect('err'));
    const timer = setTimeout(() => { timedOut = true; end(); }, timeout);
    const finish = (error, code, signal) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(deadline);
      if (error) { reject(Object.assign(error, { stdout, stderr })); return; }
      if (timedOut) { reject(Object.assign(new Error('Timed out'), { timedOut: true, killed: true, settledBy, stdout, stderr })); return; }
      if (overflow) { reject(Object.assign(new Error('Output exceeded the limit'), { killed: true, settledBy, stdout, stderr })); return; }
      if (code !== 0) { reject(Object.assign(new Error(`Exited with ${signal ?? code}`), { code: signal ? null : code, signal, stdout, stderr })); return; }
      resolve(output === 'both' ? { stdout, stderr } : stdout);
    };
    child.on('error', error => finish(error));
    // 'close' fires after both streams are read, so output printed just before exit is kept.
    child.on('close', (code, signal) => finish(null, code, signal));
  });
}
