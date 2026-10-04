import { useEffect, type RefObject } from 'react';
import { modalCounter } from './modal';

// Report failures are ignored: outside Electron there is no main process, and a
// lost report only means shortcut keys are claimed while a dialog is open (its
// commands are still ignored by the renderer).
const modals = modalCounter(open => { try { void window.journal?.request('setModalOpen', { open }).catch(() => {}); } catch { /* not in Electron */ } });

// Every <dialog> component opens itself with this hook, so the main process
// always knows whether a modal dialog is open (see tests/modal.test.mjs).
export function useModalDialog(dialog: RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    modals.opened();
    return () => modals.closed();
  }, [dialog]);
}
