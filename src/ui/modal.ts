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
