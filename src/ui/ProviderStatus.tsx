import { PROVIDER_NAMES, type AgentInfo, type Provider } from './types';
import { AgentRow, type ProviderHandlers } from './AgentRow';
import { agentRow } from './firstRunModel';
import { providers as words } from './copy';

// Cursor's two extra hints: the CLI Journal uses is off PATH, or it has no modes.
export function cursorHints(agent: AgentInfo | undefined) {
  if (!agent?.available) return [];
  return [agent.onPath === false && agent.path ? words.cursorOffPath(agent.path) : null, agent.supports && !agent.supports.mode ? words.cursorNoModes : null].filter((hint): hint is string => !!hint);
}

// A provider's row in the New session view, shown only when something needs the user:
// not installed, needs a sign-in, can't be used, a hint, or a note after an install or
// sign-in. A quiet sign-in (status unknown) alone does not show it. Phase 4's composer
// cards take this over; the region keeps its name ("Cursor provider status").
export function ProviderStatus({ provider, agent, busy, note, handlers }: { provider: Provider; agent: AgentInfo | undefined; busy: boolean; note: string; handlers: ProviderHandlers }) {
  if (!agent || agent.state === 'checking') return null;
  const row = agentRow(agent, provider);
  const hints = provider === 'cursor' ? cursorHints(agent) : [];
  if (row.tone !== 'warn' && (!row.action || row.quietLogin) && !hints.length && !note) return null;
  return <section className="provider-status" aria-label={`${PROVIDER_NAMES[provider]} provider status`}>
    <AgentRow provider={provider} agent={agent} busy={busy} hints={hints} note={note} handlers={handlers} />
  </section>;
}

// Cursor's status in the New session view (a thin wrapper kept for its callers).
export function CursorStatus(props: { agent: AgentInfo | undefined; busy: boolean; note: string; handlers: ProviderHandlers }) {
  return <ProviderStatus provider="cursor" {...props} />;
}
