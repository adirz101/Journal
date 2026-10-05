import { useEffect, useState } from 'react';
import { api } from './types';
import { cursorHooks as text } from './copy';

type Status = { state: string; path: string; available: boolean };
type Plan = { id: string; action: 'install' | 'remove'; path: string; before: string | null; after: string | null; refused: string | null; changed: boolean };

// Cursor level 2 (plan 4.6). Nothing is written until the user has seen the exact before and
// after text of the change and pressed the button under it; main applies only that plan, by ID.
export function CursorHooksSetting({ onError }: { onError: (error: unknown) => void }) {
  const [status, setStatus] = useState<Status | null>(null); const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState(false); const [note, setNote] = useState('');
  const load = () => api<Status>('cursorHooksStatus').then(setStatus).catch(onError);
  useEffect(() => { void load(); }, []);
  const show = async (action: Plan['action']) => {
    setNote(''); setBusy(true);
    try { setPlan(await api<Plan>('cursorHooksPlan', { action })); } catch (error) { onError(error); } finally { setBusy(false); }
  };
  const apply = async () => {
    if (!plan) return; setBusy(true);
    try {
      const result = await api<{ applied: boolean; reason?: string }>('cursorHooksApply', { id: plan.id });
      setNote(result.applied ? (plan.action === 'install' ? text.done : text.removed) : text.refusedState[result.reason ?? ''] ?? text.nothingToChange);
      setPlan(null); await load();
    } catch (error) { onError(error); } finally { setBusy(false); }
  };
  if (!status) return null;
  const installed = status.state === 'installed';
  const summary = !status.available ? text.unavailable : installed ? text.installed : status.state === 'not-installed' ? text.notInstalled : text.refusedState[status.state] ?? text.notInstalled;
  return <section className="settings-section" aria-labelledby="settings-cursor-hooks"><h3 id="settings-cursor-hooks">{text.title}</h3>
    <p className="hint">{text.intro}</p>
    <p role="status">{note || summary}</p>
    {!plan && status.available && <div className="settings-actions">
      {installed ? <button disabled={busy} onClick={() => void show('remove')}>{text.showRemoval}</button>
        : (status.state === 'not-installed') && <button disabled={busy} onClick={() => void show('install')}>{text.show}</button>}
    </div>}
    {plan && <div className="cursor-hooks-plan">
      <p>{text.file}: <code>{plan.path}</code></p>
      {plan.refused ? <p role="alert">{text.refusedState[plan.refused] ?? text.nothingToChange}</p>
        : !plan.changed ? <p>{text.nothingToChange}</p>
        : <>
          <p className="cursor-hooks-label">{text.before}</p><pre className="cursor-hooks-text" tabIndex={0}>{plan.before ?? text.created}</pre>
          <p className="cursor-hooks-label">{text.after}</p><pre className="cursor-hooks-text" tabIndex={0}>{plan.after}</pre>
        </>}
      <div className="settings-actions">
        {!plan.refused && plan.changed && <button disabled={busy} onClick={() => void apply()}>{plan.action === 'install' ? text.apply : text.applyRemoval}</button>}
        <button disabled={busy} onClick={() => setPlan(null)}>{text.cancel}</button>
      </div>
    </div>}
  </section>;
}
