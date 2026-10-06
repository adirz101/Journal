import { useEffect, useState } from 'react';
import { api } from './types';
type Candidate = { id: string; statement: string; status: string; scope: string; branch: string | null; origin?: { resultId?: string; applied?: boolean } };
export function RunMemory({ ids }: { ids: string[] }) {
  const [notes, setNotes] = useState<Candidate[]>([]); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const key = ids.join(',');
  useEffect(() => { let alive = true; void Promise.all(ids.map(id => api<Candidate>('getMemory', { id }))).then(rows => { if (alive) setNotes(rows); }).catch(error => { if (alive) setError(error.message); }); return () => { alive = false; }; }, [key]);
  const decide = async (id: string, status: string) => { setBusy(true); setError(''); try { const note = await api<Candidate>('setMemoryStatus', { id, status }); setNotes(rows => rows.map(row => row.id === id ? note : row)); } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  if (!ids.length) return null;
  return <section aria-label="Proposed project memory"><h4>Proposed project memory</h4><p className="field-help">Review each statement before remembering it. Notes from unapplied results stay tied to their worker folder.</p>{error && <p role="alert">{error}</p>}<ul className="team-list">{notes.map(note => <li key={note.id}><p dir="auto">{note.statement}</p><small>{note.scope === 'branch' ? `Branch ${note.branch}` : 'Project'} · {note.status === 'active' ? 'Remembered' : note.status === 'candidate' ? 'Needs your review' : 'Rejected'} · Result {note.origin?.resultId?.slice(0, 8)}{note.origin?.applied ? ' · Applied to branch' : ' · Not applied to branch'}</small>{note.status === 'candidate' && <div className="team-actions"><button disabled={busy} onClick={() => void decide(note.id, 'active')}>Remember</button><button disabled={busy} onClick={() => void decide(note.id, 'rejected')}>Reject note</button></div>}</li>)}</ul></section>;
}
