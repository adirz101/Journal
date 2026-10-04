// First run (Phase 7, boards 1-3). Pure: Welcome, the agent rows, GettingToKnow and
// tests/first-run-model.test.mjs use it. The composer's agent cards (composerModel.agentCard)
// are built on agentRow, so the Welcome rows and the cards can't disagree.
import { PROVIDER_NAMES, type AgentInfo, type DraftFacts, type StatusDraft } from './types';
import { composer, firstRun, providers } from './copy';

export type AgentAction = 'install' | 'install-page' | 'login';
export interface AgentRowView {
  name: string;
  sub: string;                       // the second line: install and sign-in state
  hint: string | null;               // an optional explanation under the row
  tone: 'ok' | 'warn' | 'muted';     // ok: signed in; warn: needs you (amber); muted: anything else
  action: AgentAction | null;        // exactly one next action, or none
  quietLogin: boolean;               // sign-in offered as a text button, without a warning
}

// "Signed in" only from a probe that parsed cleanly (auth === 'signed-in'); unknown or
// unchecked never warns, and offers a quiet sign-in where the CLI documents one.
export function agentRow(agent: AgentInfo | undefined, provider = agent?.provider ?? 'claude'): AgentRowView {
  const name = PROVIDER_NAMES[provider];
  const base = { name, hint: null, quietLogin: false };
  if (!agent || agent.state === 'checking') return { ...base, sub: providers.checking, tone: 'muted', action: null };
  if (agent.state === 'unlaunchable') return { ...base, sub: composer.cantLaunch, tone: 'warn', action: null,
    hint: providers.cantStart(agent.unlaunchable?.path ?? name, agent.unlaunchable?.reason ?? '') };
  if (agent.state === 'unsupported') return { ...base, sub: `${providers.installedAs(agent.version)} · ${composer.unsupported}`, tone: 'warn', action: null, hint: providers.unsupportedHint };
  if (agent.state === 'not-cursor') return { ...base, sub: composer.notCursor, tone: 'warn', action: 'install', hint: providers.notCursorHint(agent.impostor ?? 'agent') };
  if (!agent.available) {
    const action: AgentAction | null = agent.commands?.install ? 'install' : agent.commands?.installPage ? 'install-page' : null;
    return { ...base, sub: providers.notInstalled, tone: 'muted', action, hint: action === 'install' ? providers.installHint(name) : action === 'install-page' ? providers.installPageHint : null };
  }
  const installed = providers.installedAs(agent.version);
  // Cursor signs in whenever its CLI is found; Claude and Codex only when their help documents it.
  const canLogin = provider === 'cursor' || agent.supports?.login === true;
  if (agent.auth === 'signed-in') return { ...base, sub: `${installed} · ${providers.signedIn}`, tone: 'ok', action: null };
  if (agent.auth === 'signed-out' || agent.state === 'login-required') return { ...base, sub: `${installed} · ${providers.signInNeeded}`, tone: 'warn', action: canLogin ? 'login' : null, hint: canLogin ? null : providers.signInElsewhere(name) };
  // A probe that ran but could not conclude says so (muted, never a warning); no probe claims nothing.
  return { ...base, sub: agent.auth === 'unknown' ? `${installed} · ${composer.signInUnknown}` : installed, tone: 'muted', action: canLogin ? 'login' : null, quietLogin: canLogin };
}

// The accessible name of a row's action, unique per provider.
export function actionName(action: AgentAction, name: string) {
  return action === 'install' ? providers.installName(name) : action === 'login' ? providers.signInName(name) : providers.installPageName(name);
}

// ----- Getting to know your project (board 2) -----

export type FieldKey = 'currentWork' | 'next' | 'constraints';
// The labelled lines a card turns into fields (core fillDraft's FIELDS), with their visible labels.
const FIELDS: [string, FieldKey][] = [['Current work', 'currentWork'], ['Next', 'next'], ['Constraints', 'constraints']];
const PLACEHOLDER = /\[describe[^\]]*\]/;
export const hasPlaceholder = (statement: string) => PLACEHOLDER.test(statement);
export type DraftLine = { kind: 'text'; label: string | null; value: string } | { kind: 'field'; label: string; key: FieldKey };
export type Fields = Partial<Record<FieldKey, string>>;

// A draft statement as card rows. A "Label: value" line is a labelled row; a line holding
// one of the three placeholders becomes a field; every other line (the Completed block,
// its commit list) is shown verbatim.
export function draftLines(statement: string): DraftLine[] {
  return statement.split('\n').map(line => {
    const field = FIELDS.find(([label]) => line.startsWith(`${label}:`));
    if (field && PLACEHOLDER.test(line.slice(field[0].length + 1))) return { kind: 'field', label: field[0], key: field[1] };
    const match = /^([A-Z][A-Za-z ]{0,30}):\s(.*)$/.exec(line);
    return match ? { kind: 'text', label: match[1], value: match[2] } : { kind: 'text', label: null, value: line };
  });
}

// What Remember saves: core fillDraft without its refusals (core refuses a credential or a
// remaining placeholder when it saves). A filled field replaces its placeholder (trimmed, one
// line, at most 500 characters); an empty one removes the line; other lines are never changed.
// keepEmpty (Edit): an empty field keeps its placeholder line, so the form shows it.
export function previewStatement(statement: string, fields: Fields, { keepEmpty = false } = {}) {
  const lines: string[] = [];
  for (const line of statement.split('\n')) {
    const field = FIELDS.find(([label]) => line.startsWith(`${label}:`));
    if (!field || !PLACEHOLDER.test(line.slice(field[0].length + 1))) { lines.push(line); continue; }
    const value = (fields[field[1]] ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 500);
    if (value) lines.push(`${field[0]}: ${value}`); else if (keepEmpty) lines.push(line);
  }
  return lines.join('\n');
}

// A card's tags: the source on the right ("README.md · 577fb89", "1 commit since main").
export function cardMeta(draft: StatusDraft): { badge: string; source: string } {
  const { basis } = draft; const head = basis.head.slice(0, 7);
  if (draft.scope === 'checkout') return { badge: firstRun.draft, source: `${basis.facts?.readme ?? 'Git'} · ${head}` };
  const n = basis.commitCount ?? 0;
  const from = /^branching from (.+) \([0-9a-f]+\)$/.exec(basis.label)?.[1];
  const since = from ?? (basis.label.startsWith('the last update') ? 'the last update' : null);
  return { badge: firstRun.draft, source: since ? firstRun.commitsSince(n, since) : firstRun.recentCommits(n, head) };
}

export const factsLine = (facts: DraftFacts | undefined) => facts ? firstRun.facts(facts) : null;
