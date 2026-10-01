import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, win32 } from 'node:path';

// Process ownership. A PID alone is never authority to signal: after a runtime
// restart a PID may belong to an unrelated program. Journal signals a process
// only through a live PTY handle it still holds, or after its recorded start
// time and command match the current process exactly.

// The C locale keeps ps start times in one parseable English format.
const run = (file, args, timeout = 3000) => execFileSync(file, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
// Identities persist a hash of the command line: agent command lines carry
// prompt text, which belongs in receipts, not in process metadata.
const digest = command => createHash('sha256').update(command).digest('hex').slice(0, 32);
const LSTART = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/;

export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// { started, commandHash } or null when the platform cannot report it.
export function processIdentity(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'win32') {
      const value = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${pid} -ErrorAction Stop; "$($p.StartTime.ToFileTimeUtc())|$($p.Path)"`], 6000).trim();
      const [started, command] = value.split('|');
      return started ? { started, commandHash: digest(command ?? '') } : null;
    }
    const line = run('ps', ['-ww', '-o', 'lstart=', '-o', 'command=', '-p', String(pid)]).trim();
    const match = line.match(/^(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s(.*)$/);
    return match ? { started: match[1].replace(/\s+/g, ' '), commandHash: digest(match[2]) } : null;
  } catch { return null; }
}

export function sameIdentity(a, b) {
  return !!a && !!b && !!a.started && a.started === b.started && a.commandHash === b.commandHash;
}

// Parse `ps -A -o pid= -o ppid= -o pgid= -o lstart= -o command=` output.
export function parseProcessTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = line.match(LSTART);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), started: match[4].replace(/\s+/g, ' '), commandHash: digest(match[5]), command: match[5].slice(0, 200) });
  }
  return rows;
}

export function processTable(platform = process.platform) {
  if (platform === 'win32') return null; // Unknown: no portable cheap process table without extra tooling.
  try {
    const output = run('ps', ['-A', '-ww', '-o', 'pid=', '-o', 'ppid=', '-o', 'pgid=', '-o', 'lstart=', '-o', 'command=']);
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
export function signalVerified(pid, identity, signal, platform = process.platform) {
  if (!identity || !sameIdentity(processIdentity(pid, platform), identity)) return { signalled: false, reason: 'identity-mismatch' };
  try {
    if (platform === 'win32') run('taskkill', ['/PID', String(pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])]);
    else process.kill(pid, signal);
    return { signalled: true };
  } catch (error) { return { signalled: false, reason: error.code ?? 'failed' }; }
}

// Survivors among recorded descendants: alive with an unchanged identity.
export function survivors(recorded, table = processTable()) {
  if (!table) return null;
  const current = new Map(table.map(row => [row.pid, row]));
  return recorded.filter(row => sameIdentity(current.get(row.pid), row));
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
