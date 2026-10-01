// Manual, offline retrieval pilot. No native CLI, model requests or scheduled job.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { JournalStore } from '../src/core/store.mjs';

const raw = readFileSync(new URL('../fixtures/memory-pilot.json', import.meta.url), 'utf8');
const corpus = JSON.parse(raw);
mkdirSync(resolve('.cache/tmp'), { recursive: true });
const root = mkdtempSync(resolve('.cache/tmp', 'memory-pilot-'));
const store = new JournalStore(resolve(root, 'journal.sqlite'));
const projects = new Map(); const labels = new Map(); const rows = [];
try {
  for (const name of ['commerce', 'desktop']) {
    const repo = resolve(root, name); mkdirSync(repo); mkdirSync(resolve(repo, 'policies'));
    const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' });
    git('init', '-b', 'main');
    for (const claim of corpus.claims.filter(x => x.project === name)) writeFileSync(resolve(repo, 'policies', claim.id + '.md'), claim.statement + '\n');
    git('add', 'policies'); git('-c', 'user.name=Pilot Fixture', '-c', 'user.email=pilot@example.test', 'commit', '-m', 'Frozen policies');
    const project = store.openProject(repo); projects.set(name, { project, repo, git });
    for (const claim of corpus.claims.filter(x => x.project === name)) {
      if (claim.branch) git('switch', '-c', claim.branch);
      const memory = store.proposeMemory(project.id, { statement: claim.statement, category: claim.category, scope: claim.scope ?? 'branch', area: claim.area ?? '', source: { kind: 'file', path: 'policies/' + claim.id + '.md', startLine: 1, endLine: 1 } });
      labels.set(memory.id, claim);
      if (claim.status !== 'candidate') store.setMemoryStatus(memory.id, 'active');
      if (claim.status === 'archived') store.setMemoryStatus(memory.id, 'archived');
      if (claim.branch) git('switch', 'main');
    }
    for (const claim of corpus.claims.filter(x => x.project === name && x.stale)) writeFileSync(resolve(repo, 'policies', claim.id + '.md'), 'Policy superseded; review required.\n');
  }
  let hits = 0; let supplied = 0; let wanted = 0; let unsafe = 0;
  for (const task of corpus.tasks) {
    const started = performance.now();
    const receipt = store.prepareContext(projects.get(task.project).project.id, task.query);
    const actual = receipt.items.map(item => labels.get(item.id).id);
    const forbidden = receipt.items.filter(item => { const c = labels.get(item.id); return c.project !== task.project || c.stale || c.branch || c.status === 'candidate' || c.status === 'archived'; });
    const correct = actual.filter(id => task.expected.includes(id));
    hits += correct.length; supplied += actual.length; wanted += task.expected.length; unsafe += forbidden.length;
    rows.push({ task: task.id, expected: task.expected, actual, missed: task.expected.filter(id => !actual.includes(id)), extra: actual.filter(id => !task.expected.includes(id)), unsafe: forbidden.length, packetBytes: Buffer.byteLength(receipt.packet), retrievalMs: Number((performance.now() - started).toFixed(2)) });
  }
  const result = { corpusSHA256: createHash('sha256').update(raw).digest('hex'), claims: corpus.claims.length, tasks: rows.length, metrics: { relevantHits: hits, expectedClaims: wanted, suppliedClaims: supplied, precision: supplied ? hits / supplied : null, recall: wanted ? hits / wanted : null, unsafeClaims: unsafe, emptyNegativeTasks: rows.filter(r => !r.expected.length && !r.actual.length).length, maxPacketBytes: Math.max(...rows.map(r => r.packetBytes)) }, rows };
  mkdirSync(resolve('.cache/memory-pilot'), { recursive: true });
  writeFileSync(resolve('.cache/memory-pilot/result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (unsafe) process.exitCode = 1;
} finally { store.close(); rmSync(root, { recursive: true, force: true }); }
