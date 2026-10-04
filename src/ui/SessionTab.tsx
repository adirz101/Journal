import type { ReactNode } from 'react';
import { isLive, PROVIDER_NAMES, type Session, type TimelineEvent } from './types';
import { activityVisible } from './sessionView';
import { outputDetail } from './sessionState';
import { ActivitySummary } from './ActivityPanel';
import { firstRun, shell } from './copy';

// The inspector's Session tab: what the agent knows (the context panel), then
// what it did. Claude reports its commands through hooks; Codex and Cursor do
// not, so for them the tab says so and shows only when they last printed.
export function SessionTab({ session, events, now, context, onShowSent }: { session: Session | null; events: TimelineEvent[]; now: number; context: ReactNode; onShowSent(): void }) {
  if (!session) return <>{context}</>;
  const name = PROVIDER_NAMES[session.provider];
  return <div className="session-tab">
    {context}
    <section className="panel-content did-section" aria-labelledby="what-it-did">
      <div className="section-heading"><div><h2 id="what-it-did">{shell.whatItDid}</h2>{activityVisible(session) && <small className="muted">{shell.fromHooks}</small>}</div></div>
      {activityVisible(session) ? <ActivitySummary events={events} empty={isLive(session) ? firstRun.didEmpty : firstRun.didEmptyEnded} />
        : <><h3>{shell.activityHidden(name)}</h3><p className="muted">{shell.activityHiddenBody(name)}</p><p className="muted">{shell.lastOutput(outputDetail(session.lastOutputAt, now))}</p><ActivitySummary events={events} observable={false} /></>}
      <button className="link-button" onClick={onShowSent}>{shell.seeWhatWasSent}</button>
      <p className="muted small-print">Changes apply from the next start. What was already sent stays on record.</p>
    </section>
  </div>;
}
