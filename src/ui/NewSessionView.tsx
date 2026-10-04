import { memo } from 'react';
import { Composer, type ComposerProps } from './Composer';
import { EmptyTerminal } from './EmptyTerminal';
import { composer } from './copy';

// The main column while no session is selected: a header and the composer
// (board B5). The column scrolls; no launch bar sits above a running terminal,
// so a session's terminal keeps the whole column. Memoized: App passes stable
// callbacks, so timeline and terminal events never re-render the composer.
// emptyTerminal (board 12, placement 6): the New session shortcut's label while the
// project has no session yet, so the empty terminal art shows under the composer; null hides it.
export const NewSessionView = memo(function NewSessionView({ emptyTerminal, ...props }: ComposerProps & { emptyTerminal: string | null }) {
  const { project } = props;
  return <div className="new-session-view">
    <div className="new-session-inner">
      <header className="new-session-header">
        <h1>{composer.newSession}</h1>
        <p>{composer.checkoutLine(project.name, project.branch ?? 'detached HEAD', project.head?.slice(0, 7) ?? 'unborn')}</p>
      </header>
      <Composer {...props} />
      {emptyTerminal !== null && <EmptyTerminal mark={props.mark} keys={emptyTerminal || null} />}
    </div>
  </div>;
});
