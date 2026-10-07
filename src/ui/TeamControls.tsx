import { useEffect, useState } from 'react';
import { api } from './types';
import type { TeamRun, RunAttempt } from './TeamPanel';
export type TeamAction = (action: string, input: object) => Promise<boolean>;
export function TaskForm({ run, act, busy }: { run: TeamRun; act: TeamAction; busy: boolean }) {
  const [title, setTitle] = useState(''); const [goal, setGoal] = useState(''); const [dependency, setDependency] = useState(''); const [variants, setVariants] = useState(1);
  return <details className="team-form"><summary>Add task</summary><form onSubmit={event => { event.preventDefault(); void act('createTask', { title, goal: goal || title, dependencies: dependency ? [dependency] : [], variants: variants > 1 ? variants : 0 }).then(ok => { if (ok) { setTitle(''); setGoal(''); } }); }}>
    <label>Title<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label>Goal<textarea value={goal} maxLength={20000} onChange={event => setGoal(event.target.value)} /></label>
    <label>Wait for integration of<select value={dependency} onChange={event => setDependency(event.target.value)}><option value="">No dependency</option>{run.tasks.map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
    <label>Alternatives<input type="number" min={1} max={8} value={variants} onChange={event => setVariants(Number(event.target.value))} /></label><button disabled={busy || !title.trim()}>Add task</button><p className="field-help">Adding a task does not start a worker.</p>
  </form></details>;
}
export function WorkerControls({ attempt, run, act, busy }: { attempt: RunAttempt; run: TeamRun; act: TeamAction; busy: boolean }) {
  const [reason, setReason] = useState(''); const [provider, setProvider] = useState(attempt.provider); const [from, setFrom] = useState('base');
  const [subjectResultId, setSubjectResultId] = useState('');
  const settled = ['idle', 'ready', 'result_available', 'blocked', 'conflict', 'waiting_for_coordinator', 'integrated', 'launch_failed'].includes(attempt.state);
  return <div className="team-actions">
    {attempt.presence === 'live' && <button disabled={busy} onClick={() => void act('stop', { attemptId: attempt.id })}>Stop worker</button>}
    {attempt.presence === 'paused' && settled && attempt.currentSessionId && <button disabled={busy} onClick={() => void act('resume', { attemptId: attempt.id })}>Continue conversation</button>}
    {['requested', 'queued'].includes(attempt.state) && <button disabled={busy} onClick={() => void act('retireWorker', { attemptId: attempt.id, reason: 'Cancelled by user' })}>Cancel request</button>}
    {attempt.presence === 'paused' && settled && <button disabled={busy} onClick={() => void act('takeIn', { attemptId: attempt.id })}>Take in branch changes</button>}
    {attempt.presence === 'paused' && settled && run.tasks.some(task => task.id === attempt.taskId && task.kind === 'review') && <div><label>Recheck result<select value={subjectResultId} onChange={event => setSubjectResultId(event.target.value)}><option value="">Choose a captured result</option>{run.results.filter(result => result.attemptId !== attempt.id).map(result => <option key={result.id} value={result.id}>{result.id.slice(0, 8)} · {result.status}</option>)}</select></label><button disabled={busy || !subjectResultId} onClick={() => void act('takeIn', { attemptId: attempt.id, subjectResultId })}>Prepare recheck</button></div>}
    {settled && <details><summary>Retry or retire</summary><label>Reason<textarea value={reason} onChange={event => setReason(event.target.value)} maxLength={2000} /></label><label>Provider<select value={provider} onChange={event => setProvider(event.target.value)}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option></select></label><label>Start from<select value={from} onChange={event => setFrom(event.target.value)}><option value="base">Current branch</option><option value="result" disabled={!attempt.currentResultId}>Captured result</option><option value="environment" disabled={attempt.presence !== 'paused'}>Existing worker folder</option></select></label><button disabled={busy || !reason.trim()} onClick={() => void act('retry', { attemptId: attempt.id, provider, from, reason })}>Request retry</button><button disabled={busy || !reason.trim() || attempt.presence !== 'paused'} onClick={() => void act('retireWorker', { attemptId: attempt.id, reason })}>Retire worker</button></details>}
  </div>;
}
interface Capacity { live: number; reserved: number; sample: { availableBytes?: number; totalBytes?: number; pressure?: string; freeDiskBytes?: number; limitations?: string[] }; warnings: string[]; queued: RunAttempt[]; }
const gb = (bytes?: number) => bytes == null ? 'Unknown' : `${(bytes / 1e9).toFixed(1)} GB`;
export function ResourceNotice({ connected = true }: { connected?: boolean }) {
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    if (!connected) { setWarnings([]); return; }
    let active = true;
    const load = () => void api<Capacity>('getCapacity', {}).then(value => { if (active) setWarnings(value.warnings ?? []); }).catch(() => { if (active) setWarnings(['RESOURCE_UNKNOWN']); });
    load(); const timer = setInterval(load, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [connected]);
  const notice = warnings.includes('MEMORY_PRESSURE') ? 'Memory pressure is high. You can still start sessions; running and idle agents stay open.'
    : warnings.includes('RESOURCE_UNKNOWN') ? 'Some resource measurements are unavailable. You can still start sessions.' : null;
  return notice ? <p className="field-help" role="status">{notice}</p> : null;
}
export function CapacityView({ run }: { run: TeamRun }) {
  const [capacity, setCapacity] = useState<Capacity | null>(null); const [error, setError] = useState('');
  useEffect(() => { let active = true; const load = () => void api<Capacity>('getCapacity', { runId: run.id }).then(value => { if (active) { setCapacity(value); setError(''); } }).catch(error => { if (active) setError(error.message); }); load(); const timer = setInterval(load, 5000); return () => { active = false; clearInterval(timer); }; }, [run.id]);
  if (!capacity) return <p role="status">{error || 'Reading resources…'}</p>;
  return <><h3>Sessions and resources</h3><p>{capacity.live} live · {capacity.reserved} starting</p>
    <p className="field-help">Sessions start on demand. Idle agents stay open until you stop them. Resource readings are advisory.</p>
    <dl className="team-policy"><div><dt>Available memory</dt><dd>{gb(capacity.sample.availableBytes)}</dd></div><div><dt>Memory pressure</dt><dd>{capacity.sample.pressure ?? 'Unknown'}</dd></div><div><dt>Free disk</dt><dd>{gb(capacity.sample.freeDiskBytes)}</dd></div></dl>
    {capacity.sample.limitations?.map(line => <p key={line} className="field-help">{line}</p>)}
    {error && <p role="status">{error}</p>}
    <h3>Requested workers</h3><ol>{capacity.queued.map(attempt => <li key={attempt.id}>{run.tasks.find(task => task.id === attempt.taskId)?.title}: {attempt.admission?.reasons?.filter(reason => !['GLOBAL_CAP', 'RUN_CAP', 'MEMORY', 'MEMORY_PRESSURE', 'RESOURCE_UNKNOWN', 'CPU', 'DISK'].includes(reason)).join(', ') || 'Waiting to start'}</li>)}</ol></>;
}
export function PolicyForm({ run, act, busy }: { run: TeamRun; act: TeamAction; busy: boolean }) {
  const [policy, setPolicy] = useState(run.policy);
  useEffect(() => setPolicy(run.policy), [run.policy.version]);
  return <form className="team-form" onSubmit={event => { event.preventDefault(); void act('setRunPolicy', { policy: { integration: policy.integration, guards: policy.guards } }); }}><h3>Run policy</h3>
    <label>Apply results<select value={policy.integration} onChange={event => setPolicy({ ...policy, integration: event.target.value })}><option value="coordinator-managed">Coordinator decides</option><option value="ask">Ask before every Apply</option></select></label>
    {Object.entries(policy.guards).map(([key, value]) => <label key={key}>{key.replaceAll('_', ' ')}<select value={value} onChange={event => setPolicy({ ...policy, guards: { ...policy.guards, [key]: event.target.value } })}><option value="allow">Allow</option><option value="ask">Ask before applying</option><option value="refuse">Refuse</option></select></label>)}
    <p className="field-help">Native permissions remain unchanged. Saving policy invalidates pending Apply approvals.</p><button disabled={busy}>Save policy</button>
  </form>;
}
