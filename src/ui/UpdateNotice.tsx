import { useEffect, useState } from 'react';
import { api, type UpdateState } from './types';

// Update state from the main process (null until known; status 'off' in
// development builds and tests).
export function useUpdateState() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let cancelled = false;
    void api<UpdateState>('updateStatus').then(next => { if (!cancelled) setState(next); }).catch(() => {});
    const off = window.journal?.onEvent(event => { if (event.type === 'update') setState(event.state); });
    return () => { cancelled = true; off?.(); };
  }, []);
  return state;
}

// Sidebar notice, shown only when there is something to do: a download in
// progress, an update ready to install, or a version to download by hand (the
// portable build). Journal never restarts on its own.
export function UpdateNotice({ state, onError }: { state: UpdateState | null; onError: (error: unknown) => void }) {
  // Pending covers the session question; the main process reports the shutdown itself.
  const [pending, setPending] = useState(false); const [attempted, setAttempted] = useState(false);
  if (!state) return null;
  const installing = pending || state.installing;
  const install = async () => {
    setPending(true); setAttempted(true);
    try { await api('installUpdate'); } catch (error) { onError(error); } finally { setPending(false); }
  };
  if (state.status === 'downloading') return <div className="update-notice" role="status"><p>Downloading Journal {state.version}… {state.percent ?? 0}%</p></div>;
  if (state.status === 'ready') return <div className="update-notice" role="status"><p>Journal {state.version} is ready.</p>
    <button className="primary" disabled={installing} onClick={() => void install()}>{installing ? 'Restarting…' : 'Restart to update'}</button></div>;
  if (state.status === 'available') return <div className="update-notice" role="status"><p>Journal {state.version} is available.</p>
    <button onClick={() => void api('openUpdateRelease').catch(onError)}>Download</button></div>;
  if (state.status === 'error' && attempted) return <div className="update-notice" role="alert"><p>The update could not be installed: {state.message ?? 'unknown error'}</p></div>;
  return null;
}

// Updates section of the data dialog: version, manual check, automatic checks.
export function UpdateSettings({ state }: { state: UpdateState | null }) {
  const [checked, setChecked] = useState(false); const [error, setError] = useState('');
  if (!state) return null;
  if (state.status === 'off') return <section className="update-settings"><h3>Updates</h3><p className="muted">Journal {state.current}. Updates are available in installed builds only.</p></section>;
  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const check = () => { setChecked(true); setError(''); void api('checkForUpdates').catch(fail); };
  const busy = state.status === 'checking' || state.status === 'downloading';
  const result = !checked ? null
    : state.status === 'checking' ? 'Checking…'
    : state.status === 'none' ? 'Journal is up to date.'
    : state.status === 'downloading' ? `Downloading Journal ${state.version}… ${state.percent ?? 0}%`
    : state.status === 'ready' ? `Journal ${state.version} is ready. Use “Restart to update” in the sidebar.`
    : state.status === 'available' ? `Journal ${state.version} is available. Use “Download” in the sidebar.`
    : state.status === 'error' ? `Could not check for updates: ${state.message ?? 'unknown error'}` : null;
  return <section className="update-settings"><h3>Updates</h3>
    <p className="muted">Journal {state.current}. {state.mode === 'auto' ? 'New versions download in the background and install when you restart Journal from the sidebar.' : 'This portable build cannot update itself; Journal tells you when a new version is available.'}</p>
    <label className="inline-check"><input type="checkbox" checked={state.automatic} onChange={event => void api('setAutomaticUpdates', { enabled: event.target.checked }).catch(fail)} /> Check for updates automatically</label>
    <div className="brief-actions"><button disabled={busy || state.status === 'ready'} onClick={check}>Check for updates</button></div>
    {result && <p className="hint" role="status">{result}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}
