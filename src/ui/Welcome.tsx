import type { AgentInfo, Bootstrap, Provider } from './types';
import { AgentRow, type ProviderHandlers } from './AgentRow';
import { cursorHints } from './ProviderStatus';
import { firstRun } from './copy';

const ORDER: Provider[] = ['claude', 'codex', 'cursor'];

// Board 1: shown while no project is open (first launch, or after removing the current one).
// Open a project, or drop a Git folder on the window (App handles the drop). The agent rows
// say honestly what is installed and signed in; nothing here starts an agent.
export function Welcome({ mark, agents, shortcut, busy, providerBusy, notes, dragging, dropError, handlers, onOpen }: {
  mark: string; agents: AgentInfo[] | undefined; shortcut: Bootstrap['shortcuts']['open-project'];
  busy: boolean; providerBusy: Partial<Record<Provider, boolean>>; notes: Partial<Record<Provider, string>>;
  dragging: boolean; dropError: string; handlers: ProviderHandlers; onOpen(): void;
}) {
  return <section className={`welcome${dragging ? ' dragging' : ''}`} aria-labelledby="welcome-title">
    <div className="welcome-inner">
      <img className="welcome-mark" src={mark} alt="" width={64} height={64} />
      <h1 id="welcome-title">{firstRun.welcomeTitle}</h1>
      <p className="welcome-body">{firstRun.welcomeBody}</p>
      <div className="welcome-open">
        <button className="primary welcome-primary" onClick={onOpen} disabled={busy} aria-keyshortcuts={shortcut?.aria}>{firstRun.openProject}{shortcut && <kbd aria-hidden="true">{shortcut.label}</kbd>}</button>
        <span className="welcome-hint">{dragging ? firstRun.dropHere : firstRun.openHint}</span>
        {dropError && <p className="form-error" role="alert">{dropError}</p>}
      </div>
      <section className="agent-list" aria-labelledby="agents-heading">
        <div className="agent-list-heading"><h2 id="agents-heading">{firstRun.agentsHeading}</h2><span>{firstRun.agentsHint}</span></div>
        <ul aria-label={firstRun.agentsHeading}>{ORDER.map(provider => {
          const agent = agents?.find(a => a.provider === provider);
          return <li key={provider}><AgentRow provider={provider} agent={agent} busy={!!providerBusy[provider]} hints={provider === 'cursor' ? cursorHints(agent) : []} note={notes[provider]} handlers={handlers} /></li>;
        })}</ul>
      </section>
      <p className="welcome-local"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></svg>{firstRun.localOnly}</p>
    </div>
  </section>;
}
