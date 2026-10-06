import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitEnv } from '../core/git-env.mjs';
import { relativePath } from '../core/validation.mjs';
import { isSensitivePath } from '../core/evidence.mjs';
import { refuse } from '../core/orchestration/model.mjs';
const git = (root, args, raw = false) => execFileSync('git', ['-C', root, ...args], { encoding: raw ? undefined : 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024, env: gitEnv(), stdio: 'pipe', windowsHide: true });

// Materialize immutable objects, never a mutable worktree or its ignored dependencies.
// Links, nested repositories and sensitive paths are refused rather than followed.
export function materializeResult(root, result, directory) {
  if (!/^[a-f0-9]{40,64}$/.test(result.resultCommit) || git(root, ['rev-parse', `${result.resultCommit}^{tree}`]).trim() !== result.treeOid) refuse('RESULT_CHANGED', 'The immutable result tree does not match');
  let bytes = 0;
  const records = git(root, ['ls-tree', '-rz', '--full-tree', result.resultCommit]).split('\0').filter(Boolean);
  if (records.length > 20000) refuse('CHECK_TOO_LARGE', 'Too many files for verification');
  for (const record of records) {
    const match = record.match(/^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/); if (!match) refuse('UNSUPPORTED_TREE', 'Unknown tree entry');
    const [, mode, type, oid, path] = match; relativePath(path);
    if (type !== 'blob' || !['100644', '100755'].includes(mode) || isSensitivePath(path)) refuse('UNSUPPORTED_TREE', 'Verification refuses linked, nested or sensitive content');
    const data = git(root, ['cat-file', 'blob', oid], true); bytes += data.length;
    if (bytes > 128 * 1024 * 1024) refuse('CHECK_TOO_LARGE', 'This result exceeds the verification copy limit');
    const destination = join(directory, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, data, { flag: 'wx', mode: mode === '100755' ? 0o700 : 0o600 });
  }
  return { files: records.length, bytes };
}

export function verificationEnvironment(root, bin) {
  // No inherited secrets, provider homes, credentials, PATH or launcher variables.
  const home = join(root, '.journal-home'); const temp = join(root, '.journal-temp'); mkdirSync(home, { recursive: true }); mkdirSync(temp, { recursive: true });
  return { PATH: bin, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, CODEX_HOME: home, CLAUDE_CONFIG_DIR: home, TMPDIR: temp, TMP: temp, TEMP: temp, CI: '1', LANG: 'C.UTF-8', ELECTRON_RUN_AS_NODE: '1' };
}

export class VerificationManager {
  constructor({ store, dataDir, executor = null }) { Object.assign(this, { store, dataDir, executor }); this.active = false; }
  async close() { this.closing = true; this.executor?.close?.(); await this.finished; }
  async run(input) {
    if (this.closing) refuse('CHECK_CANCELLED', 'Verification is closing');
    // A clean environment alone is not a filesystem/network sandbox. A platform executor
    // must separately prove those exclusions before any result-controlled code can execute.
    if (!this.executor?.validatedIsolation) refuse('CHECK_ISOLATION_UNVERIFIED', 'Isolated check execution is not validated on this platform. Provider test reports remain claims.');
    if (this.active) refuse('CHECK_BUSY', 'Another verification is running');
    this.active = true; this.finished = new Promise(resolve => { this.finish = resolve; });
    let operation = null; let directory = null; let check = null;
    try {
      const run = await this.store.getRun(input.runId); const result = run.results.find(row => row.id === input.resultId);
      if (!result) refuse('NOT_FOUND', 'Unknown result');
      if (run.paused) refuse('RUN_PAUSED', 'Continue the run before verifying a result');
      operation = await this.store.prepareRunOperation('verify_result', input, run.id);
      if (operation.phase === 'done') return operation.outcome;
      if (operation.existing) { operation = null; refuse('OPERATION_PENDING', 'The previous check is unresolved; it will not automatically rerun'); }
      const base = join(this.dataDir, 'verification'); mkdirSync(base, { recursive: true, mode: 0o700 });
      directory = mkdtempSync(join(base, 'check-'));
      const project = await this.store.project(run.projectId); const copy = materializeResult(project.root, result, directory);
      check = { id: randomUUID(), operationId: operation.id, resultId: result.id, treeOid: result.treeOid, command: input.command, startedAt: new Date().toISOString(), endedAt: null, exit: null, provenance: 'isolated-verification', state: 'running', source: { commit: result.resultCommit, ...copy } };
      await this.store.recordResultCheck(result.id, check);
      const outcome = await this.executor.execute({ command: input.command, cwd: directory, env: verificationEnvironment(directory, this.executor.bin), timeoutMs: 120000 });
      const finished = { ...check, exit: Number.isInteger(outcome.exit) ? outcome.exit : null, state: outcome.timedOut ? 'timed-out' : 'finished', endedAt: new Date().toISOString(), isolation: outcome.isolation ?? this.executor.evidenceId };
      await this.store.recordResultCheck(result.id, finished); return await this.store.finishRunOperation(operation.id, finished);
    } catch (error) {
      if (check) await this.store.recordResultCheck(check.resultId, { ...check, state: 'interrupted', endedAt: new Date().toISOString(), exit: null });
      if (operation) await this.store.failRunOperation(operation.id, { code: error.code ?? 'CHECK_FAILED', message: error.message });
      throw error;
    } finally { this.active = false; this.finish?.(); if (directory) rmSync(directory, { recursive: true, force: true }); }
  }
}
