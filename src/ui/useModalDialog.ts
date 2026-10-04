import { useEffect, type RefObject } from 'react';
import { modalCounter, trackModalDialog } from './modal';

// Report failures are ignored: outside Electron there is no main process, and a
// lost report only means shortcut keys are claimed while a dialog is open (its
// commands are still ignored by the renderer).
const modals = modalCounter(open => { try { void window.journal?.request('setModalOpen', { open }).catch(() => {}); } catch { /* not in Electron */ } });

// Every <dialog> component opens itself with this hook, so the main process
// always knows whether a modal dialog is open (see tests/modal.test.mjs).
// When the dialog goes away, focus returns to the element that had it before
// (the terminal, or the button that opened it), unless something else has
// taken focus meanwhile.
export function useModalDialog(dialog: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const release = trackModalDialog(dialog.current, modals);
    return () => {
      release();
      const active = document.activeElement;
      if (previous?.isConnected && (!active || active === document.body || dialog.current?.contains(active))) previous.focus({ preventScroll: true });
    };
  }, [dialog]);
}
