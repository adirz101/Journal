import { useMemo, useState } from 'react';
import { buildStory, type StoryPhase, type StoryTurn } from '../core/story/story.mjs';
import type { TimelineEvent } from './types';
import { RawActivity } from './ActivityPanel';
import { story as copy } from './copy';

// The Session tab's Story: a deterministic summary of what the session's recorded events show
// (src/core/story), the latest turn first-class, earlier turns one line each, and the raw
// evidence (exact commands, exits, durations and the full timeline) under Details.
const GLYPH: Record<string, string> = { passed: '✓', done: '✓', failed: '✕', active: '●', pending: '○', removed: '–', unknown: '·', neutral: '·', running: '·', interrupted: '·' };
const ITEMS = 12;
const clock = (at: string | null) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
function elapsed(from: string | null, to: string | null) {
  const ms = from && to ? Date.parse(to) - Date.parse(from) : NaN; if (!Number.isFinite(ms) || ms < 1000) return null;
  const s = Math.round(ms / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}` : `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m`;
}

function Row({ phase }: { phase: StoryPhase }) {
  const [open, setOpen] = useState(false);
  const shown = phase.items.slice(-ITEMS);
  return <li className={`story-row status-${phase.status}`}>
    <button type="button" className="story-row-button" aria-expanded={phase.items.length ? open : undefined} disabled={!phase.items.length} onClick={() => setOpen(!open)}
      title={phase.meta.length > phase.summary.length ? phase.meta.join(' · ') : undefined}>
      <span className="story-glyph" aria-hidden="true">{GLYPH[phase.status] ?? '·'}</span>
      <span className="story-text">
        <span className="story-title">{phase.title}{copy.status[phase.status] && <span className="visually-hidden">, {copy.status[phase.status]}</span>}</span>
        {phase.summary.length > 0 && <span className="story-meta">{phase.summary.join(' · ')}</span>}
      </span>
    </button>
    {open && phase.meta.length > phase.summary.length && <p className="story-full">{phase.meta.join(' · ')}</p>}
    {open && <ul className="story-items" aria-label={copy.itemsOf(phase.title)}>
      {phase.items.length > shown.length && <li className="story-more">{copy.earlierItems(phase.items.length - shown.length)}</li>}
      {shown.map((item, index) => <li key={`${item.at}-${index}`} className={`status-${item.status}`}>
        <time dateTime={item.at}>{clock(item.at)}</time>
        <span className={item.command !== null && item.label === item.command ? 'story-command' : undefined} title={item.command ?? item.label}>{item.label}</span>
        {item.status === 'failed' && <span className="story-failed">{copy.status.failed}</span>}
      </li>)}
    </ul>}
  </li>;
}

const turnHeading = (turn: StoryTurn) => [copy.turn(turn.index), clock(turn.at), elapsed(turn.at, turn.endAt), turn.outcome && turn.outcome !== 'completed' ? copy.outcome[turn.outcome] ?? turn.outcome : null,
  turn.approvals ? copy.approvals(turn.approvals) : null].filter(Boolean).join(' · ');

export function StoryPanel({ events, waiting = false, empty }: { events: TimelineEvent[]; waiting?: boolean; empty: string }) {
  const story = useMemo(() => buildStory(events), [events]);
  const [details, setDetails] = useState(false); const [earlier, setEarlier] = useState(false);
  const active = story.turns.filter(turn => turn.phases.length);
  const latest = active.at(-1); const older = active.slice(0, -1);
  return <div className="story">
    {waiting && story.waiting && <p className="story-waiting" role="note"><span aria-hidden="true">●</span> {copy.waiting(story.waiting.label)}</p>}
    {story.plan?.length ? <section aria-label={copy.plan}><h3 className="story-heading">{copy.plan}</h3><ol className="story-list">{story.plan.map(phase => <Row key={phase.key} phase={phase} />)}</ol></section> : null}
    {latest ? <section aria-label={copy.turn(latest.index)}><h3 className="story-heading">{turnHeading(latest)}</h3><ol className="story-list">{latest.phases.map(phase => <Row key={phase.key} phase={phase} />)}</ol></section>
      : !story.plan && <p className="muted">{empty}</p>}
    {older.length > 0 && <>
      <button type="button" className="text-button" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>{earlier ? copy.hideEarlier : copy.earlier(older.length)}</button>
      {earlier && <ol className="story-turns">{older.map(turn => <li key={turn.index}>
        <span className="story-turn-label">{copy.turn(turn.index)} · {clock(turn.at)}</span>
        <span className="story-turn-phases">{turn.phases.map(phase => `${phase.status === 'failed' ? '✕ ' : ''}${phase.title}`).join(' · ')}</span>
      </li>)}</ol>}
    </>}
    <button type="button" className="text-button" aria-expanded={details} onClick={() => setDetails(!details)}>{details ? copy.hideDetails : copy.details}</button>
    {details && <RawActivity events={events} />}
  </div>;
}
