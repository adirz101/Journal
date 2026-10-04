import { Composer, type ComposerProps } from './Composer';
import { composer } from './copy';

// The main column while no session is selected: a header and the composer
// (board B5). The column scrolls; no launch bar sits above a running terminal,
// so a session's terminal keeps the whole column.
export function NewSessionView(props: ComposerProps) {
  const { project } = props;
  return <div className="new-session-view">
    <div className="new-session-inner">
      <header className="new-session-header">
        <h1>{composer.newSession}</h1>
        <p>{composer.checkoutLine(project.name, project.branch ?? 'detached HEAD', project.head?.slice(0, 7) ?? 'unborn')}</p>
      </header>
      <Composer {...props} />
    </div>
  </div>;
}
