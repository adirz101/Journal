import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import type { Bootstrap, InspectorTab, Pane } from './types';
import { shell } from './copy';

const TABS: { id: InspectorTab; label: string }[] = [{ id: 'session', label: shell.tabSession }, { id: 'files', label: shell.tabFiles }, { id: 'memory', label: shell.tabMemory }];
const Icon = ({ d }: { d: string }) => <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={d} /></svg>;
const ICONS: Record<InspectorTab | 'show', string> = {
  session: 'M4 5h16v11H4ZM8 20h8M12 16v4', files: 'M6 3h8l4 4v14H6ZM14 3v4h4', memory: 'M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3ZM5 17a3 3 0 0 1 3-3h11', show: 'm15 6-6 6 6 6',
};

// The right-hand inspector (boards B4, B6): Session, Files and Memory tabs, or
// a 44 px rail of tab buttons. Tabs follow the WAI-ARIA pattern: arrows move
// between them (roving tabIndex), Home and End jump to the ends.
// overlayOpen: the overlay shows a tab (the rail marks it pressed). inOverlay: this full pane is that overlay (the rail keeps the ID).
export function Inspector({ pane, tab, onTab, badges, shortcuts, overlayOpen = false, inOverlay = false, onHide, onShow, children }: {
  pane: Pane; tab: InspectorTab; onTab(tab: InspectorTab): void; badges: { files: number; memory: number };
  shortcuts: Bootstrap['shortcuts'] | undefined; overlayOpen?: boolean; inOverlay?: boolean; onHide?(): void; onShow?(tab?: InspectorTab): void; children?: ReactNode;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const keys = (id: InspectorTab) => shortcuts?.[`tab-${id}`];
  const toggleKeys = shortcuts?.['toggle-inspector'];
  const badge = (id: InspectorTab) => id === 'files' ? badges.files : id === 'memory' ? badges.memory : 0;
  if (pane === 'rail') {
    const railName = (id: InspectorTab) => {
      const base = id === 'files' && badges.files ? `${shell.tabFiles}, ${badges.files} changed` : id === 'memory' && badges.memory ? `${shell.tabMemory}, ${badges.memory} suggestion${badges.memory === 1 ? '' : 's'}` : TABS.find(t => t.id === id)!.label;
      return keys(id) ? `${base} (${keys(id)!.label})` : base;
    };
    // While the overlay is open, the same button closes it.
    const toggleName = overlayOpen ? shell.hideInspector : shell.showInspector;
    return <aside className="knowledge-panel inspector-rail" id="knowledge-sidebar" aria-label={shell.inspector}>
      {TABS.map(({ id }) => <button key={id} className="rail-tile" aria-label={railName(id)} title={railName(id)} aria-keyshortcuts={keys(id)?.aria} aria-pressed={overlayOpen ? tab === id : undefined} onClick={() => { onTab(id); onShow?.(id); }}>
        <Icon d={ICONS[id]} />{badge(id) > 0 && <span className="badge count-badge" aria-hidden="true">{badge(id)}</span>}</button>)}
      <span className="rail-spacer" />
      <button className="rail-tile" aria-label={toggleName} title={toggleKeys ? `${toggleName} (${toggleKeys.label})` : toggleName} aria-keyshortcuts={toggleKeys?.aria} onClick={() => onShow?.()} disabled={!onShow}><Icon d={ICONS.show} /></button>
    </aside>;
  }
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + TABS.length - 1) % TABS.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    event.preventDefault(); onTab(TABS[next].id); tabs.current[next]?.focus();
  };
  return <aside className="knowledge-panel" id={inOverlay ? undefined : 'knowledge-sidebar'} aria-label={shell.inspector}>
    <div className="panel-tabs" role="tablist" aria-label={shell.inspector}>
      {TABS.map(({ id, label }, index) => <button key={id} ref={node => { tabs.current[index] = node; }} role="tab" id={`inspector-tab-${id}`} aria-selected={tab === id} aria-controls="inspector-panel" tabIndex={tab === id ? 0 : -1}
        aria-keyshortcuts={keys(id)?.aria} title={keys(id) ? `${label} (${keys(id)!.label})` : label} onClick={() => onTab(id)} onKeyDown={event => move(event, index)}>
        <span className="panel-tab-label">{label}{badge(id) > 0 && <span className="badge count-badge"><span className="visually-hidden">, </span>{badge(id)}</span>}</span></button>)}
      {onHide && <button className="panel-collapse" aria-label={shell.hideInspector} title={toggleKeys ? `${shell.hideInspector} (${toggleKeys.label})` : shell.hideInspector} aria-keyshortcuts={toggleKeys?.aria} onClick={onHide}>›</button>}
    </div>
    <div className="inspector-panel" id="inspector-panel" role="tabpanel" aria-labelledby={`inspector-tab-${tab}`}>{children}</div>
  </aside>;
}
