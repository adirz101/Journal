import type { ReactNode } from 'react';
import { EmptyTerminal } from './EmptyTerminal';

// The main column while no session is selected: the launch form, then the
// empty terminal art. No launch bar sits above a running terminal, so a
// session's terminal keeps the whole column. Phase 4 replaces the form with the Composer.
// keys: the New session shortcut's label (bootstrap.shortcuts).
export function NewSessionView({ mark, keys = null, children }: { mark: string; keys?: string | null; children: ReactNode }) {
  return <div className="new-session-view">
    {children}
    <EmptyTerminal mark={mark} keys={keys} />
  </div>;
}
