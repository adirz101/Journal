import { homedir } from 'node:os';
import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, sep } from 'node:path';
import { realPath } from '../core/paths.mjs';
import { ADAPTERS } from './adapters/index.mjs';

// Per-launch observer hooks. Each observed session gets an append-only, size-bounded
// events file; its provider adapter writes the launch's registration (Claude: a
// settings file for --settings). Existing user and project hooks stay native.
// Observations are hints for status and activity, never approvals.
//
// Every registration runs one launcher at a fixed path in the data folder,
// `<launcher> <provider>`, so the command string is the same for every launch and
// every app version (a provider that trusts hooks by their command keeps that trust).
// Per-launch values travel in the agent's environment instead: JOURNAL_SESSION_ID,
// JOURNAL_HOOK_TARGET and JOURNAL_HOOK_TOKEN.
//
// What bounds a hook run (verified per provider in its adapter, hookTimeoutSeconds):
// - the provider enforces the timeout Journal registers for each hook, and treats a timeout
//   as non-blocking (Claude Code docs, Codex source, Cursor docs). This covers every stage:
//   the provider's shell, the launcher's start, the interpreter's start and the script;
// - on macOS and Linux the launcher also kills the script after LAUNCHER_TIMEOUT_S, which
//   bounds a stalled interpreter even below the provider's timeout;
// - the script exits after 1.5 s once it runs (src/desktop/hook.mjs).
// Native Windows (unverified): the .cmd launcher has no watchdog; a stalled interpreter is
// bounded only by the provider's timeout.
export const LAUNCHER_TIMEOUT_S = 2;
// After exit, a hook still running can append for as long as its provider lets it run: the
// drain waits longer than the largest timeout any adapter registers.
export const DRAIN_GRACE_MS = Math.max(...Object.values(ADAPTERS).map(adapter => adapter.hookTimeoutSeconds ?? 0), LAUNCHER_TIMEOUT_S) * 1000 + 500;
// A closed launch's hook can still create its file for a short while; only then is it swept.
const STRAY_MS = DRAIN_GRACE_MS * 2;
const MAX_FILE = 1024 * 1024;
const quote = (value, platform) => platform === 'win32' ? `"${value}"` : `'${value.replaceAll("'", "'\\''")}'`;
export const launcherName = platform => platform === 'win32' ? 'journal-hook.cmd' : 'journal-hook';
// The fixed launcher and the hook command for a provider: the same string every launch registers.
export const fixedLauncher = (dataDir, platform = process.platform) => join(dataDir, 'hooks', launcherName(platform));
export const launcherCommand = (launcher, platform, provider) => `${quote(launcher, platform)} ${provider}`;
// cmd.exe reads these even inside a quoted command (or the provider's shell may): a launcher
// whose path has one is not installed, and sessions start unobserved instead.
const CMD_UNSAFE = /[&()@^|%!"<>]/;

// The launcher always exits 0 and discards the script's output and errors, so whatever the
// script does, the provider sees a successful hook with only the neutral response: '{}' for
// Cursor, nothing otherwise. It returns at once when the agent was not started by Journal.
export function launcherScript({ execPath, hookScript, platform = process.platform, timeoutSeconds = LAUNCHER_TIMEOUT_S, allowContinuation = false }) {
  const responses = Object.values(ADAPTERS).filter(adapter => adapter.response);
  if (platform === 'win32') {
    // Inside a batch file `%` must be doubled; with delayed expansion off `!` is literal; quoted
    // paths keep & | ( ) ^ literal. No watchdog here (see above).
    const path = value => `"${value.replaceAll('"', '').replaceAll('%', '%%')}"`;
    return ['@echo off', 'setlocal DisableDelayedExpansion',
      'rem Journal hook launcher, rewritten by each Journal version. Always exits 0.',
      'if "%JOURNAL_HOOK_TARGET%"=="" goto respond',
      'set ELECTRON_RUN_AS_NODE=1',
      `${path(execPath)} ${path(hookScript)} %1 >NUL 2>&1`,
      ':respond',
      ...responses.map(adapter => `if /I "%~1"=="${adapter.provider}" echo ${adapter.response}`),
      'exit /b 0', ''].join('\r\n');
  }
  return ['#!/bin/sh',
    '# Journal hook launcher, rewritten by each Journal version. Always exits 0.',
    'exec 2>/dev/null',
    ...(allowContinuation ? ['run_hook() {'] : []),
    'if [ -n "$JOURNAL_HOOK_TARGET" ]; then',
    // Background jobs get /dev/null as stdin: keep the payload on fd 3 for the script.
    '  exec 3<&0',
    `  ELECTRON_RUN_AS_NODE=1 ${quote(execPath, platform)} ${quote(hookScript, platform)} "$1" <&3 ${allowContinuation ? '' : '>/dev/null'} 2>&1 3<&- &`,
    '  pid=$!',
    '  exec 3<&-',
    // The watchdog kills the script at the limit; stopped early, it ends its own sleep too.
    `  ( trap 'kill "$s"; exit 0' TERM; sleep ${Number(timeoutSeconds)} & s=$!; wait "$s"; kill -9 "$pid" ) >/dev/null 2>&1 </dev/null &`,
    '  watch=$!',
    '  wait "$pid" >/dev/null 2>&1',
    '  kill "$watch" >/dev/null 2>&1',
    'else',
    '  cat >/dev/null 2>&1',
    'fi',
    ...(allowContinuation ? ['}', `run_hook "$1" | ELECTRON_RUN_AS_NODE=1 ${quote(execPath, platform)} ${quote(fileURLToPath(new URL('./continuation-response.mjs', import.meta.url)), platform)} --filter "$1"`] : []),
    'case "$1" in',
    ...responses.map(adapter => `  ${adapter.provider}) printf '%s\\n' '${adapter.response}' ;;`),
    'esac',
    'exit 0', ''].join('\n');
}

// Writes the launcher when its content differs, always by rename: a file a hook may be running
// is never rewritten in place (cmd.exe reads a batch file while it runs it). When the rename
// fails (Windows, the file in use), the launcher is written under a versioned name and that
// path is used until a later start can replace the fixed one. Trade-off: launches registered
// meanwhile use another command string, so a provider that trusts hooks by their command
// (Codex) asks again for those launches.
export function installLauncher({ dataDir, execPath, hookScript, platform = process.platform, timeoutSeconds, allowContinuation = false }) {
  const dir = join(dataDir, 'hooks'); mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') chmodSync(dir, 0o700);
  const name = launcherName(platform); const path = join(dir, name);
  if (platform === 'win32' && CMD_UNSAFE.test(path)) throw new Error('The data folder path cannot be used in a hook command');
  const content = launcherScript({ execPath, hookScript, platform, timeoutSeconds, allowContinuation });
  const write = target => {
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, content, { mode: 0o700 });
    try { renameSync(temporary, target); } catch (error) { rmSync(temporary, { force: true }); throw error; }
    if (platform !== 'win32') chmodSync(target, 0o700);
    return target;
  };
  const current = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
  const versioned = join(dir, name.replace(/(\.cmd)?$/, `.${createHash('sha256').update(content).digest('hex').slice(0, 8)}$1`));
  let installed;
  if (current(path) === content) installed = path;
  else {
    try { installed = write(path); } catch { installed = current(versioned) === content ? versioned : write(versioned); }
  }
  if (platform !== 'win32') chmodSync(installed, 0o700);
  // Versioned copies left by an earlier fallback go once the fixed launcher is current.
  if (installed === path) for (const file of readdirSync(dir)) if (file !== name && file.startsWith('journal-hook.') && !file.endsWith('.tmp')) { try { rmSync(join(dir, file), { force: true }); } catch { /* in use: a later start */ } }
  return installed;
}

export class Observers {
  constructor({ dataDir, hookScript, execPath, platform = process.platform, ingest, lost = () => {}, drainGraceMs = DRAIN_GRACE_MS, launcherTimeoutSeconds = LAUNCHER_TIMEOUT_S, adapters = ADAPTERS, home = homedir() }) {
    this.dir = join(dataDir, 'observers'); this.platform = platform; this.home = home; this.ingest = ingest; this.lost = lost; this.drainGraceMs = drainGraceMs; this.adapters = adapters;
    this.sessions = new Map(); this.closed = new Map();
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Files from a previous runtime belong to sessions it can no longer observe.
    for (const name of readdirSync(this.dir)) this.remove(join(this.dir, name));
    // Without a launcher nothing is registered and sessions stay unobserved.
    try { this.launcher = installLauncher({ dataDir, execPath, hookScript, platform, timeoutSeconds: launcherTimeoutSeconds, allowContinuation: Object.values(adapters).some(adapter => adapter.continuation?.validated === true) }); } catch { this.launcher = null; }
  }
  remove(path) { try { rmSync(path, { force: true }); } catch { /* Windows may hold the file briefly; a later sweep retries. */ } }
  command(provider) { return launcherCommand(this.launcher, this.platform, provider); }
  // Registers a launch with its provider's adapter. Returns what the launch needs
  // ({ settingsFile, args, env }), or null when the provider is not observed. options carry what
  // the desktop knows about the provider (hooksEnabled: Codex's `features list`).
  prepare(session, project, options = {}) {
    const adapter = Object.hasOwn(this.adapters, session.provider) ? this.adapters[session.provider] : null;
    if (!adapter || !this.launcher) return null;
    const registration = adapter.register({ dir: this.dir, session, command: this.command(session.provider), launcher: this.launcher, platform: this.platform, home: this.home, hooksEnabled: options.hooksEnabled ?? null });
    if (!registration) return null;
    const target = join(this.dir, `${session.id}.events.jsonl`); const token = randomBytes(24).toString('hex');
    // Observations must come from where the session runs (checkout, worktree or folder).
    const cwd = session.cwd ?? project.root; let root = cwd; try { root = realPath(cwd); } catch { /* keep recorded root */ }
    this.sessions.set(session.id, { provider: session.provider, token, target, files: registration.files ?? [], root, offset: 0, partial: '' });
    return { settingsFile: registration.settingsFile ?? null, args: registration.args ?? [], observes: registration.observes ?? null, env: { JOURNAL_HOOK_TARGET: target, JOURNAL_HOOK_TOKEN: token } };
  }
  token(id) { return this.sessions.get(id)?.token ?? null; }
  poll() {
    for (const [id, observer] of this.sessions) this.pollOne(id, observer);
    // A hook of a recently closed launch can still create its file; nothing reads it, so it goes.
    const now = Date.now();
    for (const [id, closedAt] of this.closed) {
      const stray = join(this.dir, `${id}.events.jsonl`); if (existsSync(stray)) this.remove(stray);
      if (now - closedAt > STRAY_MS) this.closed.delete(id);
    }
  }
  pollOne(id, observer) {
    if (!existsSync(observer.target)) return;
    let fd;
    try {
      fd = openSync(observer.target, 'r'); const size = fstatSync(fd).size;
      if (size <= observer.offset) return;
      const buffer = Buffer.alloc(Math.min(size - observer.offset, 256 * 1024));
      const count = readSync(fd, buffer, 0, buffer.length, observer.offset); observer.offset += count;
      const lines = (observer.partial + buffer.subarray(0, count).toString('utf8')).split('\n'); observer.partial = lines.pop().slice(-8192);
      for (const line of lines) this.accept(id, observer, line);
      // The hook stops writing at 1 MiB; report it instead of freezing silently.
      if (size >= MAX_FILE && !observer.reportedLost) { observer.reportedLost = true; this.lost(id, 'cap'); }
    } catch (error) {
      // Observation failures never affect the native agent; a file that cannot be read is reported once.
      if (error?.code !== 'ENOENT' && !observer.reportedLost) { observer.reportedLost = true; this.lost(id, 'unreadable'); }
    }
    finally { if (fd !== undefined) closeSync(fd); }
    if (!observer.rotating && observer.offset > 256 * 1024 && observer.offset >= (this.sizeOf(observer.target) ?? 0)) this.rotate(id, observer);
  }
  sizeOf(path) { try { const fd = openSync(path, 'r'); try { return fstatSync(fd).size; } finally { closeSync(fd); } } catch { return null; } }
  // Consumed events are dropped: rename, drain anything appended meanwhile,
  // delete. The hook then starts a new file. Raw command text never lingers.
  rotate(id, observer) {
    const consumed = `${observer.target}.consumed`;
    try { renameSync(observer.target, consumed); } catch { return; }
    const target = observer.target; observer.target = consumed; observer.rotating = true;
    try { this.pollOne(id, observer); } finally {
      this.remove(consumed); Object.assign(observer, { target, offset: 0, partial: '', reportedLost: false, rotating: false });
    }
  }
  accept(id, observer, line) {
    let data; try { data = JSON.parse(line); } catch { return; }
    if (data?.id !== id || data.token !== observer.token || typeof data.cwd !== 'string') return;
    // Another provider's hook (a nested agent that inherited the environment) is not this launch's.
    // The older hook form wrote no provider: Claude.
    if ((data.provider ?? 'claude') !== observer.provider) return;
    let cwd; try { cwd = realPath(data.cwd); } catch { return; }
    if (cwd !== observer.root && !cwd.startsWith(observer.root + sep)) return;
    this.ingest(id, data);
  }
  // After the process exits: keep reading until the file is consumed and a hook that was
  // still running has had its time (the launcher's own limit), then close. A file that
  // keeps growing is read for at most a few grace periods.
  drain(id, { graceMs = this.drainGraceMs, intervalMs = 50 } = {}) {
    const observer = this.sessions.get(id); if (!observer) return Promise.resolve();
    if (observer.draining) return observer.draining;
    const started = Date.now();
    observer.draining = new Promise(resolve => {
      const step = () => {
        if (this.sessions.get(id) !== observer) { resolve(); return; }
        this.pollOne(id, observer);
        const consumed = (this.sizeOf(observer.target) ?? 0) <= observer.offset;
        const elapsed = Date.now() - started;
        if ((consumed && elapsed >= graceMs) || elapsed >= graceMs * 4) { this.close(id); resolve(); return; }
        setTimeout(step, intervalMs).unref?.();
      };
      step();
    });
    return observer.draining;
  }
  // Closed: later lines (this launch's or any other) are never read, and its files go.
  close(id) {
    const observer = this.sessions.get(id); if (!observer) return;
    this.sessions.delete(id); this.closed.set(id, Date.now());
    this.remove(observer.target); this.remove(`${observer.target}.consumed`); for (const file of observer.files) this.remove(file);
  }
  // Shutdown: the drains already started (sessions that ended) finish or reach the deadline;
  // then every observer closes. Sessions still running are not drained (they were saved as
  // interrupted and their late events would not apply).
  async drainAll(deadlineMs = this.drainGraceMs) {
    const drains = [...this.sessions.values()].map(observer => observer.draining).filter(Boolean);
    let timer; await Promise.race([Promise.all(drains), new Promise(resolve => { timer = setTimeout(resolve, deadlineMs); })]); clearTimeout(timer);
  }
  closeAll() { for (const id of [...this.sessions.keys()]) this.close(id); }
}
