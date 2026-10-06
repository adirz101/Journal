import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { refuse } from '../core/orchestration/model.mjs';

const quote = value => JSON.stringify(value);
const SYSTEM_READ = ['/System/Library', '/System/Volumes/Preboot/Cryptexes/OS', '/usr/lib', '/bin', '/usr/bin', '/Library/Apple/System/Library'];
// Default deny also excludes network, Mach services, user homes and other processes.
// The only writable tree is the disposable immutable-result copy. No shell startup files,
// provider installation, project checkout, npm cache or inherited credential is exposed.
export class MacVerificationExecutor {
  constructor({ node = process.execPath, libraries = runtimeLibraries(), npm = null } = {}) {
    this.node = realpathSync(node); this.libraries = libraries.filter(path => path.startsWith('/') && existsSync(path)).map(path => realpathSync(path));
    const prefix = dirname(dirname(this.node));
    const candidate = ['lib/node_modules/npm/bin/npm-cli.js', 'libexec/lib/node_modules/npm/bin/npm-cli.js'].map(path => join(prefix, path)).find(existsSync);
    this.npm = npm ? realpathSync(npm) : candidate ? realpathSync(candidate) : null;
    if (this.npm && (basename(this.npm) !== 'npm-cli.js' || basename(dirname(dirname(this.npm))) !== 'npm')) this.npm = null;
    this.children = new Set(); this.closed = false;
    this.resources = this.node.includes('.app/Contents/') ? [this.node.slice(0, this.node.indexOf('.app/Contents/') + 4)].filter(existsSync).map(path => realpathSync(path)) : [];
    this.bin = '/usr/bin:/bin'; this.validatedIsolation = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');
    this.evidenceId = 'macos-seatbelt-deny-default-v1';
  }
  close() { this.closed = true; for (const child of this.children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
  profile(cwd, tools) {
    const reads = [...[...SYSTEM_READ, ...this.resources].map(path => `(subpath ${quote(path)})`), ...[this.node, ...this.libraries].map(path => `(literal ${quote(path)})`), ...(this.npm ? [`(subpath ${quote(dirname(dirname(this.npm)))})`] : []), `(subpath ${quote(tools)})`];
    return `(version 1)\n(deny default)\n(allow process-exec process-fork sysctl-read)\n(allow file-read-metadata)\n(allow file-read-data (literal "/"))\n(allow file-read* file-map-executable ${reads.join(' ')})\n(allow file-read* file-write* file-map-executable (subpath ${quote(cwd)}))\n(allow file-read* file-write* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`;
  }
  async execute({ command, cwd, env, timeoutMs }) {
    if (this.closed) refuse('CHECK_CANCELLED', 'Verification is closing');
    if (!this.validatedIsolation) refuse('CHECK_ISOLATION_UNVERIFIED', 'The macOS sandbox is unavailable');
    cwd = realpathSync(cwd);
    const control = mkdtempSync(join(dirname(cwd), 'sandbox-control-')); const tools = join(control, 'bin'); mkdirSync(tools);
    symlinkSync(this.node, join(tools, 'node'));
    if (this.npm) writeFileSync(join(tools, 'npm'), `#!/bin/sh\nexec ${shellQuote(this.node)} ${shellQuote(this.npm)} "$@"\n`, { mode: 0o700 });
    const profile = this.profile(cwd, tools); const policy = join(control, 'profile.sb'); writeFileSync(policy, profile, { mode: 0o600 });
    const clean = { ...env, OPENSSL_CONF: '/dev/null', PATH: `${tools}:/usr/bin:/bin` };
    try {
      // Prove this exact policy works before executing result-controlled code. The canary
      // is ours, outside the readable roots; this probe never touches a real secret.
      const canary = join(control, 'canary'); writeFileSync(canary, 'Journal isolation canary', { mode: 0o600 });
      const probe = `const fs=require('fs'),net=require('net');for(const fn of [()=>fs.readFileSync(${JSON.stringify(canary)}),()=>fs.writeFileSync(${JSON.stringify(canary)},'x')]){try{fn();process.exit(31)}catch(e){if(!['EACCES','EPERM'].includes(e.code))process.exit(32)}}const s=net.connect({host:'127.0.0.1',port:9});s.on('connect',()=>process.exit(33));s.on('error',e=>process.exit(['EPERM','EACCES'].includes(e.code)?0:34));setTimeout(()=>process.exit(35),1500).unref();`;
      const proof = await executeSandbox(policy, this.node, ['-e', probe], cwd, clean, 3000, this.children);
      if (proof.exit !== 0) refuse('CHECK_ISOLATION_UNVERIFIED', 'The macOS filesystem/network isolation probe failed', { exit: proof.exit, signal: proof.signal, diagnostic: proof.stderr });
      if (this.closed) refuse('CHECK_CANCELLED', 'Verification is closing');
      if (!Array.isArray(command) || !command.length || command.length > 30 || command.some(arg => typeof arg !== 'string' || !arg || arg.length > 500 || arg.includes('\0'))) refuse('INVALID_INPUT', 'Expected a bounded command argv');
      const result = await executeSandbox(policy, '/usr/bin/env', ['--', ...command], cwd, clean, timeoutMs, this.children);
      return { ...result, isolation: `${this.evidenceId}:${createHash('sha256').update(profile).digest('hex')}` };
    } finally { rmSync(control, { recursive: true, force: true }); }
  }
}
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
function executeSandbox(policy, executable, args, cwd, env, timeoutMs, children) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], { cwd, env, detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    children.add(child);
    let stderr = ''; let timedOut = false;
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs); timer.unref();
    child.stderr.on('data', data => { if (stderr.length < 4096) stderr += data.toString().slice(0, 4096 - stderr.length); });
    child.once('error', error => { children.delete(child); clearTimeout(timer); reject(error); });
    child.once('exit', (exit, signal) => { children.delete(child); clearTimeout(timer); kill(); resolve({ exit: timedOut ? null : exit, signal, timedOut, stderr }); });
  });
}

function runtimeLibraries() {
  if (!process.report) return [];
  const previous = process.report.excludeEnv;
  process.report.excludeEnv = true;
  try { return process.report.getReport().sharedObjects ?? []; }
  finally { process.report.excludeEnv = previous; }
}
