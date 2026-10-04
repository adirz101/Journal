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

// Whether a modal dialog is open, or a command has just asked for one that is not open yet
// (Phase 8 review I5). The terminal drops its input meanwhile, so a key typed right after
// ⌘K or ⌘P never reaches the agent before the palette has focus.
// returnTo: what had focus when the command came (the terminal, which lets go of the keyboard
// at once); the dialog gives focus back to it when it closes (useModalDialog, takeReturnFocus).
let openDialogs = 0; let expectedUntil = 0; let returnTo: unknown = null;
const EXPECT_MS = 1000;
export function expectModalDialog(now = Date.now(), focused: unknown = null) { expectedUntil = now + EXPECT_MS; returnTo = focused; }
export function modalDialogActive(now = Date.now()) { return openDialogs > 0 || now < expectedUntil; }
export function takeReturnFocus(now = Date.now()): unknown { const target = now < expectedUntil ? returnTo : null; returnTo = null; return target; }

// Opens one <dialog> modally and counts it until it closes natively (Escape)
// or its component unmounts, whichever comes first; never both.
export function trackModalDialog(element: ModalElement | null, modals: ModalCounter) {
  let counted = true;
  const release = () => { if (!counted) return; counted = false; openDialogs = Math.max(0, openDialogs - 1); modals.closed(); };
  if (element && !element.open) element.showModal();
  openDialogs += 1; expectedUntil = 0;
  modals.opened();
  element?.addEventListener('close', release);
  return () => { element?.removeEventListener('close', release); release(); };
}

// One or more replies the terminal sends on its own to a CLI's queries: DA1/DA2 (CSI ? … c,
// CSI > … c), cursor position (CSI row;col R), DECRQM (CSI ? … $ y), kitty keyboard flags (CSI ? … u),
// OSC and DCS reports. They pass while a dialog is open: they are not keys, and a CLI waiting for
// one would otherwise hang. (Shift+F3 also reads CSI 1;2 R; only a key typed in the instant before a
// dialog takes focus could reach the terminal, so that overlap is accepted.)
export const TERMINAL_REPORT = /^(?:\x1b\[[?>][\d;]*c|\x1b\[\d+;\d+R|\x1b\[\??[\d;]*\$y|\x1b\[\?\d*u|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;
