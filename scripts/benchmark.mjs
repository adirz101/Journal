// Reproducible usefulness benchmark (manual, local; real provider requests).
//
//   node scripts/benchmark.mjs <suite dir> freeze             record suite hashes
//   node scripts/benchmark.mjs <suite dir> setup [--conditions none,agents,memory,journal]
//   node scripts/benchmark.mjs <suite dir> run [--reps 5] [--tasks a,b] [--conditions ...]
//   node scripts/benchmark.mjs <suite dir> report             metrics, CIs, GO/MODIFY
//
// Conditions: A none · B agents (AGENTS.md) · C memory (native Claude memory)
// · D journal (reviewed packet). See docs/BENCHMARK.md for the suite format.
// Never part of CI: it uses the operator's own Claude Code login.
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JournalStore } from '../src/core/store.mjs';

export const CONDITIONS = ['none', 'agents', 'memory', 'journal'];
export { suiteHash };
export const DEFAULT_CRITERIA = { minReps: 5, goDelta: 0.15, harmTolerance: 0.05, abandonDelta: 0.10, maxMaintenanceRatio: 1.25 };

// ---------- pure helpers (unit tested) ----------
export function wilson(passed, total, z = 1.96) {
  if (!total) return { low: 0, high: 0 };
  const p = passed / total; const d = 1 + z * z / total; const centre = p + z * z / (2 * total); const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
  return { low: Math.max(0, (centre - margin) / d), high: Math.min(1, (centre + margin) / d) };
}

// GO/MODIFY/ABANDON from results, decided by criteria frozen with the suite.
export function evaluate(rows, tasks, maintenance = {}, criteria = DEFAULT_CRITERIA) {
  const rate = (condition, filter = () => true) => { const r = rows.filter(x => x.condition === condition && filter(x)); return { passed: r.filter(x => x.grade.pass).length, total: r.length }; };
  const differentiating = new Set(tasks.filter(t => t.differentiating).map(t => t.id));
  const isDiff = row => differentiating.has(row.task);
  const share = ({ passed, total }) => total ? passed / total : null;
  const reps = Math.min(...tasks.map(t => Math.min(...CONDITIONS.map(c => rows.filter(r => r.task === t.id && r.condition === c).length))));
  const overall = Object.fromEntries(CONDITIONS.map(c => [c, rate(c)]));
  const diff = Object.fromEntries(CONDITIONS.map(c => [c, rate(c, isDiff)]));
  const bestBaseline = ['agents', 'memory'].map(c => share(diff[c]) ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const bestOverall = ['agents', 'memory'].map(c => share(overall[c]) ?? 0).reduce((a, b) => Math.max(a, b), 0);
  const reasons = []; let verdict = 'MODIFY';
  const journalDiff = share(diff.journal) ?? 0; const journalOverall = share(overall.journal) ?? 0;
  const maintenanceRatio = maintenance.journal && Math.min(maintenance.agents ?? Infinity, maintenance.memory ?? Infinity) !== Infinity
    ? maintenance.journal / Math.min(maintenance.agents ?? Infinity, maintenance.memory ?? Infinity) : null;
  if (!Number.isFinite(reps) || reps < criteria.minReps) reasons.push(`Only ${Number.isFinite(reps) ? reps : 0} repetitions per task and condition; at least ${criteria.minReps} are required for a verdict.`);
  else if (!differentiating.size) reasons.push('No differentiating tasks are defined, so Journal cannot be separated from baselines.');
  else if (journalOverall < (share(overall.none) ?? 0) - criteria.abandonDelta) { verdict = 'ABANDON'; reasons.push('Journal performed worse than no context overall.'); }
  else if (journalDiff >= bestBaseline + criteria.goDelta && journalOverall >= bestOverall - criteria.harmTolerance && (maintenanceRatio === null || maintenanceRatio <= criteria.maxMaintenanceRatio)) {
    verdict = 'GO'; reasons.push(`Journal passed ${(journalDiff * 100).toFixed(0)}% of differentiating runs vs ${(bestBaseline * 100).toFixed(0)}% for the best baseline, without losing elsewhere.`);
  } else reasons.push(`Differentiating pass rate ${(journalDiff * 100).toFixed(0)}% vs best baseline ${(bestBaseline * 100).toFixed(0)}% (needs +${criteria.goDelta * 100} points); overall ${(journalOverall * 100).toFixed(0)}% vs ${(bestOverall * 100).toFixed(0)}%.`);
  return { verdict, reasons, reps: Number.isFinite(reps) ? reps : 0, overall, differentiating: diff, maintenanceRatio };
}

export function agentsMarkdown(items) {
  const lines = ['# Project knowledge', ''];
  const overview = items.find(i => i.kind === 'overview'); if (overview) lines.push('## Overview', overview.statement, '');
  const claims = items.filter(i => i.kind === 'claim' && i.scope !== 'branch'); if (claims.length) lines.push('## Decisions, constraints and lessons', ...claims.map(c => `- ${c.statement}`), '');
  for (const item of items.filter(i => i.kind === 'status')) lines.push(`## Current branch status (${item.branch})`, item.statement, '');
  for (const item of items.filter(i => i.kind === 'claim' && i.scope === 'branch')) lines.push(`## Branch decision (${item.branch})`, `- ${item.statement}`, '');
  return lines.join('\n');
}

export function validateSuite(suite) {
  const problems = [];
  if (!suite?.name || !Array.isArray(suite.tasks) || !suite.tasks.length) problems.push('suite needs a name and tasks');
  if (!['generated', 'frozen'].includes(suite?.repository?.kind)) problems.push('repository.kind must be generated or frozen');
  if (suite?.repository?.kind === 'frozen' && !/^[0-9a-f]{40}$/.test(suite.repository.commit ?? '')) problems.push('a frozen repository needs an exact 40-character commit');
  for (const task of suite?.tasks ?? []) {
    if (!/^[a-z0-9-]+$/.test(task.id ?? '')) problems.push(`task id ${task.id} must be kebab-case`);
    if (typeof task.prompt !== 'string' || typeof task.grader !== 'string' || !task.branch) problems.push(`task ${task.id} needs branch, prompt and grader source`);
  }
  if (!Array.isArray(suite?.timeline)) problems.push('suite needs a timeline');
  return problems;
}

// ---------- repository materialization ----------
let clock = Date.parse('2026-09-01T09:00:00Z');
const gitIn = repo => (...args) => {
  const date = new Date(clock).toISOString();
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 'Bench Dev', GIT_AUTHOR_EMAIL: 'dev@bench.test', GIT_COMMITTER_NAME: 'Bench Dev', GIT_COMMITTER_EMAIL: 'dev@bench.test', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).trim();
};
function writeStep(repo, step) {
  for (const [path, content] of Object.entries(step.files ?? {})) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  for (const path of step.delete ?? []) rmSync(join(repo, path), { force: true });
  clock += 3600_000; const git = gitIn(repo); git('add', '-A'); git('commit', '-q', '-m', step.message);
}

// Applies the suite timeline for one condition. `onKnowledge(label, git)` lets
// each condition record knowledge at the right point in history.
export async function materialize(suite, repo, onKnowledge) {
  clock = Date.parse('2026-09-01T09:00:00Z'); mkdirSync(repo, { recursive: true });
  const git = gitIn(repo);
  if (suite.repository.kind === 'frozen') {
    execFileSync('git', ['clone', '--quiet', '--no-hardlinks', suite.repository.source, repo], { stdio: 'pipe' });
    git('checkout', '-q', '-B', suite.repository.branch ?? 'main', suite.repository.commit);
  } else git('init', '-q', '-b', 'main');
  for (const op of suite.timeline) {
    if (op.commit) writeStep(repo, op.commit);
    else if (op.branch) git('switch', '-q', '-c', op.branch, ...(op.from ? [op.from] : []));
    else if (op.switch) git('switch', '-q', op.switch);
    else if (op.knowledge) await onKnowledge(op.knowledge, git);
    else throw new Error(`Unknown timeline step ${JSON.stringify(op)}`);
  }
  return Object.fromEntries(suite.tasks.map(t => t.branch).filter((b, i, a) => a.indexOf(b) === i).map(branch => [branch, git('rev-parse', branch)]));
}

const itemsAt = (suite, label) => (suite.knowledge ?? []).filter(item => item.at === label);
const memoryDirOf = cwd => join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

// ---------- provider runs (Claude Code; Codex is not automated here) ----------
const ALLOWED = ['Bash(npm *)', 'Bash(node *)', 'Bash(git *)', 'Bash(ls *)', 'Bash(cat *)', 'Bash(grep *)', 'Bash(find *)', 'Bash(mkdir *)', 'Bash(head *)', 'Bash(wc *)', 'Bash(python3 *)', 'Bash(pytest *)'].join(',');
function childEnv() { const env = { ...process.env }; for (const key of Object.keys(env)) if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) delete env[key]; return env; }
function runClaude({ cwd, prompt, transcript, model, effort, budget, timeoutMs, addDir }) {
  const args = ['-p', '--model', model, '--effort', effort, '--setting-sources', 'project,local', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits', '--permission-prompts', 'none', '--allowedTools', ALLOWED, '--max-budget-usd', String(budget), ...(addDir ? ['--add-dir', addDir] : [])];
  return new Promise(resolvePromise => {
    const started = Date.now(); const child = spawn('claude', args, { cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const file = createWriteStream(transcript); let stderr = '';
    child.stdout.pipe(file); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', code => { clearTimeout(timer); file.end(() => resolvePromise({ code, stderr: stderr.slice(-2000), wallMs: Date.now() - started })); });
    child.stdin.end(prompt);
  });
}
export function parseTranscript(text) {
  const events = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const result = events.findLast(e => e.type === 'result'); const uses = [];
  for (const event of events) for (const block of event.message?.content ?? []) if (event.type === 'assistant' && block.type === 'tool_use') uses.push(block);
  const editing = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']); const firstEdit = uses.findIndex(use => editing.has(use.name));
  const usage = result?.usage ?? {};
  return { isError: result?.is_error ?? true, turns: result?.num_turns ?? null, costUsd: result?.total_cost_usd ?? null, durationMs: result?.duration_ms ?? null,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0,
    toolCalls: uses.length, toolsBeforeEditTool: firstEdit >= 0 ? firstEdit : uses.length };
}

// ---------- commands ----------
async function loadSuite(dir) { const suite = (await import(pathToFileURL(join(dir, 'suite.mjs')).href)).default; const problems = validateSuite(suite); if (problems.length) throw new Error(`Invalid suite: ${problems.join('; ')}`); return suite; }
// Hash the evaluated suite (timeline files, knowledge, prompts, grader source)
// as well as the suite directory, so edits to imported fixtures are caught.
const suiteHash = (dir, suite) => ({ ...Object.fromEntries(readdirSync(dir).filter(f => /\.(?:mjs|json|md)$/.test(f) && f !== 'FROZEN.json').sort().map(f => [f, createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')])),
  '(evaluated suite)': createHash('sha256').update(JSON.stringify(suite)).digest('hex') });

async function main() {
  const [suiteArg, command] = process.argv.slice(2); const option = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
  if (!suiteArg || !command) { console.error('Usage: node scripts/benchmark.mjs <suite dir> freeze|setup|run|report'); process.exitCode = 2; return; }
  const dir = resolve(suiteArg); const suite = await loadSuite(dir);
  const out = resolve('.cache/benchmarks', suite.name); mkdirSync(join(out, 'runs'), { recursive: true });
  const root = process.env.JOURNAL_BENCH_DIR ? resolve(process.env.JOURNAL_BENCH_DIR) : join(realpathSync(tmpdir()), `journal-bench-${suite.name}`);
  const config = { model: option('model', 'sonnet'), effort: option('effort', 'medium'), budget: Number(option('budget', '3')), timeoutMs: 15 * 60_000 };
  const conditions = option('conditions', CONDITIONS.join(',')).split(',');
  if (command === 'freeze') { writeFileSync(join(dir, 'FROZEN.json'), JSON.stringify({ frozenAt: new Date().toISOString(), files: suiteHash(dir, suite) }, null, 2)); console.log('Suite frozen'); return; }
  if (command !== 'report' && existsSync(join(dir, 'FROZEN.json'))) {
    const frozen = JSON.parse(readFileSync(join(dir, 'FROZEN.json'), 'utf8')).files; const current = suiteHash(dir, suite);
    if (JSON.stringify(frozen) !== JSON.stringify(current)) throw new Error('Suite files changed after freezing; re-freeze explicitly before running');
  }
  if (command === 'setup') {
    rmSync(root, { recursive: true, force: true }); const manifest = { suite: suite.name, createdAt: new Date().toISOString(), config, heads: {}, maintenance: {} };
    for (const condition of conditions) {
      const repo = join(root, condition, 'repo'); let typed = 0; const sofar = [];
      let store = null; let project = null; const memoryDir = memoryDirOf(join(root, condition, 'repo')); rmSync(dirname(memoryDir), { recursive: true, force: true });
      manifest.heads[condition] = await materialize(suite, repo, async (label, git) => {
        const branch = git('rev-parse', '--abbrev-ref', 'HEAD'); const items = itemsAt(suite, label).map(i => ({ ...i, branch }));
        if (condition === 'journal') {
          store ??= new JournalStore(join(root, condition, 'journal.sqlite')); project ??= store.openProject(repo);
          for (const item of items) {
            let statement = item.statement; let source = item.source ?? { kind: 'user', note: 'Benchmark knowledge' };
            if (item.kind === 'overview' || item.kind === 'status') {
              const draft = store.proposeStatusUpdate(project.id, item.kind === 'overview' ? 'checkout' : 'branch');
              statement = item.kind === 'overview' ? draft.statement.replace(/^Constraints: .*$/m, `Constraints: ${item.constraints}`) : draft.statement.replace(/^Current work: .*$/m, `Current work: ${item.current}`).replace(/^Next: .*$/m, `Next: ${item.next}`);
              source = draft.source; typed += (item.constraints ?? '').length + (item.current ?? '').length + (item.next ?? '').length; item.statement = statement;
            } else typed += statement.length + (source.note?.length ?? 0);
            const memory = store.proposeMemory(project.id, { statement, category: item.kind === 'claim' ? item.category : 'brief', scope: item.kind === 'overview' ? 'checkout' : item.kind === 'status' ? 'branch' : item.scope, area: item.area ?? '', source });
            store.setMemoryStatus(memory.id, 'active');
          }
        } else {
          for (const item of items) item.statement ??= item.kind === 'overview' ? `${suite.overviewPurpose ?? ''}\nConstraints: ${item.constraints}` : `Current work: ${item.current}\nNext: ${item.next}`;
          sofar.push(...items);
          if (condition === 'agents' && items.length) {
            const applicable = sofar.filter(i => i.kind === 'overview' || (i.kind === 'claim' && i.scope !== 'branch') || i.branch === branch);
            const text = agentsMarkdown(applicable); typed += items.reduce((sum, i) => sum + i.statement.length, 0);
            writeFileSync(join(repo, 'AGENTS.md'), text); git('add', 'AGENTS.md'); git('commit', '-q', '-m', `Record knowledge (${label})`);
          }
          if (condition === 'memory' && items.length) {
            mkdirSync(memoryDir, { recursive: true });
            const prompt = `${branch !== 'main' ? `We are on the ${branch} branch. ` : ''}Please remember the following for future sessions. Save it to your memory. Do not modify any repository files.\n\n${items.map(i => `- ${i.statement}`).join('\n')}`;
            typed += prompt.length;
            await runClaude({ cwd: repo, prompt, transcript: join(out, 'runs', `seed-${label}.jsonl`), ...config, addDir: memoryDir });
          }
        }
      });
      if (condition === 'memory' && existsSync(memoryDir)) cpSync(memoryDir, join(root, 'memory-snapshot'), { recursive: true });
      store?.close(); manifest.maintenance[condition] = typed;
    }
    writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify(manifest.heads, null, 2)); return;
  }
  if (command === 'run') {
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')); const reps = Number(option('reps', '5'));
    const selected = option('tasks') ? suite.tasks.filter(t => option('tasks').split(',').includes(t.id)) : suite.tasks;
    const resultsFile = join(out, 'results.jsonl'); const done = new Set(existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l).key) : []);
    await Promise.all(conditions.map(async condition => {
      const repo = join(root, condition, 'repo'); const git = gitIn(repo); const store = condition === 'journal' ? new JournalStore(join(root, condition, 'journal.sqlite')) : null; const projectId = store?.openProject(repo).id;
      try {
        for (let rep = 1; rep <= reps; rep++) for (const task of selected) {
          const key = `${condition}/${task.id}/${rep}`; if (done.has(key)) continue;
          git('checkout', '-f', '-q', task.branch); git('reset', '--hard', '-q', manifest.heads[condition][task.branch]); git('clean', '-fdxq');
          const memoryDir = memoryDirOf(repo); rmSync(memoryDir, { recursive: true, force: true });
          if (condition === 'memory' && existsSync(join(root, 'memory-snapshot'))) cpSync(join(root, 'memory-snapshot'), memoryDir, { recursive: true });
          let prompt = task.prompt; let contextBytes = 0;
          if (store) { const receipt = store.prepareContext(projectId, task.prompt); if (receipt.packet) prompt = `${receipt.packet}\nTask:\n${task.prompt}`; contextBytes = Buffer.byteLength(receipt.packet); }
          const transcript = join(out, 'runs', `${condition}-${task.id}-${rep}.jsonl`); writeFileSync(transcript.replace(/\.jsonl$/, '.prompt.txt'), prompt);
          const run = await runClaude({ cwd: repo, prompt, transcript, ...config });
          const graderFile = join(out, `grader-${task.id}.mjs`); writeFileSync(graderFile, task.grader);
          let grade; try { grade = JSON.parse(execFileSync(process.execPath, [graderFile, repo], { encoding: 'utf8', timeout: 120000, stdio: 'pipe' }).trim().split('\n').at(-1)); } catch (error) { grade = { pass: false, trap: 'grader-error', detail: String(error.message).slice(0, 300) }; }
          appendFileSync(resultsFile, JSON.stringify({ key, condition, task: task.id, rep, exit: run.code, wallMs: run.wallMs, contextBytes, ...parseTranscript(readFileSync(transcript, 'utf8')), grade }) + '\n');
          console.log(`${key} pass=${grade.pass} trap=${grade.trap ?? ''}`);
        }
      } finally { store?.close(); }
    }));
    return;
  }
  if (command === 'report') {
    const manifest = existsSync(join(out, 'manifest.json')) ? JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) : { maintenance: {} };
    const rows = existsSync(join(out, 'results.jsonl')) ? readFileSync(join(out, 'results.jsonl'), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
    const result = evaluate(rows, suite.tasks, manifest.maintenance, { ...DEFAULT_CRITERIA, ...suite.criteria });
    const mean = values => { const v = values.filter(x => typeof x === 'number'); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    const lines = [`# ${suite.name} benchmark report`, '', `Verdict: **${result.verdict}**`, '', ...result.reasons.map(r => `- ${r}`), '', '| Task | Kind | ' + CONDITIONS.join(' | ') + ' |', '| --- | --- | ' + CONDITIONS.map(() => '---').join(' | ') + ' |'];
    for (const task of suite.tasks) lines.push(`| ${task.id}${task.differentiating ? ' *' : ''} | ${task.kind ?? ''} | ${CONDITIONS.map(c => { const r = rows.filter(x => x.task === task.id && x.condition === c); const p = r.filter(x => x.grade.pass).length; const ci = wilson(p, r.length); return r.length ? `${p}/${r.length} (${(ci.low * 100).toFixed(0)}–${(ci.high * 100).toFixed(0)}%)` : '–'; }).join(' | ')} |`);
    lines.push('', '* differentiating task', '', '| Mean per run | ' + CONDITIONS.join(' | ') + ' |', '| --- | ' + CONDITIONS.map(() => '---').join(' | ') + ' |');
    for (const [label, key] of [['Tool calls', 'toolCalls'], ['Tool calls before first edit tool', 'toolsBeforeEditTool'], ['Input tokens', 'inputTokens'], ['Cost (USD)', 'costUsd'], ['Context bytes', 'contextBytes']]) lines.push(`| ${label} | ${CONDITIONS.map(c => { const m = mean(rows.filter(r => r.condition === c).map(r => r[key])); return m === null ? '–' : m.toFixed(key === 'costUsd' ? 3 : 1); }).join(' | ')} |`);
    lines.push('', `Operator-typed characters to set up knowledge: ${CONDITIONS.map(c => `${c} ${manifest.maintenance?.[c] ?? '–'}`).join(', ')}.`);
    writeFileSync(join(out, 'report.md'), lines.join('\n') + '\n'); writeFileSync(join(out, 'summary.json'), JSON.stringify(result, null, 2)); console.log(lines.join('\n'));
    return;
  }
  throw new Error(`Unknown command ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
