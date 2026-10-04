import type { AgentInfo, Provider } from './types';
import { ProviderMark } from './ProviderMark';
import { actionLabel, actionName, agentRow } from './firstRunModel';
import { firstEnabled, useKeepFocus } from './useKeepFocus';
import { agentTitle } from './composerModel';
import { providers as words } from './copy';

// An action ('action') or a Check again ('check') in flight, per provider.
export type ProviderBusy = Partial<Record<Provider, 'action' | 'check' | false>>;
export interface ProviderHandlers { onInstall(provider: Provider): void; onLogin(provider: Provider): void; onInstallPage(provider: Provider): void; onCheck(provider: Provider): void }

// One provider (Phase 7, board 1): its mark, name, install and sign-in state, and at most
// one next action. Install and sign-in always run in a visible terminal after the user
// asks (install also asks for confirmation); the row never shows account details.
// Check again shows while the row is not signed in, so a fix made outside Journal is picked up;
// it reads Checking… while that check runs (rechecking). When an update removes the focused
// button, focus stays in the row. The note is an always-present live region (announced when set).
export function AgentRow({ provider, agent, busy, rechecking = false, hints = [], note, handlers }: {
  provider: Provider; agent: AgentInfo | undefined; busy: boolean; rechecking?: boolean; hints?: string[]; note?: string; handlers: ProviderHandlers;
}) {
  const row = agentRow(agent, provider);
  const run = { install: handlers.onInstall, login: handlers.onLogin, 'install-page': handlers.onInstallPage };
  const checking = !agent || agent.state === 'checking';
  const ref = useKeepFocus<HTMLDivElement>(firstEnabled);
  return <div ref={ref} tabIndex={-1} className={`agent-row tone-${row.tone}`}>
    <ProviderMark provider={provider} size={28} />
    <div className="agent-text">
      <span className="agent-name">{row.name}</span>
      <span className="agent-sub" title={agentTitle(agent)}>{row.tone !== 'muted' && <span className="agent-dot" aria-hidden="true" />}{row.sub}</span>
    </div>
    <div className="agent-actions">
      {row.action && <button className={row.quietLogin ? 'text-button' : undefined} disabled={busy} aria-label={actionName(row.action, row.name)}
        onClick={() => run[row.action!](provider)}>{actionLabel(row.action)}</button>}
      {row.tone !== 'ok' && !checking && <CheckAgain name={row.name} busy={busy} rechecking={rechecking} onCheck={() => handlers.onCheck(provider)} />}
    </div>
    {row.hint && <p className="agent-hint">{row.hint}</p>}
    {hints.map(hint => <p className="agent-hint" key={hint}>{hint}</p>)}
    <p className="agent-hint agent-note" role="status">{note ?? ''}</p>
  </div>;
}

// Check again, or Checking… while it runs. It stays focusable while checking (aria-disabled,
// not disabled), so a keyboard user's focus is not dropped mid-check.
export function CheckAgain({ name, busy, rechecking, onCheck }: { name: string; busy: boolean; rechecking: boolean; onCheck(): void }) {
  return <button type="button" className="text-button" disabled={busy && !rechecking} aria-disabled={rechecking || undefined}
    aria-label={rechecking ? words.checkingName(name) : words.checkAgainName(name)} onClick={() => { if (!rechecking) onCheck(); }}>{rechecking ? words.checking : words.checkAgain}</button>;
}
