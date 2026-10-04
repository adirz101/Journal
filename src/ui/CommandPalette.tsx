import { useRef } from 'react';
import { useModalDialog } from './useModalDialog';
import { palette as words } from './copy';

// Phase 8 A0 stub: the dialog, its one input and Escape. Group B builds the
// groups, results and keyboard model on this seam (plan section 3, B2).
export function CommandPalette({ mode, rootLabel, onClose }: { mode: 'all' | 'files'; rootLabel?: string | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(dialog);
  const files = mode === 'files';
  // Escape is the dialog's native cancel; closing restores focus (useModalDialog).
  return <dialog ref={dialog} className="palette" aria-label={files ? words.fileTitle : words.title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <input autoFocus aria-label={files ? words.fileTitle : words.title} placeholder={files ? words.filePlaceholder(rootLabel ?? '') : words.placeholder} />
  </dialog>;
}
