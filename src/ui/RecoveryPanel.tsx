import { ProviderMark } from './ProviderMark';
import { sessionName } from './sidebarModel';
import { copy, states } from './copy';
import { PROVIDER_NAMES, type Recovery, type Session } from './types';
import type { RecoveryView } from './statesModel';

// Crash recovery (board 9, panel 2): the sessions a crashed runtime left interrupted, each
// with one next step. Nothing is resent: Continue reopens the same conversation only when
// clicked. Not modal; the terminal stays usable. Done acknowledges the recovery.
export function RecoveryPanel({ recovery, view, busy, onContinue, onSelect, onDone }: {
  recovery: Recovery; view: RecoveryView; busy: boolean;
  onContinue(session: Session): void; onSelect(session: Session): void; onDone(): void;
}) {
  const leftovers = view.leftovers.length;
  return <section className="recovery-panel" aria-labelledby="recovery-title">
    <h2 id="recovery-title"><span className="recovery-icon" aria-hidden="true">!</span>{states.crashTitle}</h2>
    <p className="recovery-body">{states.crashBody(recovery)}{view.allResumable ? ` ${states.crashContinue}` : ''}</p>
    <ul className="recovery-rows" aria-label={states.recoveryLabel}>
      {view.rows.map(({ session, action, reason }) => <li key={session.id}>
        <ProviderMark provider={session.provider} size={16} />
        <span className="recovery-name" title={sessionName(session)}><span className="visually-hidden">{PROVIDER_NAMES[session.provider]}: </span>{sessionName(session)}</span>
        {action === 'continue' && <>{reason && <span className="recovery-reason" id={`recovery-reason-${session.id}`}>{reason}</span>}
          <button type="button" disabled={!!reason || busy} aria-describedby={reason ? `recovery-reason-${session.id}` : undefined} title={reason ?? undefined} onClick={() => onContinue(session)}>{copy.continue}</button></>}
        {action === 'needs-id' && <><span className="recovery-reason">{states.needsId}</span><button type="button" onClick={() => onSelect(session)}>{states.confirmId}</button></>}
        {action === 'running' && <><span className="recovery-reason">{states.stillRunning}</span><button type="button" onClick={() => onSelect(session)}>{states.review}</button></>}
      </li>)}
    </ul>
    <div className="recovery-footer">
      {leftovers > 0 && <p>{states.leftover(leftovers)} · <button type="button" className="text-button" onClick={() => onSelect(view.leftovers[0])}>{states.review}</button></p>}
      <button type="button" className="recovery-done" onClick={onDone}>{states.done}</button>
    </div>
  </section>;
}
