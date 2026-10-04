// How a note card's trust lines read (Phase 5, F15). Pure: NoteCard renders it and
// tests/note-card.test.mjs checks it with a fixed clock. Category codes live here, not
// in the components, so the visible-text scan of the .tsx files stays strict.
import { PROVIDER_NAMES, type Memory, type MemoryOrigin, type Provider } from './types';
import { copy } from './copy';

// memory: the Memory tab; receipt: a delivered snapshot (Session tab); hover: the composer's
// hover card (Phase 4); preview: a note in a context preview.
export type NoteCardVariant = 'memory' | 'receipt' | 'hover' | 'preview';

const t = copy.trust;
const DAY = 86_400_000;
const DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

// A date-only value (YYYY-MM-DD) is a local calendar day; anything else is an instant.
function parse(value: string): Date | null {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// "4 Oct 2026" (en-GB, the user's time zone); empty when the value is not a date.
export function dateText(value: string | null | undefined): string {
  const date = value ? parse(value) : null;
  return date ? DATE.format(date) : '';
}

// "today", "yesterday", "3 days ago" (under 7 days, by local calendar day), else "4 Oct 2026".
// A time in the future (another machine's clock) reads as today.
export function whenText(iso: string, now: number): string {
  const then = parse(iso); if (!then) return '';
  const midnight = (time: number) => { const date = new Date(time); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const days = Math.round((midnight(now) - midnight(then.getTime())) / DAY);
  if (days <= 0) return t.today;
  if (days === 1) return t.yesterday;
  if (days < 7) return t.daysAgo(days);
  return DATE.format(then);
}

const providerName = (provider: string | null | undefined) => provider && provider in PROVIDER_NAMES ? PROVIDER_NAMES[provider as Provider] : null;
// Session titles come from the task text, which can be long.
const clip = (text: string, max = 60) => text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
const short = (sha: string | null | undefined) => (sha ?? '').slice(0, 7);

// Where the note came from. Remembered (active) notes say who remembered it and when;
// other states give the same origin without that, since the status chip says the state.
// null while the origin is loading or unavailable. sessionId: a present session App can open.
export function originLine(note: Pick<Memory, 'status'>, origin: MemoryOrigin | null | undefined, now: number): { text: string; sessionId: string | null } | null {
  if (!origin) return null;
  const active = note.status === 'active';
  const at = origin.approvedAt ? whenText(origin.approvedAt, now) : '';
  const remembered = at ? `${t.rememberedBy} ${/\d{4}$/.test(at) ? t.onDate(at) : at}` : t.rememberedBy;
  const credit = active ? t.rememberedSuffix : '';
  const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  switch (origin.kind) {
    case 'session': {
      const session = origin.session; const provider = providerName(session?.provider);
      if (session?.state === 'present') {
        // A removed session's title is never shown; only a present one names its session.
        const from = `${session.title ? t.fromSession(clip(session.title)) : t.fromUntitled}${provider ? ` (${provider})` : ''}`;
        return { text: active ? `${remembered}, ${from}` : sentence(from), sessionId: session.id };
      }
      const date = dateText(session?.date);
      const details = [provider, date].filter(Boolean).join(', ');
      const from = `${t.removedSession}${details ? ` (${details})` : ''}`;
      return { text: active ? `${remembered}. ${from}` : from, sessionId: null };
    }
    case 'git': {
      const head = short(origin.git?.head);
      return { text: `${t.git(origin.git?.base ? `${short(origin.git.base)}..${head}` : t.upTo(head))}${credit}`, sessionId: null };
    }
    case 'import': return { text: `${t.imported(dateText(origin.createdAt))}${credit}`, sessionId: null };
    case 'promoted': return { text: `${t.promoted(origin.promotedFrom?.branch ?? t.anotherBranch)}${credit}`, sessionId: null };
    default: return { text: t.added(dateText(origin.createdAt)), sessionId: null };
  }
}

// What a file note is based on and whether that file still matches (file sources only:
// Git and statements are covered by the origin line). rootName: the folder of a folder
// source. A delivered snapshot (receipt) only knows its sources were current at launch.
// title: the full location, also for "Check needed", whose text leaves the path out.
export function evidenceLine(note: Memory, rootName?: string, variant?: NoteCardVariant): { text: string; tone: 'quiet' | 'amber'; title: string } | null {
  const source = note.source;
  if (source.kind !== 'file' || !source.path) return null;
  const start = source.startLine; const end = source.endLine ?? start;
  const lines = start ? end && end !== start ? `:${start}–${end}` : `:${start}` : '';
  const where = `${rootName ? `${rootName}/` : ''}${source.path}${lines}`;
  const based = (suffix: string) => ({ text: `${t.basedOn(where)} · ${suffix}`, tone: 'quiet' as const, title: where });
  if (variant === 'receipt') return based(t.atStart);
  switch (note.validation) {
    case 'stale': return { text: `${copy.checkNeeded} · ${t.fileChanged}`, tone: 'amber', title: where };
    case 'wrong-branch': return based(t.onlyOn(note.branch ?? t.anotherBranch));
    case 'folder-removed': return based(t.folderRemoved);
    default: return based(t.unchanged);
  }
}

// The note as a card shows it: checkNeeded (a newer check than the page) marks it out of
// date, except on a delivered snapshot, which shows freshness at launch only.
export function shownNote(note: Memory, checkNeeded: boolean | undefined, variant: NoteCardVariant): Memory {
  return checkNeeded && variant !== 'receipt' ? { ...note, validation: 'stale' } : note;
}
// The status chip's class: amber when a check is needed, neutral for another branch or a removed folder.
export const stateClass = (note: Pick<Memory, 'status' | 'validation'>) => note.validation === 'stale' ? 'stale' : note.validation !== 'current' ? 'other' : note.status;

// Distinct conversations the note was sent to (decision D6); null while loading.
export function sentLine(n: number | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  return n === 0 ? t.notSent : t.sentTo(n);
}

// Memory tab category chips, in this order, with their labels.
export const CATEGORY_ORDER: readonly string[] = ['all', 'brief', 'decision', 'constraint', 'lesson', 'convention', 'issue'];
const CHIP_LABELS: Record<string, string> = { all: 'All', brief: 'Project and branch', decision: 'Decisions', constraint: 'Rules', lesson: 'Lessons', convention: 'Conventions', issue: 'Known issues' };
export const chipLabel = (code: string) => CHIP_LABELS[code] ?? code;
