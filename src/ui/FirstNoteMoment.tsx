import { firstRun } from './copy';

// Board 12: the one moment of delight, when the install's first note is remembered.
// An inline strip in the main column (not a toast): no timer, never takes focus, never
// blocks input. It stays until closed or a session starts. App announces the text through
// an always-present live region, so the strip itself is not one.
// Placement: at the top while no session is shown (Getting to know your project, the
// composer); at the bottom of a session (the wrap-up), so nothing above the pointer moves.
// The entrance (styles.css, Phase 7) plays once: after it ends (entered) a move between the
// two places shows the strip without it. Reduced motion shows it without animation.
export function FirstNoteMoment({ mark, place, entered, onEntered, onClose }: {
  mark: string; place: 'top' | 'bottom'; entered: boolean; onEntered(): void; onClose(): void;
}) {
  return <div className={`first-note at-${place}${entered ? ' entered' : ''}`} onAnimationEnd={event => { if (event.target === event.currentTarget) onEntered(); }}>
    <img className="first-note-mark" src={mark} alt="" width={32} height={32} />
    <p><strong>{firstRun.firstNoteTitle}</strong> <span>{firstRun.firstNoteBody}</span></p>
    <button type="button" className="text-button" onClick={onClose}>{firstRun.close}</button>
  </div>;
}
