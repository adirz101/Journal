// The New session composer's rules (boards B5 and B13). Pure: Composer.tsx
// renders them and tests/composer.test.mjs checks them.
import { composer } from './copy';
import { agentRow, type AgentAction } from './firstRunModel';
import { PROVIDER_NAMES, type AgentInfo, type Memory, type Mode, type Provider, type Receipt, type SelectionInfo, type SelectionPreview } from './types';

export const MODES: readonly Mode[] = ['build', 'plan', 'read-only', 'coordinate'];
export const AGENT_ORDER: readonly Provider[] = ['claude', 'codex', 'cursor'];
// Packet budget (src/core/store.mjs assemblePacket): 12 notes or 6000 bytes.
export const NOTE_LIMIT = 12; export const BYTE_LIMIT = 6000;

// The launch inputs stay exactly as before the composer: plan and research.
export function modeFlags(mode: Mode): { plan: boolean; research: boolean } {
  return { plan: mode === 'plan', research: mode === 'read-only' };
}

// Which modes an agent can start in. Codex has no plan mode; Cursor needs a
// CLI with --mode for Plan and Read-only (Ask).
export function modeSupport(provider: Provider, agent: AgentInfo | null | undefined): Record<Mode, boolean> {
  if (provider === 'codex') return { build: true, plan: false, 'read-only': true, coordinate: true };
  if (provider === 'cursor') { const modes = !!agent?.supports?.mode; return { build: true, plan: modes, 'read-only': modes, coordinate: false }; }
  return { build: true, plan: true, 'read-only': true, coordinate: true };
}

// Why a mode is unavailable for this agent, or null.
export function modeBlock(provider: Provider, agent: AgentInfo | null | undefined, mode: Mode): string | null {
  if (modeSupport(provider, agent)[mode]) return null;
  if (mode === 'coordinate') return 'Choose Claude Code or Codex to coordinate a team. Cursor can work on individual tasks.';
  return provider === 'cursor' ? composer.noModes : composer.noPlan(PROVIDER_NAMES[provider]);
}

// An agent is ready to start when it is installed and nothing needs the user first.
export const agentReady = (agent: AgentInfo | null | undefined) => !!agent && agent.available && (agent.state ?? 'ready') === 'ready';

export interface AgentCard { sub: string; tone: 'ok' | 'warn' | 'muted'; action: AgentAction | null; quiet: boolean }
// What an agent card says: Phase 7's agentRow for every provider and state, so a card and
// its Welcome row always agree. "Signed in" and "Sign in needed" appear only when the
// agent's own status check answered; a check that could not conclude says "Sign-in unknown",
// and an agent without a status check claims neither. Install runs the official command
// where this platform has one; otherwise the card offers the install page. quiet: a sign-in
// offered without a warning (status unknown or unchecked).
export function agentCard(agent: AgentInfo | null | undefined, provider: Provider = agent?.provider ?? 'claude'): AgentCard {
  const row = agentRow(agent ?? undefined, provider);
  return { sub: row.sub, tone: row.tone, action: row.action, quiet: row.quietLogin };
}

// The card's tooltip keeps the technical detail the old provider line showed.
// It also carries the card's whole state line and the version exactly as the CLI reported it.
export function agentTitle(agent: AgentInfo | null | undefined): string | undefined {
  if (!agent) return undefined;
  const sub = agentRow(agent, agent.provider).sub;
  if (!agent.available) return agent.provider === 'cursor' ? sub : `${sub}\nNot found on PATH`;
  const caps = agent.capabilities;
  return [sub, agent.version && `Version: ${agent.version}`, agent.path ?? '', caps && `Resume: ${caps.exactResume}`, caps && `Observed: status ${caps.status.join(', ')}; commands ${caps.commands}`, caps?.modes && `Modes: ${caps.modes}`].filter(Boolean).join('\n') || undefined;
}

export const isProvider = (value: string | null | undefined): value is Provider => !!value && (AGENT_ORDER as readonly string[]).includes(value);
// The first available agent in the order Claude, Codex, Cursor; a remembered choice wins.
export function defaultProvider(agents: AgentInfo[] | undefined, remembered: string | null): Provider {
  if (isProvider(remembered)) return remembered;
  // In agent order, the first ready agent; an agent still being checked holds its place (Phase 9),
  // so the default only moves forward as detection answers, never away from a ready agent.
  for (const provider of AGENT_ORDER) {
    const agent = agents?.find(a => a.provider === provider);
    if (!agent || agent.state === 'checking' || agentReady(agent)) return provider;
  }
  return 'claude';
}

// Why an installed agent can't start yet, in a word (the card's line also names the version).
const NEEDS: Record<string, string> = { checking: composer.checking, 'login-required': composer.signInNeeded, unsupported: composer.unsupported, 'not-cursor': composer.notCursor, unlaunchable: composer.cantLaunch };
// The first reason Start is unavailable, or null. Busy has no text (the button just waits).
export function startBlock({ connected, liveCount, busy, agent, provider, mode }: { connected: boolean; liveCount: number; busy: boolean; agent: AgentInfo | null | undefined; provider: Provider; mode: Mode }): string | null {
  if (busy) return '';
  if (!connected) return composer.runtimeDown;
  if (!agentReady(agent)) {
    const card = agentCard(agent, provider);
    if (!agent || agent.state === 'missing' || (!agent.available && !agent.state)) return composer.agentMissing(PROVIDER_NAMES[provider], card.action);
    return `${PROVIDER_NAMES[provider]}: ${NEEDS[agent.state ?? ''] ?? card.sub}`;
  }
  return modeBlock(provider, agent, mode);
}

export type PreviewItem = Memory & { selection: SelectionInfo };
export interface PreviewView {
  checked: boolean; always: PreviewItem[]; relevant: PreviewItem[];
  notIncluded: { reason: string; count: number }[]; notes: number; bytes: number;
  matchedTerms: Set<string>; matchCount: number; taskNotes: number | null;
}
// Order of the Not included chips: the ones a user can act on first.
const REASON_ORDER = ['stale', 'wrong-branch', 'left-out-for-task'];
// A typing preview (SelectionPreview) or a full check (a preview Receipt) as the
// composer shows it. disabled applies a leave-out or restore before the next
// reply arrives, so the list never waits on the store.
export function previewView(result: SelectionPreview | Receipt | null, disabled: string[]): PreviewView | null {
  if (!result) return null;
  const off = new Set(disabled);
  const items = (result.items as PreviewItem[]).filter(item => !off.has(item.id));
  const always = items.filter(item => item.category === 'brief'); const relevant = items.filter(item => item.category !== 'brief');
  const counts = new Map<string, number>();
  const add = (reason: string) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  for (const entry of result.excluded) if (entry.reason !== 'left-out-for-task' || off.has(entry.id)) add(entry.reason);
  for (const item of result.items) if (off.has(item.id)) add('left-out-for-task');
  const rank = (reason: string) => { const index = REASON_ORDER.indexOf(reason); return index < 0 ? REASON_ORDER.length : index; };
  const notIncluded = [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => rank(a.reason) - rank(b.reason));
  const matchedTerms = new Set(relevant.flatMap(item => item.selection?.terms ?? []));
  return {
    checked: 'kind' in result ? false : true, always, relevant, notIncluded, notes: items.length,
    bytes: items.reduce((sum, item) => sum + (item.selection?.bytes ?? 0), 0),
    matchedTerms, matchCount: relevant.filter(item => item.selection?.terms?.length).length,
    taskNotes: 'kind' in result ? result.taskNotes : null,
  };
}

// Meter labels: notes of 12 and kilobytes of 6, with ≈ until the sources are checked.
export function meterText(view: Pick<PreviewView, 'checked' | 'notes' | 'bytes'>) {
  const approx = view.checked ? '' : '≈';
  return { notes: `${approx}${view.notes} / ${NOTE_LIMIT}`, size: `${approx}${(view.bytes / 1000).toFixed(1)} / ${BYTE_LIMIT / 1000} KB` };
}
