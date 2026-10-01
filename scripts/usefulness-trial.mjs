// Manual, local usefulness trial. It makes real Claude Code requests on the
// operator's existing login, inside disposable fixture repositories outside
// this checkout. Not a CI, hosted or scheduled check.
//
//   node scripts/usefulness-trial.mjs setup
//   node scripts/usefulness-trial.mjs run [--reps 2] [--tasks a,b] [--conditions none,journal]
//   node scripts/usefulness-trial.mjs report
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, createWriteStream } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JournalStore } from '../src/core/store.mjs';
import { steps } from '../fixtures/usefulness/ledger.mjs';
import { agentsMd, claims, memorySeeds, overviewConstraints, refundsCurrent, refundsNext, sqliteDecision } from '../fixtures/usefulness/knowledge.mjs';
import { tasks } from '../fixtures/usefulness/tasks.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, '../fixtures/usefulness');
const OUT = resolve(here, '../.cache/usefulness');
const ROOT = process.env.JOURNAL_TRIAL_DIR ? resolve(process.env.JOURNAL_TRIAL_DIR) : join(realpathSync(tmpdir()), 'journal-usefulness');
const CONDITIONS = ['none', 'agents', 'memory', 'journal'];
const MODEL = 'sonnet'; const EFFORT = 'medium';
const BUDGET_USD = '3'; const RUN_TIMEOUT_MS = 15 * 60 * 1000;
const ALLOWED = ['Bash(npm *)', 'Bash(node *)', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(mkdir *)', 'Bash(head *)', 'Bash(wc *)'].join(',');

const argv = process.argv.slice(2); const command = argv[0];
const option = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : fallback; };
const sha = text => createHash('sha256').update(text).digest('hex');
const repoOf = condition => join(ROOT, condition, 'ledger');
// Claude Code keys auto memory by the sanitized working directory.
const memoryDirOf = cwd => join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');
const manifestPath = join(OUT, 'manifest.json');

let clock = Date.parse('2026-09-01T09:00:00Z');
function git(repo, ...args) {
  const date = new Date(clock).toISOString();
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Ledger Dev', GIT_AUTHOR_EMAIL: 'dev@ledger.test', GIT_COMMITTER_NAME: 'Ledger Dev', GIT_COMMITTER_EMAIL: 'dev@ledger.test', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
}
function commit(repo, step) {
  for (const [path, content] of Object.entries(step.files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  clock += 3600_000; git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', step.message);
}
function childEnv() {
  // A nested CLI must not inherit this session's identity, effort or sockets.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) delete env[key];
  return env;
}

function runClaude({ cwd, prompt, transcript, addDir }) {
  const args = ['-p', '--model', MODEL, '--effort', EFFORT, '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence',
    '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits', '--permission-prompts', 'none',
    '--allowedTools', ALLOWED, '--max-budget-usd', BUDGET_USD, ...(addDir ? ['--add-dir', addDir] : [])];
  return new Promise(resolvePromise => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const file = createWriteStream(transcript); let stderr = '';
    child.stdout.pipe(file); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), RUN_TIMEOUT_MS);
    child.on('close', code => { clearTimeout(timer); file.end(() => resolvePromise({ code, stderr: stderr.slice(-2000), wallMs: Date.now() - started })); });
    child.stdin.end(prompt);
  });
}

function parseTranscript(path, repo) {
  const events = readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const init = events.find(e => e.type === 'system' && e.subtype === 'init');
  const result = events.findLast(e => e.type === 'result');
  const uses = []; const outcomes = new Map();
  for (const event of events) {
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use') uses.push(block);
      if (event.type === 'user' && block.type === 'tool_result') outcomes.set(block.tool_use_id, { error: !!block.is_error, text: JSON.stringify(block.content ?? '').slice(0, 4000) });
    }
  }
  const editing = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
  const inRepo = use => String(use.input?.file_path ?? '').startsWith(repo);
  const firstEdit = uses.findIndex(use => editing.has(use.name) && inRepo(use));
  const tests = uses.filter(use => use.name === 'Bash' && /npm (?:run )?test|node --test/.test(use.input?.command ?? ''));
  const failedTests = tests.filter(use => { const o = outcomes.get(use.id); return o && (o.error || /# fail [1-9]|not ok \d/.test(o.text)); });
  const usage = result?.usage ?? {};
  return {
    memoryPath: init?.memory_paths?.auto ?? null, model: init?.model ?? null,
    subtype: result?.subtype ?? 'missing', isError: result?.is_error ?? true, turns: result?.num_turns ?? null,
    costUsd: result?.total_cost_usd ?? null, durationMs: result?.duration_ms ?? null,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0,
    toolCalls: uses.length, exploreBeforeEdit: firstEdit >= 0 ? firstEdit : uses.length, edited: firstEdit >= 0,
    testRuns: tests.length, failedTestRuns: failedTests.length,
    editedGenerated: uses.some(use => editing.has(use.name) && String(use.input?.file_path ?? '').includes('src/generated/')),
    filesRead: new Set(uses.filter(use => use.name === 'Read').map(use => use.input?.file_path)).size,
    deniedTools: uses.filter(use => /permission|denied|not allowed/i.test(outcomes.get(use.id)?.text ?? '') && outcomes.get(use.id)?.error).map(use => use.name),
  };
}

function resetCheckout(repo, branch, head) {
  git(repo, 'checkout', '-f', '-q', branch); git(repo, 'reset', '--hard', '-q', head); git(repo, 'clean', '-fdxq');
}
function restoreMemory(condition, repo) {
  const dir = memoryDirOf(repo); rmSync(dir, { recursive: true, force: true });
  const snapshot = join(ROOT, 'memory-snapshot');
  if (condition === 'memory' && existsSync(snapshot)) cpSync(snapshot, dir, { recursive: true });
}

async function setup() {
  if (existsSync(ROOT)) {
    for (const condition of CONDITIONS) rmSync(dirname(memoryDirOf(repoOf(condition))), { recursive: true, force: true });
    rmSync(ROOT, { recursive: true, force: true });
  }
  mkdirSync(ROOT, { recursive: true }); mkdirSync(join(OUT, 'setup'), { recursive: true });
  const maintenance = []; const heads = {};
  const note = (condition, action, typedChars, detail = '') => maintenance.push({ condition, action, typedChars, detail });
  const base = condition => {
    clock = Date.parse('2026-09-01T09:00:00Z'); const repo = repoOf(condition); mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main'); for (const step of steps.base) commit(repo, step); return repo;
  };
  const finish = (condition, repo) => {
    git(repo, 'switch', '-q', 'main'); for (const step of steps.refactor) commit(repo, step);
    heads[condition] = { main: git(repo, 'rev-parse', 'main'), 'feature/refunds': git(repo, 'rev-parse', 'feature/refunds') };
  };

  // Journal: reviewed claims, Git-drafted overview and branch update.
  const journalRepo = base('journal');
  const store = new JournalStore(join(ROOT, 'journal', 'journal.sqlite')); const project = store.openProject(journalRepo);
  const approve = input => { const memory = store.proposeMemory(project.id, input); store.setMemoryStatus(memory.id, 'active'); return memory; };
  const overviewDraft = store.proposeStatusUpdate(project.id, 'checkout');
  const overview = overviewDraft.statement.replace(/^Constraints: .*$/m, overviewConstraints);
  approve({ statement: overview, category: 'brief', scope: 'checkout', area: '', source: overviewDraft.source });
  note('journal', 'Overview drafted from Git; operator filled Constraints and approved', overviewConstraints.length);
  for (const claim of claims) {
    approve({ statement: claim.statement, category: claim.category, scope: claim.scope, area: '', source: claim.source });
    note('journal', `Wrote and approved ${claim.id}`, claim.statement.length + (claim.source.note?.length ?? 0));
  }
  git(journalRepo, 'switch', '-q', '-c', 'feature/refunds'); for (const step of steps.refunds) commit(journalRepo, step);
  const refundsDraft = store.proposeStatusUpdate(project.id, 'branch');
  const refundsStatus = refundsDraft.statement.replace(/^Current work: .*$/m, refundsCurrent).replace(/^Next: .*$/m, refundsNext);
  approve({ statement: refundsStatus, category: 'brief', scope: 'branch', area: '', source: refundsDraft.source });
  note('journal', 'Branch update drafted from Git; operator wrote Current work and Next, then approved', refundsCurrent.length + refundsNext.length,
    `${refundsDraft.basis.commitCount} commits summarized automatically`);
  git(journalRepo, 'switch', '-q', 'main'); git(journalRepo, 'switch', '-q', '-c', 'experiment/sqlite'); for (const step of steps.sqlite) commit(journalRepo, step);
  approve({ statement: sqliteDecision.statement, category: sqliteDecision.category, scope: 'branch', area: '', source: sqliteDecision.source });
  note('journal', 'Wrote and approved the experiment/sqlite decision (branch scope)', sqliteDecision.statement.length + sqliteDecision.source.note.length);
  finish('journal', journalRepo);
  const afterRefactor = store.listMemories(project.id);
  const staleFlags = afterRefactor.filter(m => m.validation === 'stale').map(m => m.statement.slice(0, 60));
  store.close();

  // AGENTS.md: the same text, committed where a maintainer would put it.
  const agentsRepo = base('agents');
  writeFileSync(join(agentsRepo, 'AGENTS.md'), agentsMd({ overview })); git(agentsRepo, 'add', 'AGENTS.md'); git(agentsRepo, 'commit', '-q', '-m', 'Add AGENTS.md');
  note('agents', 'Wrote AGENTS.md overview and claims', agentsMd({ overview }).length);
  git(agentsRepo, 'switch', '-q', '-c', 'feature/refunds'); for (const step of steps.refunds) commit(agentsRepo, step);
  writeFileSync(join(agentsRepo, 'AGENTS.md'), agentsMd({ overview, branchStatus: refundsStatus })); git(agentsRepo, 'commit', '-q', '-am', 'Record refunds status');
  note('agents', 'Wrote branch status into AGENTS.md on feature/refunds', refundsStatus.length, 'no Git draft; full status typed');
  git(agentsRepo, 'switch', '-q', 'main'); git(agentsRepo, 'switch', '-q', '-c', 'experiment/sqlite'); for (const step of steps.sqlite) commit(agentsRepo, step);
  writeFileSync(join(agentsRepo, 'AGENTS.md'), agentsMd({ overview, branchDecision: sqliteDecision.statement })); git(agentsRepo, 'commit', '-q', '-am', 'Record SQLite decision');
  note('agents', 'Wrote the experiment/sqlite decision into AGENTS.md on that branch', sqliteDecision.statement.length);
  finish('agents', agentsRepo);

  const noneRepo = base('none');
  git(noneRepo, 'switch', '-q', '-c', 'feature/refunds'); for (const step of steps.refunds) commit(noneRepo, step);
  git(noneRepo, 'switch', '-q', 'main'); git(noneRepo, 'switch', '-q', '-c', 'experiment/sqlite'); for (const step of steps.sqlite) commit(noneRepo, step);
  finish('none', noneRepo);

  // Native memory: the operator asks Claude to remember the same knowledge.
  const memoryRepo = base('memory'); const memoryDir = memoryDirOf(memoryRepo); const seeds = [];
  mkdirSync(memoryDir, { recursive: true });
  const seed = async (label, prompt) => {
    const transcript = join(OUT, 'setup', `memory-seed-${label}.jsonl`);
    const run = await runClaude({ cwd: memoryRepo, prompt, transcript, addDir: memoryDir });
    const parsed = parseTranscript(transcript, memoryRepo);
    if (parsed.memoryPath && resolve(parsed.memoryPath) !== resolve(memoryDir)) throw new Error(`Unexpected memory path ${parsed.memoryPath}`);
    seeds.push({ label, code: run.code, costUsd: parsed.costUsd, toolCalls: parsed.toolCalls });
    note('memory', `Asked Claude to remember ${label} knowledge`, prompt.length);
    if (git(memoryRepo, 'status', '--porcelain')) throw new Error(`Memory seeding changed repository files (${label})`);
  };
  await seed('main', memorySeeds.main(overview));
  git(memoryRepo, 'switch', '-q', '-c', 'feature/refunds'); for (const step of steps.refunds) commit(memoryRepo, step);
  await seed('refunds', memorySeeds.refunds(refundsStatus));
  git(memoryRepo, 'switch', '-q', 'main'); git(memoryRepo, 'switch', '-q', '-c', 'experiment/sqlite'); for (const step of steps.sqlite) commit(memoryRepo, step);
  await seed('sqlite', memorySeeds.sqlite());
  finish('memory', memoryRepo);
  if (!existsSync(memoryDir) || !readdirSync(memoryDir).length) throw new Error('Native memory seeding saved nothing');
  cpSync(memoryDir, join(ROOT, 'memory-snapshot'), { recursive: true });
  cpSync(memoryDir, join(OUT, 'setup', 'memory-snapshot'), { recursive: true });

  const frozen = Object.fromEntries(['ledger.mjs', 'knowledge.mjs', 'tasks.mjs'].map(name => [name, sha(readFileSync(join(fixtures, name)))]));
  const manifest = { createdAt: new Date().toISOString(), root: ROOT, model: MODEL, effort: EFFORT, budgetUsd: BUDGET_USD, allowedTools: ALLOWED,
    claude: execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim(), frozen, heads, maintenance, staleFlags, seeds,
    agentsMdBytes: { main: Buffer.byteLength(agentsMd({ overview })), refunds: Buffer.byteLength(agentsMd({ overview, branchStatus: refundsStatus })) },
    texts: { overview, refundsStatus } };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ heads, staleFlags, seeds, memoryFiles: readdirSync(memoryDir) }, null, 2));
}

async function runCondition(condition, selected, reps, manifest) {
  const repo = repoOf(condition); const resultsFile = join(OUT, 'results.jsonl');
  const done = new Set(existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line).key) : []);
  const store = condition === 'journal' ? new JournalStore(join(ROOT, 'journal', 'journal.sqlite')) : null;
  const projectId = store?.openProject(repo).id;
  try {
    for (let rep = 1; rep <= reps; rep++) for (const task of selected) {
      const key = `${condition}/${task.id}/${rep}`; if (done.has(key)) continue;
      resetCheckout(repo, task.branch, manifest.heads[condition][task.branch]); restoreMemory(condition, repo);
      let prompt = task.prompt; let context = null;
      if (store) {
        // Same composition as the desktop launcher: reviewed packet, then the task.
        const receipt = store.prepareContext(projectId, task.prompt);
        if (receipt.packet) prompt = `${receipt.packet}\nTask:\n${task.prompt}`;
        context = { bytes: Buffer.byteLength(receipt.packet), claims: receipt.items.map(i => i.statement.slice(0, 40)), excluded: receipt.excluded.map(x => x.reason), warnings: receipt.warnings };
      }
      if (condition === 'agents') context = { bytes: Buffer.byteLength(readFileSync(join(repo, 'AGENTS.md'))) };
      if (condition === 'memory') { const index = join(memoryDirOf(repo), 'MEMORY.md'); context = { bytes: existsSync(index) ? Buffer.byteLength(readFileSync(index)) : 0 }; }
      const transcript = join(OUT, 'runs', `${condition}-${task.id}-${rep}.jsonl`);
      writeFileSync(join(OUT, 'runs', `${condition}-${task.id}-${rep}.prompt.txt`), prompt);
      console.log(`[${new Date().toISOString()}] start ${key}`);
      const run = await runClaude({ cwd: repo, prompt, transcript });
      const metrics = parseTranscript(transcript, repo);
      const graderFile = join(OUT, 'graders', `${task.id}.mjs`); writeFileSync(graderFile, task.grader);
      let grade;
      try { grade = JSON.parse(execFileSync(process.execPath, [graderFile, repo], { encoding: 'utf8', timeout: 60000, stdio: 'pipe' }).trim().split('\n').at(-1)); }
      catch (error) { grade = { pass: false, trap: 'grader-error', detail: String(error.message).slice(0, 300) }; }
      const diff = git(repo, 'status', '--porcelain');
      const record = { key, condition, task: task.id, kind: task.kind, rep, exit: run.code, wallMs: run.wallMs, stderr: run.stderr || undefined, context, ...metrics, grade, changedPaths: diff.split('\n').filter(Boolean).length };
      appendFileSync(resultsFile, JSON.stringify(record) + '\n');
      console.log(`[${new Date().toISOString()}] done ${key} pass=${grade.pass} trap=${grade.trap} cost=${metrics.costUsd}`);
    }
  } finally { store?.close(); }
}

async function run() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const frozen = Object.fromEntries(['ledger.mjs', 'knowledge.mjs', 'tasks.mjs'].map(name => [name, sha(readFileSync(join(fixtures, name)))]));
  if (JSON.stringify(frozen) !== JSON.stringify(manifest.frozen)) throw new Error('Fixtures changed after setup; rerun setup');
  mkdirSync(join(OUT, 'runs'), { recursive: true }); mkdirSync(join(OUT, 'graders'), { recursive: true });
  const reps = Number(option('reps', '2'));
  const selectedTasks = option('tasks') ? tasks.filter(t => option('tasks').split(',').includes(t.id)) : tasks;
  const conditions = option('conditions') ? option('conditions').split(',') : CONDITIONS;
  await Promise.all(conditions.map(condition => runCondition(condition, selectedTasks, reps, manifest)));
}

function report() {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rows = readFileSync(join(OUT, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const mean = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const byCondition = Object.fromEntries(CONDITIONS.map(condition => {
    const mine = rows.filter(r => r.condition === condition);
    return [condition, {
      runs: mine.length, passed: mine.filter(r => r.grade.pass).length,
      perTask: Object.fromEntries(tasks.map(t => { const r = mine.filter(x => x.task === t.id); return [t.id, { passed: r.filter(x => x.grade.pass).length, runs: r.length, traps: r.map(x => x.grade.trap).filter(Boolean) }]; })),
      meanExploreBeforeEdit: mean(mine.map(r => r.exploreBeforeEdit)), meanToolCalls: mean(mine.map(r => r.toolCalls)), meanFilesRead: mean(mine.map(r => r.filesRead)),
      meanTurns: mean(mine.map(r => r.turns)), meanCostUsd: mean(mine.map(r => r.costUsd)), meanDurationS: mean(mine.map(r => r.durationMs && r.durationMs / 1000)),
      meanInputTokens: mean(mine.map(r => r.inputTokens)), meanContextBytes: mean(mine.map(r => r.context?.bytes)),
      failedTestRuns: mine.reduce((a, r) => a + r.failedTestRuns, 0), generatedFileEdits: mine.filter(r => r.editedGenerated).length,
      incomplete: mine.filter(r => r.isError || r.exit !== 0).length,
    }];
  }));
  const summary = { manifest: { createdAt: manifest.createdAt, model: manifest.model, effort: manifest.effort, claude: manifest.claude, frozen: manifest.frozen, staleFlags: manifest.staleFlags, maintenance: manifest.maintenance, agentsMdBytes: manifest.agentsMdBytes }, byCondition };
  writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

if (command === 'setup') await setup();
else if (command === 'run') await run();
else if (command === 'report') report();
else { console.error('Usage: node scripts/usefulness-trial.mjs setup | run [--reps N] [--tasks ids] [--conditions ids] | report'); process.exitCode = 2; }
