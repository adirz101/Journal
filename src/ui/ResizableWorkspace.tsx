import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import type { Pane } from './types';
import type { ShellLayout } from './useShellLayout';

type Side = 'project' | 'knowledge';
type Widths = Record<Side, number | null>;
const storageKey = 'journal-panel-widths';
const limits = { project: { min: 176, max: 400 }, knowledge: { min: 260, max: 600 } };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(value)));

function storedWidths(): Widths {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
    const read = (side: Side) => typeof saved?.[side] === 'number' && Number.isFinite(saved[side])
      ? clamp(saved[side], limits[side].min, limits[side].max) : null;
    return { project: read('project'), knowledge: read('knowledge') };
  } catch { return { project: null, knowledge: null }; }
}

export const SIDEBAR_RAIL = 56, INSPECTOR_RAIL = 44;
// Accessible names; the side ids are also the keys of the stored widths.
const names: Record<Side, string> = { project: 'project sidebar', knowledge: 'side panel' };
const overlayWidth = { project: (stored: number | null) => clamp(stored ?? 264, 220, 300), knowledge: (stored: number | null, wide: boolean) => wide ? Math.min(720, Math.round(window.innerWidth * 0.5)) : clamp(stored ?? 384, 320, 420) };

// The shell grid: sidebar | main | inspector. Each side pane renders in full
// (resizable, wide windows), as a rail, or as a rail plus an overlay. An
// overlay sits out of flow above the main column, so opening or closing one
// never changes the grid and never refits the terminal. It is not modal: no
// focus trap, no scrim. Esc closes it only from inside it or its rail (Esc in
// the terminal belongs to the CLI); a pointer press elsewhere closes it too.
// wide: the inspector widens while a file is previewed (not saved).
export function ResizableWorkspace({ layout, wide = false, sidebar, inspector, children }: {
  layout: ShellLayout; wide?: boolean;
  sidebar: (pane: Pane, overlay: boolean) => ReactNode; inspector: ((pane: Pane, overlay: boolean) => ReactNode) | null; children: ReactNode;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(window.innerWidth);
  const [requested, setRequested] = useState<Widths>(storedWidths);
  const requestedRef = useRef(requested);
  useLayoutEffect(() => {
    const element = shell.current!;
    const measure = () => setContainerWidth(Math.floor(element.getBoundingClientRect().width));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const sidebarFull = layout.sidebar === 'full'; const inspectorState = inspector ? layout.inspector : 'none';
  const inspectorFull = inspectorState === 'full'; const inspectorRail = inspectorState === 'rail' || inspectorState === 'overlay';
  const compact = containerWidth <= 1150;
  // Boards B4 and B10: 264 px sidebar and 384 px inspector when wide, a 248 px sidebar in a medium window.
  const defaults = { project: compact ? 176 : containerWidth >= 1440 ? 264 : 248, knowledge: compact ? 304 : 384 };
  const workspaceMin = compact ? 340 : 390;
  let project = sidebarFull ? requested.project ?? defaults.project : SIDEBAR_RAIL;
  let knowledge = inspectorFull ? requested.knowledge ?? defaults.knowledge : inspectorRail ? INSPECTOR_RAIL : 0;
  if (inspectorFull && wide) knowledge = Math.max(knowledge, Math.min(720, Math.round(containerWidth * 0.5), limits.knowledge.max + 120));
  // Constrain the displayed widths, preserving the saved preference for larger windows.
  if (sidebarFull && inspectorFull && project + knowledge > containerWidth - workspaceMin) {
    const extra = project - limits.project.min + knowledge - limits.knowledge.min;
    const available = Math.max(0, containerWidth - workspaceMin - limits.project.min - limits.knowledge.min);
    const ratio = extra > 0 ? Math.min(1, available / extra) : 0;
    project = limits.project.min + Math.floor((project - limits.project.min) * ratio);
    knowledge = limits.knowledge.min + Math.floor((knowledge - limits.knowledge.min) * ratio);
  } else if (sidebarFull) project = Math.max(limits.project.min, Math.min(project, containerWidth - workspaceMin - knowledge));
  else if (inspectorFull) knowledge = Math.max(limits.knowledge.min, Math.min(knowledge, containerWidth - workspaceMin - project));
  const widths = { project, knowledge };
  const max = {
    project: Math.max(limits.project.min, Math.min(limits.project.max, containerWidth - workspaceMin - knowledge)),
    knowledge: Math.max(limits.knowledge.min, Math.min(limits.knowledge.max, containerWidth - workspaceMin - project)),
  };
  const maxRef = useRef(max); maxRef.current = max;
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(requestedRef.current)); } catch { /* Resizing still works without storage. */ }
  };
  const change = (side: Side, value: number | null, save = false) => {
    const next = { ...requestedRef.current, [side]: value === null ? null : clamp(value, limits[side].min, maxRef.current[side]) };
    requestedRef.current = next; setRequested(next); if (save) persist();
  };
  const overlay = layout.sidebar === 'overlay' ? 'sidebar' : inspectorState === 'overlay' ? 'inspector' : null;
  const style = { '--sidebar-width': `${project}px`, '--knowledge-width': `${knowledge}px`, '--workspace-min-width': `${workspaceMin}px`,
    gridTemplateColumns: `${project}px minmax(${Math.min(workspaceMin, 300)}px, 1fr)${knowledge ? ` ${knowledge}px` : ''}` } as CSSProperties;
  // Keyboard: Esc from inside an overlay or a rail closes it and returns focus.
  const escape = (event: KeyboardEvent<HTMLElement>) => { if (event.key === 'Escape' && overlay) { event.preventDefault(); layout.closeOverlays(true); } };
  return <div ref={shell} className={`app-shell mode-${layout.mode}`} style={style}>
    <div className="shell-pane" data-shell-pane="sidebar" onKeyDown={escape}>{sidebar(sidebarFull ? 'full' : 'rail', false)}</div>
    {children}
    {inspector && inspectorState !== 'none' && <div className="shell-pane" data-shell-pane="inspector" onKeyDown={escape}>{inspector(inspectorFull ? 'full' : 'rail', false)}</div>}
    {overlay && <Overlay key={overlay} side={overlay} layout={layout} width={overlay === 'sidebar' ? overlayWidth.project(requested.project) : overlayWidth.knowledge(requested.knowledge, wide)} onKeyDown={escape}>
      {overlay === 'sidebar' ? sidebar('full', true) : inspector!('full', true)}</Overlay>}
    {sidebarFull && <ResizeHandle side="project" value={widths.project} max={max.project} onChange={change} onCommit={persist} />}
    {inspectorFull && !wide && <ResizeHandle side="knowledge" value={widths.knowledge} max={max.knowledge} onChange={change} onCommit={persist} />}
  </div>;
}

// An open overlay: focus moves into it and comes back where it was when it closes.
function Overlay({ side, layout, width, onKeyDown, children }: { side: 'sidebar' | 'inspector'; layout: ShellLayout; width: number; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null; const node = box.current!;
    const target = side === 'inspector' ? node.querySelector<HTMLElement>('[role=tab][aria-selected=true]') : node.querySelector<HTMLElement>('.session-select[aria-current=true]') ?? node.querySelector<HTMLElement>('.new-session');
    target?.focus({ preventScroll: true });
    // A pointer press outside the overlay and both rails closes it; the click decides focus. Dialogs opened from it are inside.
    const outside = (event: Event) => {
      const at = event.target as Element | null;
      if (!at || node.contains(at) || at.closest('[data-shell-pane]') || at.closest('dialog[open]')) return;
      layout.closeOverlays(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      if (!layout.restoreFocus.current) return;
      if (previous?.isConnected && previous !== document.body) previous.focus({ preventScroll: true });
      else window.dispatchEvent(new CustomEvent('journal:focus-terminal'));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <div ref={box} className={`shell-overlay ${side}-overlay`} style={{ width }} onKeyDown={onKeyDown}>{children}</div>;
}

function ResizeHandle({ side, value, max, onChange, onCommit }: {
  side: Side; value: number; max: number;
  onChange: (side: Side, value: number | null, save?: boolean) => void; onCommit: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; width: number } | null>(null);
  const frame = useRef(0); const latestX = useRef(0);
  const direction = side === 'project' ? 1 : -1;
  useLayoutEffect(() => () => cancelAnimationFrame(frame.current), []);
  const update = (x: number) => {
    const start = drag.current;
    if (start) onChange(side, start.width + (x - start.x) * direction);
  };
  const finish = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (drag.current?.id !== event.pointerId) return;
    cancelAnimationFrame(frame.current); frame.current = 0;
    if (!cancelled) update(event.clientX);
    drag.current = null; setDragging(false); onCommit();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return <div className={`panel-resizer ${side}-resizer${dragging ? ' dragging' : ''}`}
    role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${names[side]}`}
    aria-controls={side === 'project' ? 'project-sidebar' : 'knowledge-sidebar'}
    aria-valuemin={limits[side].min} aria-valuemax={max} aria-valuenow={value} aria-valuetext={`${value} pixels`}
    title="Drag or use arrow keys to resize. Double-click to reset."
    onPointerDown={event => {
      if (event.button !== 0 || drag.current) return;
      event.preventDefault(); event.currentTarget.blur(); event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { id: event.pointerId, x: event.clientX, width: value }; setDragging(true);
    }}
    onPointerMove={event => {
      if (drag.current?.id !== event.pointerId) return;
      latestX.current = event.clientX;
      if (!frame.current) frame.current = requestAnimationFrame(() => { frame.current = 0; update(latestX.current); });
    }}
    onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)}
    onLostPointerCapture={event => finish(event, true)}
    onDoubleClick={() => onChange(side, null, true)}
    onKeyDown={event => {
      const step = event.shiftKey ? 24 : 8;
      const next = event.key === 'ArrowLeft' ? value - step * direction : event.key === 'ArrowRight' ? value + step * direction
        : event.key === 'Home' ? limits[side].min : event.key === 'End' ? max : event.key === 'Enter' ? null : undefined;
      if (next === undefined) return;
      event.preventDefault(); onChange(side, next, true);
    }} />;
}
