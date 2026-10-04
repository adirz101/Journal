import type { ReactNode } from 'react';

// The main column while no session is selected: the launch form, then the
// empty terminal art. No launch bar sits above a running terminal, so a
// session's terminal keeps the whole column. Phase 4 replaces the form with the Composer.
export function NewSessionView({ mark, children }: { mark: string; children: ReactNode }) {
  return <div className="new-session-view">
    {children}
    <div className="terminal-empty"><img className="terminal-brand-mark" src={mark} alt="" width={50} height={50} /><h2>A familiar place to work.</h2><p>Start an agent above. Your native login, settings,<br />and tool approvals stay with the CLI.</p></div>
  </div>;
}
