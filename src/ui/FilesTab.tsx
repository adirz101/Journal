import { useEffect, useRef, type ReactNode } from 'react';
import { shell } from './copy';

// The inspector's Files tab: with a session, a choice between what it changed
// and the whole tree; without one, the tree alone.
// focusSignal (⌥⌘2 / Alt+Shift+2): the tree takes focus in All files (ExplorerPanel); in
// Changed, the view choice does, so the key always moves focus into Files, also out of the terminal.
export function FilesTab({ hasSession, view, onView, changed, changes, files, focusSignal = 0, onFocusHandled }: {
  hasSession: boolean; view: 'changed' | 'all'; onView(view: 'changed' | 'all'): void; changed: number; changes: ReactNode; files: ReactNode; focusSignal?: number; onFocusHandled?(): void;
}) {
  const checked = useRef<HTMLInputElement>(null);
  const takesSignal = hasSession && view === 'changed';
  useEffect(() => { if (focusSignal && takesSignal) { onFocusHandled?.(); requestAnimationFrame(() => checked.current?.focus()); } }, [focusSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!hasSession) return <>{files}</>;
  return <div className="files-tab">
    <div className="files-view" role="radiogroup" aria-label="Files view">
      {([['changed', shell.changedCount(changed)], ['all', shell.allFiles]] as const).map(([id, label]) => <label key={id} className={`segment${view === id ? ' on' : ''}`}><input ref={view === id ? checked : undefined} type="radio" name="files-view" checked={view === id} onChange={() => onView(id)} /> {label}</label>)}
    </div>
    {view === 'changed' ? changes : files}
  </div>;
}
