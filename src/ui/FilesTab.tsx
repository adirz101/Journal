import type { ReactNode } from 'react';
import { shell } from './copy';

// The inspector's Files tab: with a session, a choice between what it changed
// and the whole tree; without one, the tree alone.
export function FilesTab({ hasSession, view, onView, changed, changes, files }: {
  hasSession: boolean; view: 'changed' | 'all'; onView(view: 'changed' | 'all'): void; changed: number; changes: ReactNode; files: ReactNode;
}) {
  if (!hasSession) return <>{files}</>;
  return <div className="files-tab">
    <div className="files-view" role="radiogroup" aria-label="Files view">
      {([['changed', shell.changedCount(changed)], ['all', shell.allFiles]] as const).map(([id, label]) => <label key={id} className={`segment${view === id ? ' on' : ''}`}><input type="radio" name="files-view" checked={view === id} onChange={() => onView(id)} /> {label}</label>)}
    </div>
    {view === 'changed' ? changes : files}
  </div>;
}
