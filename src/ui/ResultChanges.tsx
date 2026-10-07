import { useState } from 'react';
import { api } from './types';
import type { RunResult } from './TeamPanel';

export function ResultChanges({ result }: { result: RunResult }) {
  const [selected, setSelected] = useState('');
  const [diff, setDiff] = useState<{ patch: string; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async (path: string) => {
    setSelected(path); setDiff(null); setError(''); setBusy(true);
    try { setDiff(await api('resultDiff', { resultId: result.id, path })); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <details className="team-result-changes"><summary>Changed files ({result.changedFiles?.length ?? 0})</summary>
    <p>Captured tree {result.treeOid.slice(0, 12)}. Later worker edits are not included.</p>
    <ul>{result.changedFiles?.map(file => <li key={file.path}><button disabled={busy} aria-pressed={selected === file.path} onClick={() => void load(file.path)}>{file.status} {file.path}</button></li>)}</ul>
    {busy && <p role="status">Loading captured changes…</p>}
    {error && <p role="alert">{error}</p>}
    {diff && <><pre tabIndex={0} aria-label={`Captured changes for ${selected}`}>{diff.patch || 'No textual changes in this file.'}</pre>{diff.truncated && <p role="status">This diff is truncated. Inspect the saved capture before applying.</p>}</>}
  </details>;
}
