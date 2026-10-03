import { useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent, type ReactNode } from 'react';

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

export const RAIL_WIDTH = 34;
// collapsed: the right panel shrinks to a rail; wide: it widens while a file is previewed (not saved).
export function ResizableWorkspace({ hasKnowledge, collapsed = false, wide = false, children }: { hasKnowledge: boolean; collapsed?: boolean; wide?: boolean; children: ReactNode }) {
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

  const compact = containerWidth <= 1150;
  const defaults = { project: compact ? 176 : 218, knowledge: compact ? 304 : 350 };
  const workspaceMin = compact ? 340 : 390;
  let project = requested.project ?? defaults.project;
  let knowledge = hasKnowledge ? requested.knowledge ?? defaults.knowledge : 0;
  if (hasKnowledge && wide && !collapsed) knowledge = Math.max(knowledge, Math.min(720, Math.round(containerWidth * 0.5), limits.knowledge.max + 120));
  // Constrain the displayed widths, preserving the saved preference for larger windows.
  if (hasKnowledge && collapsed) { project = Math.min(project, containerWidth - workspaceMin - RAIL_WIDTH); knowledge = RAIL_WIDTH; }
  else if (hasKnowledge && project + knowledge > containerWidth - workspaceMin) {
    const extra = project - limits.project.min + knowledge - limits.knowledge.min;
    const available = Math.max(0, containerWidth - workspaceMin - limits.project.min - limits.knowledge.min);
    const ratio = extra > 0 ? Math.min(1, available / extra) : 0;
    project = limits.project.min + Math.floor((project - limits.project.min) * ratio);
    knowledge = limits.knowledge.min + Math.floor((knowledge - limits.knowledge.min) * ratio);
  } else if (!hasKnowledge) project = Math.min(project, containerWidth - workspaceMin);
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
  const style = { '--sidebar-width': `${project}px`, '--knowledge-width': `${knowledge}px`, '--workspace-min-width': `${workspaceMin}px` } as CSSProperties;
  return <div ref={shell} className="app-shell" style={style}>
    {children}
    <ResizeHandle side="project" value={widths.project} max={max.project} onChange={change} onCommit={persist} />
    {hasKnowledge && !collapsed && !wide && <ResizeHandle side="knowledge" value={widths.knowledge} max={max.knowledge} onChange={change} onCommit={persist} />}
  </div>;
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
    role="separator" tabIndex={0} aria-orientation="vertical" aria-label={`Resize ${side} sidebar`}
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
