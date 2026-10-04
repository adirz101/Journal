import { useCallback, useEffect, useRef, useState } from 'react';

// Window layouts (boards B4, B10, B11). Wide windows dock both side panes;
// medium ones keep the sidebar and fold the inspector into a rail that opens
// an overlay; narrow ones fold both. Overlays never change the grid columns,
// so the terminal is never refitted when one opens or closes.
export type LayoutMode = 'wide' | 'medium' | 'narrow';
export const WIDE_MIN = 1440, MEDIUM_MIN = 1180;
export const layoutMode = (width: number): LayoutMode => width >= WIDE_MIN ? 'wide' : width >= MEDIUM_MIN ? 'medium' : 'narrow';

export type PaneState = 'full' | 'rail' | 'overlay' | 'none';
export interface LayoutPrefs { sidebarCollapsed: boolean; inspectorCollapsed: boolean }
export interface OpenOverlays { sidebar: boolean; inspector: boolean }

// What each pane shows. Stored preferences apply only where the pane can dock;
// at most one overlay shows, the inspector's if both are asked for.
export function paneStates(mode: LayoutMode, prefs: LayoutPrefs, open: OpenOverlays, hasInspector: boolean): { sidebar: PaneState; inspector: PaneState } {
  const inspector: PaneState = !hasInspector ? 'none' : mode === 'wide' ? (prefs.inspectorCollapsed ? 'rail' : 'full') : open.inspector ? 'overlay' : 'rail';
  const sidebar: PaneState = mode === 'narrow' ? (open.sidebar && inspector !== 'overlay' ? 'overlay' : 'rail') : prefs.sidebarCollapsed ? 'rail' : 'full';
  return { sidebar, inspector };
}

export const SIDEBAR_KEY = 'journal-sidebar-collapsed', INSPECTOR_KEY = 'journal-panel-collapsed';
const read = (key: string) => { try { return localStorage.getItem(key) === '1'; } catch { return false; } };
const write = (key: string, value: boolean) => { try { localStorage.setItem(key, value ? '1' : '0'); } catch { /* the choice still applies until reload */ } };

export interface ShellLayout {
  mode: LayoutMode; sidebar: PaneState; inspector: PaneState;
  toggleSidebar(): void; toggleInspector(): void; showInspector(): void; openSidebar(): void;
  // restoreFocus: return focus to where it was before the overlay opened (keyboard closes); a pointer close lets the click decide.
  closeOverlays(restoreFocus?: boolean): void; restoreFocus: { current: boolean };
}

// The mode follows two media queries, so dragging the window edge costs no
// React work between breakpoints. Only explicit toggles in modes where a pane
// docks write the stored preferences; automatic rails never do.
export function useShellLayout(hasInspector: boolean): ShellLayout {
  const query = (min: number) => typeof window.matchMedia === 'function' ? window.matchMedia(`(min-width:${min}px)`) : null;
  const measure = (): LayoutMode => { const wide = query(WIDE_MIN); const medium = query(MEDIUM_MIN); return wide ? (wide.matches ? 'wide' : medium!.matches ? 'medium' : 'narrow') : layoutMode(window.innerWidth); };
  const [mode, setMode] = useState<LayoutMode>(measure);
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => ({ sidebarCollapsed: read(SIDEBAR_KEY), inspectorCollapsed: read(INSPECTOR_KEY) }));
  const [open, setOpen] = useState<OpenOverlays>({ sidebar: false, inspector: false });
  const restoreFocus = useRef(true);
  useEffect(() => {
    const lists = [query(WIDE_MIN), query(MEDIUM_MIN)].filter(Boolean) as MediaQueryList[];
    const change = () => setMode(measure());
    for (const list of lists) list.addEventListener('change', change);
    return () => { for (const list of lists) list.removeEventListener('change', change); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A mode change closes any open overlay.
  useEffect(() => { restoreFocus.current = false; setOpen({ sidebar: false, inspector: false }); }, [mode]);
  const prefer = useCallback((key: keyof LayoutPrefs, value: boolean) => { setPrefs(current => ({ ...current, [key]: value })); write(key === 'sidebarCollapsed' ? SIDEBAR_KEY : INSPECTOR_KEY, value); }, []);
  const toggleSidebar = useCallback(() => {
    if (mode === 'narrow') { restoreFocus.current = true; setOpen(current => ({ sidebar: !current.sidebar, inspector: false })); }
    else prefer('sidebarCollapsed', !prefs.sidebarCollapsed);
  }, [mode, prefs.sidebarCollapsed, prefer]);
  const toggleInspector = useCallback(() => {
    if (mode === 'wide') prefer('inspectorCollapsed', !prefs.inspectorCollapsed);
    else { restoreFocus.current = true; setOpen(current => ({ sidebar: false, inspector: !current.inspector })); }
  }, [mode, prefs.inspectorCollapsed, prefer]);
  const showInspector = useCallback(() => {
    if (mode === 'wide') { if (prefs.inspectorCollapsed) prefer('inspectorCollapsed', false); }
    else setOpen({ sidebar: false, inspector: true });
  }, [mode, prefs.inspectorCollapsed, prefer]);
  const openSidebar = useCallback(() => { if (mode === 'narrow') setOpen({ sidebar: true, inspector: false }); else if (prefs.sidebarCollapsed) prefer('sidebarCollapsed', false); }, [mode, prefs.sidebarCollapsed, prefer]);
  const closeOverlays = useCallback((restore = true) => { restoreFocus.current = restore; setOpen({ sidebar: false, inspector: false }); }, []);
  const panes = paneStates(mode, prefs, open, hasInspector);
  return { mode, ...panes, toggleSidebar, toggleInspector, showInspector, openSidebar, closeOverlays, restoreFocus };
}
