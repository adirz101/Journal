import { useCallback, useEffect, useState } from 'react';
import { api, type ApplyPreview, type Environment, type Session } from './types';
import { count, isolation as copy } from './copy';

// An isolated session's environment in the Session tab: where it came from, its result, and the
// previewed Apply. Facts come from the environment record and the Apply preview (environments.mjs);
// nothing here decides or writes on its own. Internal paths and refs only under Details.
const shortSha = (sha: string | null | undefined) => (sha ?? '').slice(0, 7);
const MAX_FILES = 12;

export function EnvironmentPanel({ session, onError }: { session: Session; onError(message: string): void }) {
  const id = session.environmentId ?? null;
  const [environment, setEnvironment] = useState<Environment | null>(null);
  const [preview, setPreview] = useState<ApplyPreview | null>(null); const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false); const [confirmAbandon, setConfirmAbandon] = useState(false);
  const [resolved, setResolved] = useState<string[] | null>(null); const [kept, setKept] = useState(false); const [confirmRemove, setConfirmRemove] = useState(false);
  const load = useCallback(() => { if (id) void api<Environment>('environment', { id }).then(setEnvironment).catch(() => setEnvironment(null)); }, [id]);
  useEffect(() => { setPreview(null); setPreviewing(false); setConfirmAbandon(false); setResolved(null); setKept(false); setConfirmRemove(false); load(); }, [load]);
  useEffect(() => window.journal?.onEvent(event => { if (event.type === 'environment' && (!event.environment || event.environment.id === id)) { if (event.environment) setEnvironment(event.environment); else load(); } }), [id, load]);
  if (!id || !environment) return null;
  const run = async (action: () => Promise<unknown>) => { setBusy(true); try { await action(); } catch (error) { onError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); load(); } };
  const openPreview = () => run(async () => { setPreview(await api<ApplyPreview>('previewEnvironmentApply', { id })); setPreviewing(true); });
  const apply = () => run(async () => { await api('applyEnvironment', { id, expect: preview?.expect }); setPreviewing(false); setPreview(null); });
  const branch = environment.logicalBranch; const state = environment.state;
  const done = state === 'completed' || state === 'conflict';
  const applied = !!environment.integration && environment.integration.phase === 'done';
  return <section className="environment-panel panel-content" aria-labelledby="environment-heading">
    <div className="section-heading"><div><h2 id="environment-heading">{copy.heading}</h2><small className="muted">{copy.from(branch, shortSha(environment.base))}</small></div></div>
    <p className="environment-state" role="status">{applied ? copy.applied(branch, shortSha(environment.integration?.commit)) : copy.state(state, branch)}</p>
    {environment.result && !applied && <p className="muted">{copy.result(environment.result.fileCount)}{environment.result.excluded.length ? ` ${copy.excluded(environment.result.excluded.length)}` : ''}</p>}
    {state === 'conflict' && environment.conflict && <div className="environment-conflict" role="alert">
      <p>{copy.conflict(branch, environment.conflict.paths.length)}</p>
      <ul>{environment.conflict.paths.slice(0, MAX_FILES).map(item => <li key={item.path}><code>{item.path}</code> <span className="muted">{item.kind}</span></li>)}</ul>
      {environment.conflict.inEnvironment && <p className="muted">{copy.resolveHere}</p>}
    </div>}
    {resolved !== null && <p className="muted" role="status">{resolved.length ? copy.tookInConflicts(branch, resolved.length) : copy.tookInClean(branch)}</p>}
    {previewing && preview && <div className="apply-preview" aria-label={copy.previewLabel(branch)}>
      <p>{preview.moved ? (preview.baseOnBranch ? copy.moved(branch, preview.commitsSince) : copy.rewritten(branch)) : copy.upToDate(branch)}{preview.moved && preview.clean ? ` ${copy.combined}` : ''}</p>
      {preview.clean ? <>
        <p>{copy.changes(preview.changes.length)}</p>
        <ul className="apply-files">{preview.changes.slice(0, MAX_FILES).map(change => <li key={change.path}><span className="change-status">{change.status}</span> <code>{change.path}</code></li>)}
          {preview.changes.length > MAX_FILES && <li className="muted">{copy.more(preview.changes.length - MAX_FILES)}</li>}</ul>
      </> : <p className="form-error">{copy.previewConflict(preview.conflicts.length)} {preview.conflicts.slice(0, MAX_FILES).map(item => item.path).join(', ')}</p>}
      {preview.switchedTo && <p className="muted">{copy.switched(preview.switchedTo)}</p>}
      {preview.unresolved.length > 0 && <p className="form-error">{copy.unresolved(preview.unresolved.length)} {preview.unresolved.slice(0, MAX_FILES).join(', ')}</p>}
      {preview.busy && <p className="form-error">{copy.busy(branch, preview.busy)}</p>}
      {preview.empty && <p className="muted">{copy.empty(branch)}</p>}
      {preview.blockedBy.length > 0 && <p className="form-error">{copy.blocked(preview.blockedBy.length)} {preview.blockedBy.slice(0, MAX_FILES).join(', ')}</p>}
      {preview.excluded.length > 0 && <p className="muted">{copy.excludedList(preview.excluded.join(', '))}</p>}
      <div className="environment-actions">
        <button type="button" className="primary" disabled={busy || !preview.canApply} onClick={() => void apply()}>{copy.applyNow(branch)}</button>
        {!preview.clean && environment.folder && <button type="button" disabled={busy} onClick={() => void run(async () => { const outcome = await api<{ conflicts: string[] }>('resolveInEnvironment', { id }); setResolved(outcome.conflicts); setPreviewing(false); setPreview(null); })}>{copy.resolve}</button>}
        <button type="button" disabled={busy} onClick={() => { setPreviewing(false); setPreview(null); }}>{copy.cancel}</button>
      </div>
    </div>}
    {!previewing && <div className="environment-actions">
      {done && <button type="button" className="primary" disabled={busy} onClick={() => void openPreview()}>{copy.apply(branch)}</button>}
      {state === 'conflict' && <button type="button" disabled={busy || !environment.folder} onClick={() => void run(async () => { const outcome = await api<{ conflicts: string[] }>('resolveInEnvironment', { id }); setResolved(outcome.conflicts); })}>{copy.resolve}</button>}
      {done && <button type="button" disabled={busy} onClick={() => setKept(true)}>{copy.keep}</button>}
      {done && !confirmAbandon && <button type="button" disabled={busy} onClick={() => setConfirmAbandon(true)}>{copy.abandon}</button>}
      {done && confirmAbandon && <><span className="muted">{copy.abandonConfirm}</span><button type="button" disabled={busy} onClick={() => void run(() => api('abandonEnvironment', { id }))}>{copy.abandonNow}</button><button type="button" onClick={() => setConfirmAbandon(false)}>{copy.cancel}</button></>}
      {(state === 'abandoned' || (state === 'removed' && !applied && environment.result) || (state === 'cleanup_pending' && !applied)) && environment.result && <button type="button" disabled={busy} onClick={() => void run(() => api('restoreEnvironment', { id }))}>{copy.restore}</button>}
      {state === 'cleanup_pending' && <button type="button" disabled={busy} onClick={() => void run(() => api('cleanupEnvironment', { id }))}>{copy.retryCleanup}</button>}
    </div>}
    {state === 'cleanup_pending' && environment.cleanup?.reason && <p className="muted">{copy.cleanupWaiting(environment.cleanup.reason)}</p>}
    {state === 'cleanup_pending' && environment.cleanup?.code === 'ignored' && <div className="environment-actions">
      {!confirmRemove ? <button type="button" disabled={busy} onClick={() => setConfirmRemove(true)}>{copy.removeAnyway}</button>
        : <><span className="muted">{copy.removeAnywayConfirm}</span><button type="button" disabled={busy} onClick={() => void run(async () => { await api('cleanupEnvironment', { id, removeIgnored: true }); setConfirmRemove(false); })}>{copy.removeAnyway}</button><button type="button" onClick={() => setConfirmRemove(false)}>{copy.cancel}</button></>}
    </div>}
    {done && kept && <p className="muted" role="status">{copy.keptForLater(branch)}</p>}
    <details className="environment-details"><summary>{copy.details}</summary>
      <dl>
        <dt>{copy.folder}</dt><dd><code>{environment.details.path}</code>{environment.folder ? '' : ` (${copy.removed})`}</dd>
        <dt>{copy.base}</dt><dd><code>{environment.base}</code></dd>
        {environment.result && <><dt>{copy.resultId}</dt><dd><code>{environment.result.id}</code></dd></>}
        <dt>{copy.ports}</dt><dd>{environment.ports[0]}–{environment.ports.at(-1)} ({count(environment.ports.length, 'port')})</dd>
        <dt>{copy.refs}</dt><dd><code>{environment.details.refs.result.replace(/\/result$/, '/*')}</code></dd>
      </dl>
      <p className="muted small-print">{copy.notSandbox}</p>
    </details>
  </section>;
}
