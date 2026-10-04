// Counts the modal dialogs that are open and reports only the transitions
// (none open -> one open, last one closed). The main process stops claiming
// shortcut keys while one is open, so keys behave as usual inside it.
export function modalCounter(report: (open: boolean) => void) {
  let count = 0;
  return {
    opened() { count += 1; if (count === 1) report(true); },
    closed() { if (count === 0) return; count -= 1; if (count === 0) report(false); },
  };
}

type ModalCounter = ReturnType<typeof modalCounter>;
type ModalElement = Pick<HTMLDialogElement, 'open' | 'showModal' | 'addEventListener' | 'removeEventListener'>;

// Opens one <dialog> modally and counts it until it closes natively (Escape)
// or its component unmounts, whichever comes first; never both.
export function trackModalDialog(element: ModalElement | null, modals: ModalCounter) {
  let counted = true;
  const release = () => { if (!counted) return; counted = false; modals.closed(); };
  if (element && !element.open) element.showModal();
  modals.opened();
  element?.addEventListener('close', release);
  return () => { element?.removeEventListener('close', release); release(); };
}
