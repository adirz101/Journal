import type { AgentInfo, Provider } from './types';
import { ProviderMark } from './ProviderMark';
import { actionName, agentRow } from './firstRunModel';
import { providers as words } from './copy';

export interface ProviderHandlers { onInstall(provider: Provider): void; onLogin(provider: Provider): void; onInstallPage(provider: Provider): void; onCheck(provider: Provider): void }

// One provider (Phase 7, board 1): its mark, name, install and sign-in state, and at most
// one next action. Install and sign-in always run in a visible terminal after the user
// asks (install also asks for confirmation); the row never shows account details.
// Check again shows while the row is not signed in, so a fix made outside Journal is picked up.
export function AgentRow({ provider, agent, busy, hints = [], note, handlers }: {
  provider: Provider; agent: AgentInfo | undefined; busy: boolean; hints?: string[]; note?: string; handlers: ProviderHandlers;
}) {
  const row = agentRow(agent, provider);
  const run = { install: handlers.onInstall, login: handlers.onLogin, 'install-page': handlers.onInstallPage };
  const checking = !agent || agent.state === 'checking';
  return <div className={`agent-row tone-${row.tone}`}>
    <ProviderMark provider={provider} size={28} />
    <div className="agent-text">
      <span className="agent-name">{row.name}</span>
      <span className="agent-sub">{row.tone !== 'muted' && <span className="agent-dot" aria-hidden="true" />}{row.sub}</span>
    </div>
    <div className="agent-actions">
      {row.action && <button className={row.quietLogin ? 'text-button' : undefined} disabled={busy} aria-label={actionName(row.action, row.name)}
        onClick={() => run[row.action!](provider)}>{row.action === 'install' ? words.install : row.action === 'login' ? words.signIn : words.openInstallPage}</button>}
      {row.tone !== 'ok' && !checking && <button className="text-button" disabled={busy} aria-label={words.checkAgainName(row.name)} onClick={() => handlers.onCheck(provider)}>{words.checkAgain}</button>}
    </div>
    {row.hint && <p className="agent-hint">{row.hint}</p>}
    {hints.map(hint => <p className="agent-hint" key={hint}>{hint}</p>)}
    {note && <p className="agent-hint agent-note" role="status">{note}</p>}
  </div>;
}
