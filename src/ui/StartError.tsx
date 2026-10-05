import { useEffect, useState } from 'react';
import { providers, states } from './copy';
import { api, PROVIDER_NAMES } from './types';
import { keptText, terminalActionLabel, type StartProblem } from './statesModel';

// An agent that can't start (board 9, panel 3), above Start in the composer: what is wrong,
// the command to run, and Open terminal, Copy command and Check again. Open terminal runs
// main's constant-argv sign-in (or install) in a visible terminal; the renderer never builds
// argv, and Journal never handles the login. alert: from a refused start (announced at once);
// otherwise the agent's own status check said so (a polite status). Check again stays focusable
// while it runs (aria-disabled); when the card goes, the composer moves focus to Start.
export function StartError({ problem, alert, onOpenTerminal }: { problem: StartProblem; alert: boolean; onOpenTerminal: (() => void) | null }) {
  const [copied, setCopied] = useState<'done' | 'failed' | null>(null);
  const [checking, setChecking] = useState(false);
  const command = problem.kind === 'signed-out' || problem.kind === 'missing' ? problem.command : null;
  useEffect(() => { setCopied(null); }, [command]);
  const name = PROVIDER_NAMES[problem.provider];
  const body = problem.kind === 'signed-out' ? states.signInBody : problem.kind === 'missing' ? states.missingBody
    : problem.detail || (problem.kind === 'unsupported' ? states.unsupportedBody : '');
  const copy = async () => { try { await navigator.clipboard.writeText(command ?? ''); setCopied('done'); } catch { setCopied('failed'); } };
  // Check again asks main for a fresh check; the providers event updates the agent cards.
  const check = async () => { setChecking(true); try { await api('providerStatus', { provider: problem.provider, fresh: true }); } catch { /* the card stays */ } finally { setChecking(false); } };
  return <div className="start-error" role={alert ? 'alert' : 'status'} aria-labelledby="start-error-title">
    <p className="start-error-title" id="start-error-title">{states.cantStartTitle(name, problem.kind)}</p>
    {body && <p className="start-error-body">{body}</p>}
    {command && <code className="start-error-command">{command}</code>}
    <div className="start-error-actions">
      {onOpenTerminal && <button type="button" className="primary" onClick={onOpenTerminal}>{terminalActionLabel(problem)}</button>}
      {command && <button type="button" onClick={() => void copy()}>{copied === 'done' ? states.copied : copied === 'failed' ? states.copyFailed : states.copyCommand}</button>}
      <button type="button" className="ghost" aria-disabled={checking || undefined} onClick={() => { if (!checking) void check(); }}>{checking ? providers.checking : states.checkAgain}</button>
    </div>
    {alert && <p className="start-error-kept">{keptText(problem)}</p>}
  </div>;
}
