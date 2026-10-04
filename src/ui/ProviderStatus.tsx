import { PROVIDER_NAMES, type AgentInfo, type Provider } from './types';
import { agentRow } from './firstRunModel';
import { providers as words } from './copy';

// Cursor's two extra hints: the CLI Journal uses is off PATH, or it has no modes.
export function cursorHints(agent: AgentInfo | undefined) {
  if (!agent?.available) return [];
  return [agent.onPath === false && agent.path ? words.cursorOffPath(agent.path) : null, agent.supports && !agent.supports.mode ? words.cursorNoModes : null].filter((hint): hint is string => !!hint);
}

// An agent's details under the composer's cards (region "<name> provider status"): what its
// card has no room for. The card already shows the state and the one next action (install,
// install page or sign-in); this adds the row's explanation, Cursor's hints, what the last
// install or sign-in changed, and Check again while the agent needs the user. It renders
// nothing when there is nothing to add (a quiet sign-in alone, or a ready agent).
export function ProviderStatus({ provider, agent, busy, note, onCheck }: { provider: Provider; agent: AgentInfo | undefined; busy: boolean; note: string; onCheck(provider: Provider): void }) {
  const checking = !agent || agent.state === 'checking';
  const row = agentRow(agent, provider);
  const hints = [row.hint, ...(provider === 'cursor' ? cursorHints(agent) : [])].filter((hint): hint is string => !!hint);
  const needsYou = !checking && (row.tone === 'warn' || (!!row.action && !row.quietLogin));
  if (!needsYou && !hints.length && !note) return null;
  return <section className="provider-status" aria-label={`${PROVIDER_NAMES[provider]} provider status`}>
    {hints.map(hint => <p className="agent-hint" key={hint}>{hint}</p>)}
    {note && <p className="agent-hint agent-note" role="status">{note}</p>}
    {needsYou && <button type="button" className="text-button" disabled={busy} aria-label={words.checkAgainName(row.name)} onClick={() => onCheck(provider)}>{words.checkAgain}</button>}
  </section>;
}
