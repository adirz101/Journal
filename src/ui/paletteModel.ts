// The command palette's rules (Phase 8, board 7). Pure: CommandPalette.tsx renders
// them and tests/palette.test.mjs checks them. Nothing here starts, approves or sends.
import { isLive, PROVIDER_NAMES, type CommandId, type Memory, type Session } from './types';
import { outputDetail, outputOnly, resumable, slotOrder, stateFor } from './sessionState';
import { endedTime, relativeTime, sessionName } from './sidebarModel';
import { category, palette as words } from './copy';

// Actions only the palette offers (no key of their own).
export type ExtraAction = 'manage-workspaces' | 'check-agents' | 'switch-branch';
export type PaletteActionId = CommandId | ExtraAction;
export type Span = [number, number];

export type PaletteItem =
  | { kind: 'session'; id: string; session: Session; label: string; detail: string; keys: string | null; action: 'open' | 'continue'; spans: Span[] }
  | { kind: 'action'; id: string; action: PaletteActionId; label: string; keys: string | null; enabled: boolean; reason: string | null; spans: Span[] }
  | { kind: 'note'; id: string; noteId: string; label: string; category: string; spans: Span[] }
  | { kind: 'file'; id: string; path: string; spans: Span[]; rootKey: string; rootLabel: string | null }
  | { kind: 'fallback'; id: 'new-with-task' | 'add-as-note'; label: string };
export type GroupId = 'sessions' | 'quiet' | 'actions' | 'memory' | 'files' | 'none';
export interface PaletteGroup { id: GroupId; label: string; items: PaletteItem[] }

// Every routed command except the slots (the Sessions group covers them) and the
// palette's own two, in the order the Actions group lists them; then the extras.
export const PALETTE_COMMANDS: readonly CommandId[] = ['new-session', 'next-needs-you', 'open-project', 'add-note', 'focus-terminal', 'toggle-inspector', 'toggle-sidebar', 'tab-session', 'tab-files', 'tab-memory', 'settings'];
export const EXTRA_ACTIONS: readonly ExtraAction[] = ['manage-workspaces', 'switch-branch', 'check-agents'];
export const PALETTE_ACTIONS: readonly PaletteActionId[] = [...PALETTE_COMMANDS, ...EXTRA_ACTIONS];
export const MAX_SESSIONS_SHOWN = 6;
export const QUIET_MS = 120_000;

// A leading '>' (after spaces) keeps only actions.
export function parseQuery(raw: string): { text: string; actionsOnly: boolean } {
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('>')) return { text: trimmed.slice(1).trim(), actionsOnly: true };
  return { text: raw.trim(), actionsOnly: false };
}

const tokens = (text: string) => text.toLocaleLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
const matchesAll = (haystack: string, words: string[]) => { const hay = haystack.toLocaleLowerCase(); return words.every(word => hay.includes(word)); };

// Every case-insensitive occurrence of each query word in the label, merged.
export function highlight(label: string, text: string): Span[] {
  const lower = label.toLocaleLowerCase(); const spans: Span[] = [];
  // toLocaleLowerCase can change a string's length (rare scripts); then nothing is marked.
  if (lower.length !== label.length) return [];
  for (const word of tokens(text)) for (let at = lower.indexOf(word); at >= 0; at = lower.indexOf(word, at + word.length)) spans.push([at, at + word.length]);
  return mergeSpans(spans);
}
export function mergeSpans(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]); const out: Span[] = [];
  for (const [start, end] of sorted) { const last = out.at(-1); if (last && start <= last[1]) last[1] = Math.max(last[1], end); else out.push([start, end]); }
  return out;
}

const activity = (session: Session) => Date.parse(session.lastActivityAt ?? session.endedAt ?? session.createdAt) || 0;
const sessionItem = (session: Session, text: string, now: number, connected: boolean, keys: Record<string, { label: string }>): PaletteItem => {
  const state = stateFor(session, now, connected); const live = isLive(session);
  const detail = live ? `${state.word}${state.detail ? ` · ${state.detail}` : ''}` : `${state.word} · ${relativeTime(endedTime(session), now)}`;
  const label = sessionName(session);
  return { kind: 'session', id: `session:${session.id}`, session, label, detail, keys: live && session.slot ? keys[`slot-${session.slot}`]?.label ?? null : null,
    action: resumable(session) ? 'continue' : 'open', spans: highlight(label, text) };
};

// Sessions matching the query on name, provider and branch: live ones by slot, then the
// rest of the current project, then other projects, most recent first; at most six.
// An empty query lists the live sessions only.
export function sessionMatches(sessions: Session[], projectId: string | null, text: string, now: number, connected: boolean, keys: Record<string, { label: string }> = {}): PaletteItem[] {
  const words = tokens(text); const shown = sessions.filter(s => !s.removed);
  const live = slotOrder(shown).filter(isLive);
  const rest = words.length ? shown.filter(s => !isLive(s)).sort((a, b) => (Number(b.projectId === projectId) - Number(a.projectId === projectId)) || activity(b) - activity(a) || a.id.localeCompare(b.id)) : [];
  const matches = [...live, ...rest].filter(s => !words.length || matchesAll(`${sessionName(s)}\n${PROVIDER_NAMES[s.provider]}\n${s.branch ?? ''}`, words));
  return matches.slice(0, MAX_SESSIONS_SHOWN).map(s => sessionItem(s, text, now, connected, keys));
}

// Live Codex and Cursor sessions (Journal sees only their output) quiet for two minutes
// or more, quietest first. Claude reports its own state, so it is never listed.
export function quietSessions(sessions: Session[], now: number): Session[] {
  const since = (s: Session) => Date.parse(s.lastOutputAt ?? s.createdAt);
  return sessions.filter(s => !s.removed && isLive(s) && outputOnly(s) && now - since(s) >= QUIET_MS)
    .sort((a, b) => since(a) - since(b) || a.id.localeCompare(b.id));
}
// While disconnected nothing is known about output, so no session is called quiet.
export function quietItems(sessions: Session[], now: number, connected = true): PaletteItem[] {
  if (!connected) return [];
  return quietSessions(sessions, now).map(session => ({ kind: 'session', id: `quiet:${session.id}`, session, label: sessionName(session),
    detail: `${PROVIDER_NAMES[session.provider]} · ${outputDetail(session.lastOutputAt, now)}`, keys: null, action: 'open', spans: [] }));
}

// can(id): the reason the matching button or key is unavailable, or null. A disabled
// action stays listed with its reason; running it does nothing.
export function actionItems(ids: readonly PaletteActionId[], keys: Record<string, { label: string } | undefined>, can: (id: PaletteActionId) => string | null, text: string): PaletteItem[] {
  const words = tokens(text);
  return ids.filter(id => !words.length || matchesAll(words_(id), words)).map(id => {
    const reason = can(id); const label = words_(id);
    return { kind: 'action', id: `action:${id}`, action: id, label, keys: keys[id]?.label ?? null, enabled: reason === null, reason, spans: highlight(label, text) };
  });
}
const words_ = (id: PaletteActionId) => (words.actions as Record<string, string>)[id] ?? id;

export function noteItems(notes: Memory[], text: string): PaletteItem[] {
  return notes.map(note => ({ kind: 'note', id: `note:${note.id}`, noteId: note.id, label: note.statement, category: category(note.category, note.scope), spans: highlight(note.statement, text) }));
}

// Memory is searched for two or more characters, never for '>' queries.
export const searchesMemory = (text: string, actionsOnly: boolean) => !actionsOnly && text.length >= 2;

// Groups in order: an empty query lists live sessions, quiet ones and actions; a query
// lists sessions, actions and notes; '>' lists actions only. When everything is empty
// (and no note search is in flight) the two fallbacks prefill, they never start.
// fallbacks: false without a project (there is no task box or note form to fill); the message stays.
// A quiet session is listed once, under Quiet sessions to check (not also under Sessions).
// actionsFirst: the Actions group leads an empty query (open-file without a project, whose
// first action is Open project…).
export function buildGroups(input: { text: string; actionsOnly: boolean; sessions: PaletteItem[]; quiet: PaletteItem[]; actions: PaletteItem[]; notes: PaletteItem[]; notesLoading: boolean; fallbacks?: boolean; actionsFirst?: boolean }): PaletteGroup[] {
  const { text, actionsOnly } = input;
  const quietIds = new Set(input.quiet.flatMap(item => item.kind === 'session' ? [item.session.id] : []));
  const sessions = input.sessions.filter(item => item.kind !== 'session' || !quietIds.has(item.session.id));
  const empty: PaletteGroup[] = [{ id: 'sessions', label: words.groups.sessions, items: sessions }, { id: 'quiet', label: words.groups.quiet, items: input.quiet }];
  const actions: PaletteGroup = { id: 'actions', label: words.groups.actions, items: input.actions };
  const groups: PaletteGroup[] = actionsOnly ? [actions]
    : !text ? (input.actionsFirst ? [actions, ...empty] : [...empty, actions])
    : [{ id: 'sessions', label: words.groups.sessions, items: input.sessions }, { id: 'actions', label: words.groups.actions, items: input.actions }, { id: 'memory', label: words.groups.memory, items: input.notes }];
  const shown = groups.filter(group => group.items.length);
  if (shown.length || !text || input.notesLoading) return shown;
  return [{ id: 'none', label: words.noResults(text), items: input.fallbacks === false ? [] : [{ kind: 'fallback', id: 'new-with-task', label: words.newWithTask }, { kind: 'fallback', id: 'add-as-note', label: words.addAsNote }] }];
}

// Hits of the Files tab's roots (its current root, then its additional folders), already merged.
// rootLabel names an additional folder, so its files are told apart from the root's.
export function fileGroup(hits: { path: string; spans: Span[]; rootKey?: string; rootLabel?: string | null }[]): PaletteGroup[] {
  return hits.length ? [{ id: 'files', label: words.groups.files, items: hits.map(hit => ({ kind: 'file', id: `file:${hit.rootKey ?? ''}\u0000${hit.path}`, path: hit.path, spans: hit.spans,
    rootKey: hit.rootKey ?? '', rootLabel: hit.rootLabel ?? null })) }] : [];
}

// One search over several roots: hits by score (the earlier root first on a tie, then the path),
// at most limit. Available when any root is; otherwise the first root's reason. Truncation and
// the number of files searched add up.
export interface RootSearch { rootKey: string; rootLabel: string | null; result: { available: boolean; reason?: 'not-git' | 'failed'; hits: { path: string; score: number; spans: Span[] }[]; total: number; truncated: boolean; truncatedBy?: 'timeout' | 'size' | 'limit'; listed?: number } | null }
export function mergeFileSearches(searches: RootSearch[], limit = 50) {
  const ok = searches.filter(search => search.result?.available);
  const hits = ok.flatMap((search, order) => search.result!.hits.map(hit => ({ ...hit, rootKey: search.rootKey, rootLabel: search.rootLabel, order })))
    .sort((a, b) => b.score - a.score || a.order - b.order || a.path.localeCompare(b.path)).slice(0, limit);
  const truncated = ok.filter(search => search.result!.truncated);
  return { available: ok.length > 0, reason: ok.length ? undefined : searches[0]?.result?.reason ?? 'failed', hits,
    total: ok.reduce((sum, search) => sum + search.result!.total, 0), truncated: truncated.length > 0, truncatedBy: truncated[0]?.result!.truncatedBy,
    listed: truncated.length ? ok.reduce((sum, search) => sum + (search.result!.listed ?? search.result!.total), 0) : undefined };
}

// A stable DOM id for an option, from its own id (never its position), so a screen reader
// announces a new top result as the list changes under aria-activedescendant. FNV-1a, base 36.
export function optionDomId(id: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) { hash ^= id.charCodeAt(i); hash = Math.imul(hash, 0x01000193); }
  return `palette-opt-${(hash >>> 0).toString(36)}`;
}

// Arrow keys wrap; Page Up and Page Down jump to the first option of the previous or next group.
export function moveActive(groups: PaletteGroup[], activeId: string | null, delta: 1 | -1 | 'first' | 'last' | 'next-group' | 'prev-group'): string | null {
  const flat = groups.flatMap((group, g) => group.items.map(item => ({ id: item.id, g })));
  if (!flat.length) return null;
  const at = flat.findIndex(entry => entry.id === activeId);
  if (delta === 'first' || at < 0) return delta === 'last' || delta === -1 ? flat.at(-1)!.id : flat[0].id;
  if (delta === 'last') return flat.at(-1)!.id;
  if (delta === 1 || delta === -1) return flat[(at + delta + flat.length) % flat.length].id;
  const firsts = groups.map((group, g) => ({ g, id: group.items[0]?.id })).filter(entry => entry.id);
  const current = firsts.findIndex(entry => entry.g === flat[at].g);
  const next = delta === 'next-group' ? (current + 1) % firsts.length : (current - 1 + firsts.length) % firsts.length;
  return firsts[next].id!;
}

// The active option is kept by id, so late results (notes) never move it; when it
// is gone, the first option becomes active.
export function keepActive(groups: PaletteGroup[], activeId: string | null): string | null {
  const ids = groups.flatMap(group => group.items.map(item => item.id));
  return activeId && ids.includes(activeId) ? activeId : ids[0] ?? null;
}

export function findItem(groups: PaletteGroup[], id: string | null): PaletteItem | null {
  if (!id) return null;
  for (const group of groups) for (const item of group.items) if (item.id === id) return item;
  return null;
}

// A path split for display: the file name, and its folder (ellipsised from the left by CSS).
export function splitPath(path: string): { name: string; folder: string; nameStart: number } {
  const slash = path.lastIndexOf('/');
  return { name: path.slice(slash + 1), folder: slash > 0 ? path.slice(0, slash) : '', nameStart: slash + 1 };
}
