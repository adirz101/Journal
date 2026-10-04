import { memo } from 'react';
import { Composer, type ComposerProps } from './Composer';
import { composer } from './copy';

// The main column while no session is selected: a header and the composer
// (board B5). The column scrolls; no launch bar sits above a running terminal,
// so a session's terminal keeps the whole column. Memoized: App passes stable
// callbacks, so timeline and terminal events never re-render the composer.
export const NewSessionView = memo(function NewSessionView(props: ComposerProps) {
  const { project } = props;
  // One line that truncates; the title keeps the full path and branch.
  const checkout = composer.checkoutLine(project.name, project.branch ?? 'detached HEAD', project.head?.slice(0, 7) ?? 'unborn');
  return <div className="new-session-view">
    <div className="new-session-inner">
      <header className="new-session-header">
        <h1>{composer.newSession}</h1>
        <p title={checkout}>{checkout}</p>
      </header>
      <Composer {...props} />
    </div>
  </div>;
});
