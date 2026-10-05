import { PROVIDER_NAMES, type AgentInfo, type Provider } from './types';
import { agentRow } from './firstRunModel';
import { CheckAgain } from './AgentRow';
import { firstEnabled, useKeepFocus } from './useKeepFocus';
import { providers as words } from './copy';

// Cursor's two extra hints: the CLI Journal uses is off PATH, or it has no modes.
export function cursorHints(agent: AgentInfo | undefined) {
  if (!agent?.available) return [];
  return [agent.onPath === false && agent.path ? words.cursorOffPath(agent.path) : null, agent.supports && !agent.supports.mode ? words.cursorNoModes : null].filter((hint): hint is string => !!hint);
}

// An agent's details under the composer's cards (region "<name> provider status"): what its
// card has no room for. The card already shows the state and the one next action (install,
// install page or sign-in); this adds the row's explanation, Cursor's hints, what the last
// install or sign-in changed, and Check again while the agent needs the user.
// It is mounted for every agent, so its note is an always-present live region (announced when
// set); the details show for the chosen agent (open), and the region is named only while it
// has something to show. When an update removes the focused Check again, focus moves to the
// agent's card (fallback).
export function ProviderStatus({ provider, agent, open, busy, rechecking = false, note, onCheck, fallback }: {
  provider: Provider; agent: AgentInfo | undefined; open: boolean; busy: boolean; rechecking?: boolean; note: string; onCheck(provider: Provider): void;
  fallback(): HTMLElement | null;
}) {
  const checking = !agent || agent.state === 'checking';
  const row = agentRow(agent, provider);
  const hints = open ? [row.hint, ...(provider === 'cursor' ? cursorHints(agent) : [])].filter((hint): hint is string => !!hint) : [];
  const needsYou = open && !checking && (row.tone === 'warn' || (!!row.action && !row.quietLogin));
  const shown = needsYou || hints.length > 0 || !!note;
  const ref = useKeepFocus<HTMLElement>(root => firstEnabled(root) ?? fallback());
  return <section ref={ref} className={`provider-status${shown ? '' : ' empty'}`} aria-label={shown ? `${PROVIDER_NAMES[provider]} provider status` : undefined}>
    {hints.map(hint => <p className="agent-hint" key={hint}>{hint}</p>)}
    <p className="agent-hint agent-note" role="status">{note}</p>
    {needsYou && <div><CheckAgain name={row.name} busy={busy} rechecking={rechecking} onCheck={() => onCheck(provider)} /></div>}
  </section>;
}
