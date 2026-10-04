import { firstRun } from './copy';

// Board 12: the one moment of delight, when the install's first note is remembered.
// An inline strip at the top of the main column (not a toast): no timer, never takes
// focus, never blocks input. It stays until closed or a session starts. The entrance
// (styles.css, Phase 7) plays once; reduced motion shows it without animation.
export function FirstNoteMoment({ mark, onClose }: { mark: string; onClose(): void }) {
  return <div className="first-note" role="status">
    <img className="first-note-mark" src={mark} alt="" width={32} height={32} />
    <p><strong>{firstRun.firstNoteTitle}</strong> <span>{firstRun.firstNoteBody}</span></p>
    <button className="text-button" onClick={onClose}>{firstRun.close}</button>
  </div>;
}
