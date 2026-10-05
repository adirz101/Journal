import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { KnowledgePanel, type MemoryFilters } from './KnowledgePanel';
import { ResizableWorkspace } from './ResizableWorkspace';
import { useShellLayout } from './useShellLayout';
import { useProposals } from './useProposals';
import { Sidebar } from './Sidebar';
import { nextNeedsYou, resumable, slotOrder, slotTarget, stateFor } from './sessionState';
import { ChangesPanel } from './ChangesPanel';
import { WorkspaceDialog } from './WorkspaceDialog';
import { ContextPanel } from './ContextPanel';
import { ExplorerPanel } from './ExplorerPanel';
import { ProcessDialog } from './ProcessDialog';
import { UpdateNotice, useUpdateState } from './UpdateNotice';
import { SettingsDialog } from './SettingsDialog';
import { ManageProjectDialog } from './ManageProjectDialog';
import { RenameDialog } from './RenameDialog';
import { CommandPalette } from './CommandPalette';
import { RuntimeBanner } from './RuntimeBanner'; // Phase 8
import { RecoveryPanel } from './RecoveryPanel'; // Phase 8
import { recoveryView } from './statesModel'; // Phase 8
import { firstEnabled, useKeepFocus } from './useKeepFocus';

import { PALETTE_ACTIONS, type PaletteActionId } from './paletteModel'; // Phase 8
import { expectModalDialog } from './modal'; // Phase 8 review I5
import { Inspector } from './Inspector';
import { SessionTab } from './SessionTab';
import { FilesTab } from './FilesTab';
import { MemoryTab } from './MemoryTab';
import { NewSessionView } from './NewSessionView';
import { AttentionBanner, SessionHeader } from './SessionHeader';
import { StatusBar } from './StatusBar';
import { useSessionChanges, useSessionEvents } from './useSessionData';
import { diffSummary } from './sessionView';
import { showMenu } from './menu';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import { storedAppearance, type Appearance } from './theme';
import { composer, copy, firstRun, palette as paletteCopy, providers, shell, states as statesCopy, wrapUp as wrapUpCopy } from './copy';
// Phase 7: first run (Welcome, Getting to know your project, the first-note moment).
import { Welcome } from './Welcome';
import { DraftsMoved, GettingToKnow, type DraftParts } from './GettingToKnow';
import { FirstNoteMoment } from './FirstNoteMoment';
import type { ProviderBusy, ProviderHandlers } from './AgentRow';
import { claimFirstNote, settleFirstNote } from './firstNote';
import { displayVersion } from './firstRunModel';
import { defaultProvider, isProvider, modeFlags } from './composerModel';
import { EndedTerminal, WrapUp } from './WrapUp'; // Phase 6
import { endedView, type HandoffPrefill } from './wrapUpModel'; // Phase 6
import { keyLetter } from './keys';
import { api, errorCode, isLive, PROVIDER_NAMES, type AgentInfo, type Bootstrap, type CommandId, type FirstRunDrafts, type ProcessKind, type FileReference, type InspectorTab, type Memory, type Mode, type Project, type ProjectState, type Provider, type Receipt, type Recovery, type Session, type StatusDraft, type TimelineEvent, type WorkspaceList } from './types';

// The main column's place for keyboard focus when a banner or panel above it goes away.
const mainFocusTarget = () => document.querySelector<HTMLElement>('main.workspace .terminal-surface .xterm-helper-textarea')
  ?? document.querySelector<HTMLElement>('#wrapup-title') ?? document.getElementById('task')
  ?? document.querySelector<HTMLElement>('main.workspace button:not(:disabled)');

const MAX_SESSIONS = 4;
const NO_KEYS = {}; // Phase 8: the palette's keys before bootstrap
const latest = (a: string | null | undefined, b: string | null | undefined) => !a ? b : !b ? a : a > b ? a : b;
// Phase 7: what an install or sign-in changed, from the providers event main sends after it ends.
function providerNote(provider: Provider, kind: ProcessKind, next: AgentInfo) {
  const name = PROVIDER_NAMES[provider];
  if (kind === 'install') {
    if (provider === 'cursor') return next.available ? providers.cursorInstalled(displayVersion(next.version), next.state === 'login-required') : next.state === 'not-cursor' ? providers.cursorImpostor : providers.cursorNotFound;
    return next.available ? providers.installedHere(name) : providers.offPath(name);
  }
  return next.auth === 'signed-in' ? providers.signedInTo(name) : next.auth === 'signed-out' ? providers.stillSignedOut(name) : providers.signInUnconfirmed(name);
}

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const journalMark = appearance === 'light' ? journalMarkDark : journalMarkWhite;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try { localStorage.setItem('journal-theme', appearance); } catch { /* Keep the toggle usable if storage is unavailable. */ }
  }, [appearance]);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null); const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectState | null>(null);
  const [sessions, setSessions] = useState<Record<string, Session>>({}); const [selectedId, setSelectedId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null); const [task, setTask] = useState('');
  const [panel, setPanel] = useState<InspectorTab>('memory');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; supersedes?: Memory; initialCategory?: string; initialStatement?: string; draft?: StatusDraft; firstRun?: 'checkout' | 'branch'; after?: () => void } | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  // Phase 5: note trust lines refetch on note changes and when a session starts running (a new delivery).
  // statuses: each live session's last status, pruned when sessions disappear.
  const [runVersion, setRunVersion] = useState(0); const statuses = useRef(new Map<string, string>());
  const trustVersion = knowledgeVersion + runVersion;
  useEffect(() => { for (const id of [...statuses.current.keys()]) if (!sessions[id]) statuses.current.delete(id); }, [sessions]);
  // The Memory tab's filters: kept across tab switches, reset when the project changes
  // (a return to an earlier project starts from the defaults too).
  const [memoryFilters, setMemoryFilters] = useState<MemoryFilters | null>(null);
  const filtersProject = state?.project.id ?? null; const [filtersFor, setFiltersFor] = useState<string | null>(filtersProject);
  if (filtersFor !== filtersProject) { setFiltersFor(filtersProject); setMemoryFilters(null); }
  const [runtime, setRuntime] = useState<{ state: string; warning?: string | null }>({ state: 'connecting' });
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  // File and command-end events per session, counted as they arrive: liveEvents is capped, so its length stops changing.
  const [fileEventCounts, setFileEventCounts] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now());
  const [workspaces, setWorkspaces] = useState<WorkspaceList | null>(null); const [workspaceId, setWorkspaceId] = useState<string>('');
  // === Phase 4: composer state ===
  // The agent choice is remembered on this computer; the mode starts at Build and is never changed for the user.
  const [mode, setMode] = useState<Mode>('build'); const [startError, setStartError] = useState<{ code?: string; message: string } | null>(null);
  const rememberedAgent = useRef<string | null | undefined>(undefined);
  if (rememberedAgent.current === undefined) rememberedAgent.current = (() => { try { const value = localStorage.getItem('journal-agent'); return isProvider(value) ? value : null; } catch { return null; } })();
  const [provider, setProviderState] = useState<Provider>(() => defaultProvider(undefined, rememberedAgent.current ?? null));
  // Until the user (or a hand-off) picks an agent, the default follows detection: an agent still
  // being checked when bootstrap answered must not lose its place to a later one (Phase 9).
  // The user takes the choice over by choosing a card, starting a session or editing the task box;
  // a hand-off and a remembered agent count as chosen. A change made here clears a start error,
  // which belonged to the previous agent.
  const providerAuto = useRef(true);
  const autoProvider = (agents: AgentInfo[] | undefined) => {
    if (!providerAuto.current || rememberedAgent.current) return;
    const next = defaultProvider(agents, null);
    setProviderState(current => { if (current !== next) setStartError(null); return next; });
  };
  const editTask = useCallback((value: string) => { providerAuto.current = false; setTask(value); }, []);
  const chooseProvider = (next: Provider) => { providerAuto.current = false; setProviderState(next); setStartError(null); rememberedAgent.current = next; try { localStorage.setItem('journal-agent', next); } catch { /* optional */ } };
  // === End Phase 4: composer state ===
  const [processView, setProcessView] = useState<{ id: string; title: string; command?: string; provider: Provider; kind: ProcessKind } | null>(null);
  // === Phase 7: first run state ===
  // providerNotes: what the last install or sign-in changed, per provider; providerBusy: an action or check in flight.
  const [providerNotes, setProviderNotes] = useState<Partial<Record<Provider, string>>>({}); const [providerBusy, setProviderBusy] = useState<ProviderBusy>({});
  // Getting to know your project: asked once per project per app run (D10), and again once an
  // unborn repository has its first commit (the key holds whether HEAD exists). Drafts are kept
  // per project, so a reply for a project that is not current waits for it; main marks the
  // project shown only after the screen paints (markOrientationShown). answered: asks that replied.
  const [firstRunDrafts, setFirstRunDrafts] = useState<Record<string, FirstRunDrafts>>({}); const askedFirstRun = useRef(new Set<string>());
  const [answeredFirstRun, setAnsweredFirstRun] = useState<ReadonlySet<string>>(() => new Set());
  // The first-note moment: never claimed before bootstrap says whether the install already had notes.
  // 'new' plays its entrance; 'entered' after it ended, so a move between top and bottom never replays it.
  const hasNotesAtStart = useRef(true); const [firstNote, setFirstNote] = useState<null | 'new' | 'entered'>(null);
  const [justRemembered, setJustRemembered] = useState<ReadonlySet<string>>(() => new Set());
  // Where a folder drag would land: the Welcome screen (no project open) or the sidebar.
  const [dragging, setDragging] = useState<null | 'welcome' | 'sidebar'>(null); const [dropError, setDropError] = useState('');
  // === End Phase 7: first run state ===
  const [workspaceDialog, setWorkspaceDialog] = useState(false); const [disabled, setDisabled] = useState<string[]>([]); const [settingsOpen, setSettingsOpen] = useState(false); const [manageId, setManageId] = useState<string | null>(null);
  // === Phase 8: palette and states ===
  // The command palette (null when closed); purpose reference: the composer's Add reference….
  // lead: the action listed (and active) first; open-file without a project leads with Open project….
  const [palette, setPalette] = useState<{ mode: 'all' | 'files'; purpose: 'open' | 'reference'; lead?: PaletteActionId } | null>(null);
  // A note or file opened from the palette (seq: one request each).
  const [memoryFocus, setMemoryFocus] = useState<{ id: string; seq: number } | null>(null);
  // The Files tab's shown root while it is mounted (null after it unmounts: it then follows the session again).
  const [explorerRoot, setExplorerRoot] = useState<{ projectId: string; rootKey: string } | null>(null);
  const onExplorerRoot = useCallback((projectId: string, rootKey: string | null) => setExplorerRoot(rootKey ? { projectId, rootKey } : null), []);
  const [filesReveal, setFilesReveal] = useState<{ projectId: string; rootKey: string; path: string; seq: number } | null>(null);
  // Sessions a crashed runtime left behind, until Done (acknowledgeRecovery); loadedAt: the recovery whose rows are fetched.
  const [recovery, setRecovery] = useState<Recovery | null>(null); const [recoveryLoadedAt, setRecoveryLoadedAt] = useState<string | null>(null);
  // === End Phase 8 ===
  const [renameTarget, setRenameTarget] = useState<{ kind: 'project'; project: Project } | { kind: 'session'; session: Session } | null>(null);
  // Right panel: collapsible, wider while previewing a file; references chosen for the next task.
  const update = useUpdateState();
  const [previewing, setPreviewing] = useState(false); const [explorerFocus, setExplorerFocus] = useState(0);
  // The Files tab's view: the user's last choice for this app run, else Changed while the session changed something.
  const [filesChoice, setFilesChoice] = useState<'changed' | 'all' | null>(null); const [packetRequest, setPacketRequest] = useState<number | null>(null);
  const [references, setReferences] = useState<FileReference[]>([]); const [evidenceSource, setEvidenceSource] = useState<{ kind: 'file'; path: string; startLine: number; endLine: number; rootId?: string } | null>(null);
  // References belong to the project they were chosen in; switching projects drops them (and a refused start's note).
  useEffect(() => { setReferences([]); setEvidenceSource(null); setStartError(null); }, [state?.project.id]);
  const referenceInputs = references.map(ref => ({ projectId: ref.projectId, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine }));
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; value: string } | null>(null);
  const session = selectedId ? sessions[selectedId] ?? null : null;
  // A confirmation draft belongs to one launch, never to another conversation.
  const resumeValue = resumeDraft?.sessionId === session?.id ? resumeDraft?.value ?? '' : session?.nativeId ?? '';
  // === Phase 6: session end ===
  // Show terminal is chosen per ended session for this app run (never stored).
  const [terminalShown, setTerminalShown] = useState<Record<string, boolean>>({});
  // The selected session was live on the previous render: it just ended under the user.
  const liveSeen = useRef<string | null>(null);
  const justEnded = !!session && !isLive(session) && liveSeen.current === session.id;
  useEffect(() => { liveSeen.current = session && isLive(session) ? session.id : null; });
  const wrapUpShown = !!session && !!endedView(session) && !terminalShown[session.id];
  // === End Phase 6 ===
  const taskRef = useRef<HTMLTextAreaElement>(null); const removedIds = useRef(new Set<string>()); const projectRef = useRef<Project | null>(null);
  // Set once the user picks a project or session: the startup selection, which
  // waits for project data, must not override a choice made meanwhile.
  const userChose = useRef(false);
  // The newest providers event: one that arrives before bootstrap resolves is applied then.
  const latestAgents = useRef<Bootstrap['agents'] | null>(null);
  projectRef.current = state?.project ?? null;
  const connected = runtime.state === 'connected';
  // Wide, medium or narrow window: which side panes dock, fold to rails or open as overlays.
  // Phase 7: Getting to know your project takes the main column without the inspector (board 2).
  const currentDrafts = state ? firstRunDrafts[state.project.id] ?? null : null;
  const showFirstRun = !!state && !session && !!currentDrafts;
  const orientationKey = state ? `${state.project.id}:${state.project.head ? 'born' : 'unborn'}` : null;
  // Until firstRunDrafts answers for a project that needs orientation, the main column waits
  // (no composer to type into that the screen would replace).
  const firstRunPending = !!state && !session && !currentDrafts && !!state.needsOrientation && !!orientationKey && !answeredFirstRun.has(orientationKey);
  const layout = useShellLayout(!!state && !showFirstRun && !firstRunPending);
  const failed = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  // Open suggestions, fetched once for the window: the `proposals` event and memory changes bump knowledgeVersion.
  const proposals = useProposals(state?.project.id ?? null, knowledgeVersion, failed);
  // Older snapshots (for example a slow store read) never replace newer runtime state,
  // and a snapshot read before a removal never brings the removed session back.
  const merge = useCallback((items: Session[]) => setSessions(current => {
    const next = { ...current };
    for (const item of items) {
      if (item.removed || removedIds.current.has(item.id)) continue; const known = next[item.id];
      // Output time only moves forward: an activity event can be newer than a stored snapshot of the same version.
      if (!known || (item.version ?? 0) >= (known.version ?? 0)) next[item.id] = { ...known, ...item, lastOutputAt: latest(known?.lastOutputAt, item.lastOutputAt) };
    }
    return next;
  }), []);
  // Activity events (Codex, Cursor) patch the output time without a version: status events stay the authority.
  const noteActivity = useCallback((sessionId: string, lastOutputAt: string) => setSessions(current => {
    const known = current[sessionId]; const next = latest(known?.lastOutputAt, lastOutputAt);
    return !known || next === known.lastOutputAt ? current : { ...current, [sessionId]: { ...known, lastOutputAt: next } };
  }), []);
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance, failed]);
  // Relative times only; no animation. While a live Codex or Cursor session is
  // listed, tick every 5 s so "output just now" ends within 5 s of its 10 s threshold.
  const outputClock = Object.values(sessions).some(s => !s.removed && isLive(s) && s.provider !== 'claude');
  useEffect(() => { setNow(Date.now()); const timer = setInterval(() => setNow(Date.now()), outputClock ? 5000 : 15000); return () => clearInterval(timer); }, [outputClock]);
  // The latest refresh's project wins: a slower, older refresh (a checkout poll of project A that
  // answers after the user chose project B) neither shows nor remembers A.
  const refreshTarget = useRef<string | null>(null);
  const refresh = useCallback(async (id?: string) => {
    // Without an id, the project last asked for (it may still be loading), else the one shown.
    const projectId = id ?? refreshTarget.current ?? projectRef.current?.id; if (!projectId) return;
    refreshTarget.current = projectId;
    const next = await api<ProjectState>('project', { projectId });
    if (refreshTarget.current !== projectId) return;
    setState(next); merge(next.sessions);
    // The shown project is remembered as soon as it renders, so a reload (⌘R in development,
    // or the renderer coming back after a crash) reopens it even straight after opening it.
    try { localStorage.setItem('journal-project', next.project.id); } catch { /* optional */ }
    const list = await api<WorkspaceList>('workspaces', { projectId }).catch(() => null);
    if (refreshTarget.current !== projectId) return next;
    setWorkspaces(list);
    setWorkspaceId(current => list?.workspaces.some(w => w.id === current && w.state === 'ready') || next.project.roots?.some(root => `root:${root.id}` === current) ? current : '');
    return next;
  }, [merge]);
  // Branch switches happen outside Journal (terminal, editor, the agent itself):
  // poll the checkout while visible and on focus, and refresh when it moved.
  useEffect(() => {
    let busy = false;
    const check = async () => {
      const current = projectRef.current; if (!current || busy || document.visibilityState !== 'visible') return;
      busy = true;
      try {
        const checkout = await api<{ branch: string | null; head: string | null }>('checkout', { projectId: current.id });
        if (projectRef.current?.id === current.id && (checkout.branch !== current.branch || checkout.head !== current.head)) { await refresh(current.id); setKnowledgeVersion(v => v + 1); }
      } catch { /* the next tick retries; project errors surface on explicit actions */ } finally { busy = false; }
    };
    const timer = setInterval(() => void check(), 3000);
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); };
  }, [refresh]);
  const reloadProjects = useCallback(async () => setProjects(await api<Project[]>('projects')), []);
  const reloadSessions = useCallback(async () => {
    const result = await api<{ live: Session[]; active: Session[] }>('sessions'); merge([...result.active, ...result.live]);
  }, [merge]);
  useEffect(() => {
    void api<Bootstrap>('bootstrap').then(async data => {
      hasNotesAtStart.current = data.hasNotes; settleFirstNote(data.hasNotes); // Phase 7: an upgrading install never sees the first-note moment
      setBootstrap(latestAgents.current ? { ...data, agents: latestAgents.current } : data); setProjects(data.projects); autoProvider(latestAgents.current ?? data.agents); setRuntime(data.runtime); merge([...data.active, ...data.live]); setRecovery(data.recovery ?? null);
      const remembered = (() => { try { return localStorage.getItem('journal-project'); } catch { return null; } })();
      const firstLive = slotOrder([...data.active, ...data.live]).find(isLive);
      const selected = data.projects.find(p => p.id === (firstLive?.projectId ?? remembered));
      if (selected && !userChose.current) {
        const next = await refresh(selected.id); if (userChose.current) return;
        const live = data.live.find(s => isLive(s) && s.projectId === selected.id);
        if (live) { setSelectedId(live.id); setReceipt(await api<Receipt>('getReceipt', { id: live.receiptId })); }
        else if (next?.receipts[0]) setReceipt(next.receipts[0]);
      }
    }).catch(failed);
    return window.journal?.onEvent(event => {
      if (event.type === 'error') { setError(event.message); return; }
      if (event.type === 'runtime') {
        setRuntime({ state: event.state, warning: event.warning });
        // Phase 8: a connected event carries the recovery main holds (null when none or acknowledged).
        if (event.state === 'connected' && 'recovery' in event) setRecovery(event.recovery ?? null);
        if (event.state === 'connected') void reloadSessions().then(() => refresh()).catch(failed);
        return;
      }
      if (event.type === 'timeline') {
        setLiveEvents(current => [...current.slice(-1999), event.event]);
        const { sessionId, kind } = event.event;
        if (sessionId && (kind === 'file' || kind === 'command-end')) setFileEventCounts(current => ({ ...current, [sessionId]: (current[sessionId] ?? 0) + 1 }));
        return;
      }
      if (event.type === 'proposals') { setKnowledgeVersion(v => v + 1); return; }
      if (event.type === 'providers') {
        latestAgents.current = event.agents; setBootstrap(current => current ? { ...current, agents: event.agents } : current);
        autoProvider(event.agents);
        // After an install or sign-in exits, main checks that provider again and tags the result.
        const after = event.after; const next = after && event.agents.find(a => a.provider === after.provider);
        if (after && next) setProviderNotes(notes => ({ ...notes, [after.provider]: providerNote(after.provider, after.kind, next) }));
        return;
      }
      if (event.type === 'activity') { noteActivity(event.sessionId, event.lastOutputAt); return; }
      if (event.type !== 'status') return;
      // Main strips user-owned fields (names, pins, archive, removal) from runtime sessions.
      const before = statuses.current.get(event.session.id); statuses.current.set(event.session.id, event.session.status);
      // A launch's first transition to running is a new delivery; waiting → running (an approval) is not.
      if (event.session.status === 'running' && before !== 'running' && before !== 'waiting') setRunVersion(v => v + 1);
      merge([event.session]);
    });
  }, [refresh, reloadSessions, merge, noteActivity, failed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  // Only a real project change resets the selection and the task; a stopping session is not picked.
  async function chooseProject(project: Project) {
    userChose.current = true;
    if (project.id === state?.project.id) return;
    await run(async () => { const next = await refresh(project.id);
      const live = slotOrder(Object.values(sessions)).find(s => isLive(s) && s.status !== 'stopping' && s.projectId === project.id);
      setSelectedId(live?.id ?? null); setReceipt(next?.receipts[0] ?? null); setTask(''); });
  }
  async function opened(project: Project) {
    // Remembered before the refresh: its first reply already shows the project (and asks for
    // first-run drafts), so a reload while the rest of the refresh runs must reopen it.
    try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ }
    setProjects(items => [project, ...items.filter(p => p.id !== project.id)]); await refresh(project.id); setSelectedId(null); setReceipt(null);
    // The Welcome button that opened it is gone: the task box takes focus (Getting to know your project focuses its own heading).
    if (!document.activeElement || document.activeElement === document.body) setTaskFocus(n => n + 1);
  }
  async function openProject() {
    userChose.current = true;
    await run(async () => { const project = await api<Project | null>('openProject'); if (project) await opened(project); });
  }
  // Phase 7: a folder dropped on the Welcome screen or the sidebar opens like the open dialog.
  // One item only; a file that did not come from the OS (no path) gets a plain message; main checks the rest.
  const dropFolder = useRef<(files: FileList | undefined) => void>(() => {});
  dropFolder.current = files => {
    const say = (message: string) => { if (projectRef.current) setError(message); else setDropError(message); };
    setDropError('');
    if (files && files.length > 1) { say(firstRun.dropOne); return; }
    const path = files?.[0] ? window.journal?.pathForFile(files[0]) ?? '' : '';
    if (!path) { say(firstRun.dropNotFolder); return; }
    userChose.current = true;
    void run(async () => { await opened(await api<Project>('openProjectPath', { path })); });
  };
  useEffect(() => {
    // Only files from the OS, only on the Welcome screen (no project open) or the sidebar, never behind a dialog.
    // Both show the drop target while a drag is over them (a class toggle, no motion).
    const target = (event: DragEvent): 'welcome' | 'sidebar' | null => !event.dataTransfer?.types.includes('Files') || document.querySelector('dialog[open]') ? null
      : !projectRef.current ? 'welcome' : event.target instanceof Element && event.target.closest('.sidebar') ? 'sidebar' : null;
    // Entering a child fires dragenter on it before dragleave on the parent, so the count
    // only reaches 0 when the drag leaves the window (no flicker between elements).
    let depth = 0;
    const enter = () => { depth++; };
    const over = (event: DragEvent) => { const where = target(event); setDragging(where); if (!where) return; event.preventDefault(); event.dataTransfer!.dropEffect = 'copy'; };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(null); };
    const end = () => { depth = 0; setDragging(null); };
    const drop = (event: DragEvent) => { const where = target(event); end(); if (!where) return; event.preventDefault(); dropFolder.current(event.dataTransfer?.files); };
    const events = [['dragenter', enter], ['dragover', over], ['dragleave', leave], ['dragend', end], ['drop', drop]] as const;
    for (const [name, handler] of events) window.addEventListener(name, handler as (event: DragEvent) => void);
    return () => { for (const [name, handler] of events) window.removeEventListener(name, handler as (event: DragEvent) => void); };
  }, []);
  // The sidebar's drop target (styles.css: :root[data-drop]).
  useEffect(() => { if (dragging === 'sidebar') document.documentElement.dataset.drop = 'sidebar'; else delete document.documentElement.dataset.drop; }, [dragging]);
  const ordered = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions]);
  const liveCount = ordered.filter(isLive).length;
  const canStart = connected && liveCount < MAX_SESSIONS;
  async function selectSession(next: Session) {
    userChose.current = true;
    await run(async () => {
      if (next.projectId !== state?.project.id) await refresh(next.projectId);
      setSelectedId(next.id); setReceipt(await api<Receipt>('getReceipt', { id: next.receiptId }));
    });
  }
  // The task box takes focus once the New session view has rendered (an effect, not a frame callback, which can run before the commit).
  const [taskFocus, setTaskFocus] = useState(0);
  useEffect(() => { if (taskFocus) taskRef.current?.focus(); }, [taskFocus]);
  // New session also leaves Getting to know your project; its drafts are dropped (decision 3),
  // but only when the screen was showing: drafts not yet seen wait for their project.
  function newSession() {
    userChose.current = true; setSelectedId(null); setTaskFocus(n => n + 1);
    const shownFor = showFirstRun && state ? state.project.id : null;
    if (shownFor) setFirstRunDrafts(current => { const next = { ...current }; delete next[shownFor]; return next; });
  }
  // === Phase 6: hand-off (D12) fills the composer and never starts a session ===
  // The agent is preselected for this hand-off only; the remembered default agent is not changed.
  function handoff(prefill: HandoffPrefill) {
    newSession(); setTask(prefill.task); setReferences(prefill.references); setWorkspaceId(prefill.workspaceId); setDisabled([]);
    providerAuto.current = false; setProviderState(prefill.provider); setMode(prefill.mode); setStartError(null);
    requestAnimationFrame(() => { const field = taskRef.current; if (field) field.setSelectionRange(field.value.length, field.value.length); });
  }
  // === End Phase 6 ===
  // === Region: command handler (Phase 3: A adds settings, B the tab commands, C the layout toggles) ===
  // App shortcuts arrive as commands from the main process (src/desktop/shortcuts.mjs),
  // so they also work while the terminal has focus. The ref keeps the handler current.
  // Phase 8: why a command is unavailable, or null; the keys and the palette share it
  // (the palette lists a blocked action with this reason). Busy has a reason only for the
  // commands that wait for it (slot switches and next-needs-you are handled below).
  const commandBlock = (id: PaletteActionId): string | null => {
    const reasons = paletteCopy.reasons;
    if (id === 'next-needs-you') return busy ? reasons.busy : nextNeedsYou(ordered, selectedId) ? null : reasons.noneNeedsYou;
    if (id === 'open-project') return busy ? reasons.busy : null;
    // open-file without a project opens the palette with Open project… first (plan 3, B1).
    if (id === 'settings' || id === 'toggle-sidebar' || id === 'command-palette' || id === 'open-file' || id === 'check-agents' || /^slot-/.test(id)) return null;
    if (!state) return reasons.needsProject;
    if (id === 'focus-terminal') return session ? null : reasons.needsSession;
    return null;
  };
  const command = useRef<(id: CommandId) => void>(() => {});
  const runCommand = useRef<(id: CommandId) => void>(() => {});
  command.current = id => {
    // An open dialog owns the keyboard. Main stops claiming keys once it hears
    // about the dialog (setModalOpen); this covers a key pressed before that.
    if (document.querySelector('dialog[open]')) return;
    runCommand.current(id);
  };
  runCommand.current = id => {
    // Commands do only what the matching buttons allow at the moment.
    // Slot shortcuts follow the runtime's stable slots. They and next-needs-you
    // are ignored while busy (clicks are not) so two switches never overlap.
    const slot = /^slot-([1-4])$/.exec(id);
    if (slot) { const target = slotTarget(ordered, Number(slot[1])); if (!busy && target && target.id !== selectedId) void selectSession(target); return; }
    if (commandBlock(id) !== null) return;
    if (id === 'next-needs-you') { const target = nextNeedsYou(ordered, selectedId); if (target) void selectSession(target); return; }
    if (id === 'new-session') { newSession(); return; }
    if (id === 'open-project') { void openProject(); return; }
    if (id === 'settings') { setSettingsOpen(true); return; }
    // Phase 8: open-file needs a project; without one the palette lists Open project.
    if (id === 'command-palette' || id === 'open-file') {
      // Synchronously, before React renders the palette: the terminal lets go of the keyboard and
      // drops input until the dialog is open, so a key typed right after the shortcut never
      // reaches the agent (review I5).
      const focused = document.activeElement;
      const terminal = focused instanceof HTMLElement && focused.closest('.terminal-surface') ? focused : null;
      expectModalDialog(Date.now(), terminal); terminal?.blur();
      setPalette(id === 'open-file' && !state ? { mode: 'all', purpose: 'open', lead: 'open-project' } : { mode: id === 'open-file' ? 'files' : 'all', purpose: 'open' });
      return;
    }
    if (id === 'toggle-sidebar') { layout.toggleSidebar(); return; }
    if (!projectRef.current) return;
    if (id === 'add-note') setForm({});
    else if (id === 'toggle-inspector') layout.toggleInspector();
    else if (id === 'focus-terminal') { if (session) window.dispatchEvent(new CustomEvent('journal:focus-terminal', { detail: session.id })); }
    else if (id === 'tab-session') { setPanel('session'); layout.showInspector(); }
    else if (id === 'tab-files') { setPanel('files'); layout.showInspector(); setExplorerFocus(n => n + 1); }
    else if (id === 'tab-memory') { setPanel('memory'); layout.showInspector(); }
  };
  // === End region: command handler ===
  // A notification click (main sends focus-session) selects its session like a click, busy or not,
  // except while a dialog is open: like commands, it must not switch the session behind it.
  const focusSession = useRef<(id: string) => void>(() => {});
  focusSession.current = id => { if (document.querySelector('dialog[open]')) return; const target = sessions[id]; if (target) void selectSession(target); };
  useEffect(() => window.journal?.onEvent(event => {
    if (event.type === 'command') command.current(event.id);
    else if (event.type === 'focus-session') focusSession.current(event.sessionId);
  }), []);
  // Windows and Linux: Ctrl+O is not routed, because the CLI owns it while the
  // terminal has focus (xterm stops the event there). Elsewhere it opens a project.
  // The platform comes from the preload, not bootstrap: Welcome shows before bootstrap
  // answers, and a Ctrl+O pressed then must not be lost (⌘O, routed by main, never is).
  const keyPlatform = window.journal?.platform ?? bootstrap?.platform;
  useEffect(() => {
    if (!keyPlatform || keyPlatform === 'darwin') return;
    const open = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || !event.ctrlKey || event.shiftKey || event.altKey || event.metaKey || keyLetter(event.key, event.code) !== 'o') return;
      event.preventDefault(); command.current('open-project');
    };
    window.addEventListener('keydown', open); return () => window.removeEventListener('keydown', open);
  }, [keyPlatform]);
  async function start(provider: Provider, resumeFrom?: Session) {
    const projectId = resumeFrom?.projectId ?? state?.project.id; if (!projectId) return;
    // Take the task now so text typed while this start finishes is never cleared.
    const submitted = resumeFrom ? '' : task; if (!resumeFrom) { providerAuto.current = false; setTask(''); }
    await run(async () => {
      try {
        if (!resumeFrom) setStartError(null);
        const result = await api<{ session: Session; receipt: Receipt }>('start', { projectId, provider, task: submitted, resumeId: resumeFrom?.id, ...(resumeFrom ? {} : { workspaceId: workspaceId || null, ...modeFlags(mode), disabled, references: referenceInputs }) });
        merge([result.session]); setSelectedId(result.session.id); setReceipt(result.receipt); setFirstNote(null); setDisabled([]); if (!resumeFrom) setReferences([]); setPanel('session'); await refresh(projectId);
      } catch (error) {
        if (submitted) setTask(current => current || submitted);
        // Another window or a stale count: all four slots are taken. Catch up and say so plainly.
        const code = errorCode(error);
        if (code === 'SLOTS_FULL') { void reloadSessions().catch(() => {}); if (!resumeFrom) { setStartError({ code, message: statesCopy.slotsFull }); return; } throw new Error(copy.slotsFull(MAX_SESSIONS)); }
        // The agent went missing since detection: say so beside Start and check that provider
        // again now (fresh), so its card follows what is installed instead of staying Not installed.
        if (code === 'PROVIDER_MISSING' && !resumeFrom) {
          void checkProvider(provider).catch(failed);
          setStartError({ code, message: error instanceof Error ? error.message : String(error) }); return;
        }
        // Phase 8: an agent that couldn't start is explained above Start (StartError), not in the app banner.
        if ((code === 'START_FAILED' || code === 'PROVIDER_UNSUPPORTED') && !resumeFrom) { setStartError({ code, message: error instanceof Error ? error.message : String(error) }); return; }
        throw error;
      }
    });
  }
  const sessionAction = (action: string, extra: object = {}) => session && run(async () => { await api(action, { id: session.id, ...extra }); });
  // Session actions shared by the right-click menu and the session header.
  const sessionActions = {
    rename: (target: Session) => setRenameTarget({ kind: 'session', session: target }),
    pin: (target: Session) => run(async () => { merge([await api<Session>('setSessionPinned', { id: target.id, pinned: !target.pinned })]); }),
    archive: (target: Session) => run(async () => { merge([await api<Session>('archiveSession', { id: target.id })]); }),
    unarchive: (target: Session) => run(async () => { merge([await api<Session>('unarchiveSession', { id: target.id })]); }),
    remove: (target: Session) => run(async () => {
      const result = await api<Session | null>('removeSession', { id: target.id }); if (!result) return;
      if (result.removed) { removedIds.current.add(target.id); setSessions(current => { const next = { ...current }; delete next[target.id]; return next; }); setSelectedId(current => current === target.id ? null : current); await refresh(); }
      else merge([result]);
    }),
    resume: (target: Session) => start(target.provider, target),
    interrupt: (target: Session) => run(async () => { await api('interrupt', { id: target.id }); }),
    stop: (target: Session) => run(async () => { await api('stop', { id: target.id }); }),
    endOrphan: (target: Session) => run(async () => { await api('terminateOrphan', { id: target.id }); }),
    reveal: (target: Session) => run(async () => { await api('revealSession', { id: target.id }); }),
    copyPath: (target: Session) => run(async () => { await api('copySessionPath', { id: target.id }); }),
    copyNativeId: (target: Session) => run(async () => { await api('copySessionNativeId', { id: target.id }); }),
  };
  const revealLabel = bootstrap?.platform === 'darwin' ? 'Finder' : bootstrap?.platform === 'win32' ? 'File Explorer' : 'file manager';
  async function sessionMenu(target: Session, position?: { x: number; y: number }) {
    const live = isLive(target); const orphan = target.status === 'orphaned';
    const choice = await showMenu([
      { id: 'open', label: 'Open' }, { id: 'rename', label: 'Rename…' },
      { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin' }, { id: target.archived ? 'unarchive' : 'archive', label: target.archived ? 'Unarchive' : 'Archive' },
      { separator: true },
      resumable(target) && { id: 'resume', label: copy.continue, enabled: canStart && !busy },
      live && { id: 'interrupt', label: 'Interrupt (Ctrl+C)', enabled: connected }, live && { id: 'stop', label: 'Stop', enabled: connected && target.status !== 'stopping' },
      orphan && target.identityVerified !== false && { id: 'endOrphan', label: 'End orphaned process' },
      { separator: true },
      { id: 'reveal', label: `Reveal Workspace in ${revealLabel}`, enabled: !!target.cwd }, { id: 'copyPath', label: 'Copy Workspace Path', enabled: !!target.cwd },
      { id: 'copyNativeId', label: target.nativeId && !target.nativeIdConfirmed ? 'Copy Native Session ID (unconfirmed)' : 'Copy Native Session ID', enabled: !!target.nativeId && target.nativeIdConfirmed },
      { separator: true }, { id: 'remove', label: 'Remove from Journal…' },
    ], position);
    if (choice === 'open') await selectSession(target);
    else if (choice && choice in sessionActions) await sessionActions[choice as keyof typeof sessionActions](target);
  }
  // === Region A: project menus ===
  // The switcher lists every project, then the current project's actions; right-click on it opens those actions alone.
  const removedProject = (id: string) => { setProjects(items => items.filter(p => p.id !== id)); if (state?.project.id === id) { setState(null); setSelectedId(null); setReceipt(null); } if (refreshTarget.current === id) refreshTarget.current = null; void reloadProjects().catch(failed); };
  const projectItems = (target: Project) => [
    { id: 'open-project', label: 'Open project…' }, { id: 'manage', label: 'Manage project…' }, { id: 'rename', label: 'Rename…' }, { id: 'pin', label: target.pinned ? 'Unpin' : 'Pin' }, { id: 'addFolder', label: 'Add folder…' },
    { separator: true as const }, { id: 'reveal', label: `Reveal in ${revealLabel}` }, { id: 'copyPath', label: 'Copy path' },
    { separator: true as const }, { id: 'remove', label: 'Remove from Journal…' },
  ];
  async function projectAction(choice: string | null, target: Project) {
    if (choice === 'open-project') await openProject();
    else if (choice === 'rename') setRenameTarget({ kind: 'project', project: target });
    else if (choice === 'pin') await run(async () => { await api('setProjectPinned', { id: target.id, pinned: !target.pinned }); await reloadProjects(); });
    else if (choice === 'manage') setManageId(target.id);
    else if (choice === 'addFolder') await run(async () => { await api('addProjectFolder', { id: target.id }); await reloadProjects(); if (state?.project.id === target.id) await refresh(); });
    else if (choice === 'reveal') await run(async () => { await api('revealProject', { id: target.id }); });
    else if (choice === 'copyPath') await run(async () => { await api('copyProjectPath', { id: target.id }); });
    else if (choice === 'remove') await run(async () => { if (await api('removeProject', { id: target.id })) removedProject(target.id); });
  }
  async function projectMenu(position?: { x: number; y: number }) {
    const target = state?.project; if (!target) return;
    await projectAction(await showMenu(projectItems(target), position), target);
  }
  // With no project open it lists the known projects and Open project…; with none known it opens one directly.
  async function switcherMenu(position?: { x: number; y: number }) {
    const current = state?.project ?? null; if (!current && !projects.length) { await openProject(); return; }
    // Menu item IDs are short (main allows 40 characters and 40 items), so projects are listed by position in this snapshot.
    // Past 28 projects a disabled line says how many are left out and how to reach them (there is no all-projects list).
    const listed = projects.slice(0, 28); const hidden = projects.length - listed.length;
    const choice = await showMenu([...listed.map((p, index) => ({ id: `project:${index}`, label: `${p.name}${p.pinned ? ' · Pinned' : ''}${p.id === current?.id ? ' · Current' : ''}` })),
      hidden > 0 && { id: 'more-projects', label: shell.moreProjects(hidden), enabled: false }, { separator: true },
      ...(current ? projectItems(current) : [{ id: 'open-project', label: 'Open project…' }])], position);
    const picked = choice?.startsWith('project:') ? listed[Number(choice.slice('project:'.length))] ?? null : null;
    if (picked) { if (picked.id !== current?.id) await chooseProject(picked); }
    else if (current) await projectAction(choice, current);
    else if (choice === 'open-project') await openProject();
  }
  // === End region A: project menus ===
  async function proposeUpdate(scope: 'checkout' | 'branch') {
    if (!state) return;
    await run(async () => { setForm({ draft: await api<StatusDraft>('proposeStatusUpdate', { projectId: state.project.id, scope }) }); });
  }
  // === Phase 7: provider actions (Welcome rows and the New session view) ===
  // The renderer names a provider; main picks the executable and argv. Install asks for confirmation in main.
  async function providerAction(provider: Provider, action: () => Promise<void>, kind: 'action' | 'check' = 'action') {
    if (providerBusy[provider]) return;
    setProviderNotes(notes => ({ ...notes, [provider]: '' })); setProviderBusy(current => ({ ...current, [provider]: kind }));
    try { await action(); } catch (error) { failed(error); } finally { setProviderBusy(current => ({ ...current, [provider]: false })); }
  }
  // A fresh check of one provider (Check again, and after a start refused with PROVIDER_MISSING).
  async function checkProvider(target: Provider) {
    const next = await api<AgentInfo>('providerStatus', { provider: target, fresh: true });
    setBootstrap(current => current ? { ...current, agents: current.agents.map(a => a.provider === target ? next : a) } : current);
  }
  const providerLatest = useRef({ providerAction, checkProvider }); providerLatest.current = { providerAction, checkProvider };
  // Stable handlers (they read the newest state through a ref), shared by Welcome and the composer's agent cards.
  const providerHandlers: ProviderHandlers = useMemo(() => {
    const act = (provider: Provider, action: () => Promise<void>, kind?: 'action' | 'check') => void providerLatest.current.providerAction(provider, action, kind);
    return {
      onCheck: provider => act(provider, () => providerLatest.current.checkProvider(provider), 'check'),
      onInstall: provider => act(provider, async () => {
        const result = await api<{ id: string; command: string } | null>('providerInstall', { provider });
        if (result) setProcessView({ id: result.id, command: result.command, title: providers.installTitle(PROVIDER_NAMES[provider]), provider, kind: 'install' });
      }),
      onLogin: provider => act(provider, async () => {
        const result = await api<{ id: string; command: string }>('providerLogin', { provider });
        setProcessView({ id: result.id, command: result.command, title: providers.loginTitle(PROVIDER_NAMES[provider]), provider, kind: 'login' });
      }),
      onInstallPage: provider => act(provider, async () => { await api('openInstallPage', { provider }); }),
    };
  }, []);
  // === End Phase 7: provider actions ===
  // === Phase 7: Getting to know your project ===
  // After a project's state has rendered, ask main once for its first-run drafts (only when
  // it needs orientation). Not while a session is selected. A reply is kept for its project
  // even if the user switched meanwhile; main marks the project shown only after the screen
  // has painted, so drafts that were never seen are offered again (another app run, a reload).
  const currentProjectId = state?.project.id ?? null; const needsOrientation = !!state?.needsOrientation;
  useEffect(() => {
    if (!currentProjectId || !orientationKey || !needsOrientation || selectedId || askedFirstRun.current.has(orientationKey)) return;
    askedFirstRun.current.add(orientationKey);
    const key = orientationKey; const answered = () => setAnsweredFirstRun(current => new Set([...current, key]));
    requestAnimationFrame(() => void api<FirstRunDrafts | null>('firstRunDrafts', { projectId: currentProjectId })
      .then(drafts => { if (drafts) setFirstRunDrafts(current => ({ ...current, [drafts.projectId]: drafts })); answered(); })
      .catch(error => { answered(); failed(error); }));
  }, [currentProjectId, orientationKey, needsOrientation, selectedId, failed]);
  const noteRemembered = () => { if (claimFirstNote(hasNotesAtStart.current)) setFirstNote('new'); };
  const dropDrafts = (projectId: string) => setFirstRunDrafts(current => { const next = { ...current }; delete next[projectId]; return next; });
  async function rememberFirstRun(parts: DraftParts) {
    const drafts = currentDrafts; if (!drafts) return;
    // Every part carries the drafts' HEAD and branch: core refuses after a new commit or a branch switch.
    const part = (draft: StatusDraft | null, statement: string | null) => draft && statement !== null ? { statement, base: draft.source.base, head: drafts.head, branch: drafts.branchName } : null;
    let notes: Memory[];
    try { notes = await api<Memory[]>('rememberDraft', { projectId: drafts.projectId, overview: part(drafts.overview, parts.overview), branch: part(drafts.branch, parts.branch) }); }
    catch (error) {
      // Refused because the project moved while the screen was open: offer Draft again in place.
      const checkout = await api<{ branch: string | null; head: string | null }>('checkout', { projectId: drafts.projectId }).catch(() => null);
      if (checkout && (checkout.head !== drafts.head || (checkout.branch ?? null) !== drafts.branchName)) { void refresh(drafts.projectId).catch(() => {}); throw new DraftsMoved(); }
      throw error;
    }
    setJustRemembered(current => new Set([...current, ...notes.map(note => note.id)]));
    dropDrafts(drafts.projectId); setKnowledgeVersion(v => v + 1); noteRemembered(); setTaskFocus(n => n + 1);
  }
  async function skipFirstRun() {
    const drafts = currentDrafts; if (!drafts) return;
    await api('skipOrientation', { projectId: drafts.projectId }); dropDrafts(drafts.projectId); setTaskFocus(n => n + 1);
  }
  // Draft again (the project moved): fresh drafts on the current HEAD, or none (the screen leaves).
  async function redraftFirstRun() {
    const drafts = currentDrafts; if (!drafts) return;
    const next = await api<FirstRunDrafts | null>('firstRunDrafts', { projectId: drafts.projectId, again: true });
    if (next) setFirstRunDrafts(current => ({ ...current, [next.projectId]: next })); else { dropDrafts(drafts.projectId); setTaskFocus(n => n + 1); }
  }
  const orientationShown = useCallback((projectId: string) => { void api('markOrientationShown', { projectId }).catch(failed); }, [failed]);
  // Edit saves the card for review in Project memory, then the card leaves this screen.
  const firstRunSaved = (scope: 'checkout' | 'branch') => setFirstRunDrafts(current => {
    const id = state?.project.id; const drafts = id ? current[id] : null; if (!id || !drafts) return current;
    const next = { ...drafts, [scope === 'checkout' ? 'overview' : 'branch']: null };
    const all = { ...current }; if (next.overview || next.branch) all[id] = next; else delete all[id];
    return all;
  });
  // === End Phase 7: Getting to know your project ===
  // The first-note strip: at the top without a session, at the bottom of one (the wrap-up), so a
  // Remember click never moves what is above the pointer.
  const firstNoteStrip = (place: 'top' | 'bottom') => <FirstNoteMoment mark={journalMark} place={place} entered={firstNote === 'entered'}
    onEntered={() => setFirstNote(current => current && 'entered')} onClose={() => setFirstNote(null)} />;
  // The composer's props stay the same object across renders unless their data changes, so
  // timeline and terminal events re-render App without re-rendering the composer.
  const composerLatest = useRef({ start, chooseProvider, provider, showInspector: layout.showInspector });
  composerLatest.current = { start, chooseProvider, provider, showInspector: layout.showInspector };
  const composerCallbacks = useMemo(() => ({
    onWorkspace: (id: string) => setWorkspaceId(id), onManageWorkspaces: () => setWorkspaceDialog(true),
    onRemoveReference: (index: number) => setReferences(current => current.filter((_, i) => i !== index)),
    onProvider: (next: Provider) => composerLatest.current.chooseProvider(next), onMode: (next: Mode) => { setMode(next); setStartError(null); },
    onStart: () => void composerLatest.current.start(composerLatest.current.provider),
    onInspect: (next: Receipt) => { setReceipt(next); setPanel('session'); composerLatest.current.showInspector(); },
    onChecked: (next: Receipt) => setReceipt(current => current?.state === 'prepared' ? next : current),
  }), []);
  const providerProps = useMemo(() => ({ busy: providerBusy, notes: providerNotes, ...providerHandlers }), [providerBusy, providerNotes, providerHandlers]);
  // Board 12, placement 6: the empty terminal shows under the composer until the project's first session.
  const firstSession = !!state && !ordered.some(s => s.projectId === state.project.id);
  // === Phase 8: palette and states ===
  // A file reference for the next task (Files → Add to next task, and the palette's Add reference…).
  async function addReference(ref: { rootKey: string; path: string; startLine: number | null; endLine: number | null }) {
    const projectId = state?.project.id; if (!projectId) return;
    const described = await api<FileReference>('describeReference', { projectId, workspaceId: workspaceId || null, rootKey: ref.rootKey, path: ref.path, startLine: ref.startLine, endLine: ref.endLine });
    if (projectRef.current?.id !== projectId) return; // switched projects meanwhile
    setReferences(current => current.some(r => r.rootKey === described.rootKey && r.path === described.path && r.startLine === described.startLine && r.endLine === described.endLine) ? current : [...current, described].slice(-20));
  }
  // The palette searches the Files tab's current root (plan decision 12): the root the Files tab
  // shows (reported while it is mounted, so a root picked there counts), else the one it would
  // show: the selected session's separate copy, else the checkout. Its additional folders too.
  const followRoot = session && session.projectId === state?.project.id && session.workspaceId && !session.workspaceId.startsWith('root:') ? session.workspaceId : 'checkout';
  const filesRoot = explorerRoot && explorerRoot.projectId === state?.project.id ? explorerRoot.rootKey : followRoot;
  // The palette's callbacks and blocks keep their identity (callbacks read the newest App state
  // through a ref), so the open palette re-renders only when its own props change: the session
  // list, the clock, the connection or the root, not on terminal output.
  const paletteLatest = useRef({ palette, filesRoot, projectId: state?.project.id ?? null, selectSession, newSession, addReference, checkProvider, runCommand, commandBlock, showInspector: layout.showInspector, failed });
  paletteLatest.current = { palette, filesRoot, projectId: state?.project.id ?? null, selectSession, newSession, addReference, checkProvider, runCommand, commandBlock, showInspector: layout.showInspector, failed };
  const paletteCallbacks = useMemo(() => ({
    onClose: () => setPalette(null),
    // Closed first, then run on the next frame, so the open-dialog guard never swallows it.
    onRun: (id: PaletteActionId) => {
      setPalette(null);
      requestAnimationFrame(() => {
        const latest = paletteLatest.current;
        // The guard is checked again: the state may have changed since the palette listed it.
        if (latest.commandBlock(id) !== null) return;
        if (id === 'manage-workspaces') setWorkspaceDialog(true);
        else if (id === 'check-agents') for (const provider of ['claude', 'codex', 'cursor'] as const) void latest.checkProvider(provider).catch(latest.failed);
        else latest.runCommand.current(id);
      });
    },
    onOpenSession: (target: Session) => { setPalette(null); void paletteLatest.current.selectSession(target); },
    onOpenNote: (id: string) => { setPalette(null); setPanel('memory'); paletteLatest.current.showInspector(); setMemoryFocus(current => ({ id, seq: (current?.seq ?? 0) + 1 })); },
    onOpenFile: (path: string, rootKey: string) => {
      const { palette: open, projectId } = paletteLatest.current; setPalette(null);
      if (!projectId) return;
      if (open?.purpose === 'reference') { void paletteLatest.current.addReference({ rootKey, path, startLine: null, endLine: null }).catch(paletteLatest.current.failed); return; }
      setFilesChoice('all'); setPanel('files'); paletteLatest.current.showInspector(); setFilesReveal(current => ({ projectId, rootKey, path, seq: (current?.seq ?? 0) + 1 }));
    },
    // Prefills only: nothing starts, and a draft task is kept (the query goes on a new line).
    onNewWithTask: (text: string) => { setPalette(null); if (!paletteLatest.current.projectId) return; paletteLatest.current.newSession(); setTask(current => current.trim() ? `${current.replace(/\s+$/, '')}\n${text}` : text); },
    // The note form, prefilled: saving adds it for review, as any new note.
    onAddNote: (text: string) => { setPalette(null); if (paletteLatest.current.projectId) setForm({ initialStatement: text }); },
  }), []);
  // Each action's reason, recomputed per render but passed on only when one changes.
  const blockList = PALETTE_ACTIONS.map(id => commandBlock(id));
  const blockKey = blockList.join('\u0000');
  const paletteBlocks = useMemo(() => Object.fromEntries(PALETTE_ACTIONS.map((id, i) => [id, blockList[i]])), [blockKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const openReferencePicker = useCallback(() => { if (!document.querySelector('dialog[open]')) setPalette({ mode: 'files', purpose: 'reference' }); }, []);
  // Recovery rows: interrupted sessions of other projects are not loaded yet, so they are fetched.
  const sessionsRef = useRef(sessions); sessionsRef.current = sessions;
  useEffect(() => {
    if (!recovery) return; let current = true;
    // Loaded only when every row is known: a failed fetch never lets the panel close by itself
    // (the user can still choose Done).
    const missing = recovery.sessions.filter(entry => !sessionsRef.current[entry.id]).map(entry => entry.id);
    void Promise.all(missing.map(id => api<Session | null>('getSession', { id }).then(found => { if (found) merge([found]); return !!found; }).catch(() => false)))
      .then(results => { if (current && results.every(Boolean)) setRecoveryLoadedAt(recovery.at); });
    return () => { current = false; };
  }, [recovery, merge]);
  const startBlocked = !connected ? composer.runtimeDown : liveCount >= MAX_SESSIONS ? statesCopy.slotsFull : null;
  // Continue in the recovery panel has its own slots-full sentence (no task to write there).
  const continueBlocked = !connected ? composer.runtimeDown : liveCount >= MAX_SESSIONS ? statesCopy.continueSlotsFull : null;
  const recoveryShown = useMemo(() => recoveryView(recovery, sessions, continueBlocked), [recovery, sessions, continueBlocked]);
  const acknowledgeRecovery = useCallback((at: string) => {
    setRecovery(current => current?.at === at ? null : current);
    void api('acknowledgeRecovery', { at }).catch(() => {});
  }, []);
  // Once every row is resolved (continued, removed or archived), the panel closes and acknowledges.
  useEffect(() => { if (recovery && recoveryLoadedAt === recovery.at && !recoveryShown) acknowledgeRecovery(recovery.at); }, [recovery, recoveryLoadedAt, recoveryShown, acknowledgeRecovery]);
  // When the banner or the recovery panel goes (or a resolved row leaves it) with focus inside, focus
  // moves to the panel's next control, else to the session: the live terminal, the wrap-up's heading,
  // or the task box (Phase 9). It never falls to the page.
  const runtimeSlot = useKeepFocus<HTMLDivElement>(mainFocusTarget);
  const recoverySlot = useKeepFocus<HTMLDivElement>(root => firstEnabled(root) ?? mainFocusTarget());
  // === End Phase 8 ===
  const projectBranchChanged = session && state && !session.workspaceId && session.projectId === state.project.id && isLive(session) && session.branch !== undefined && session.branch !== state.project.branch;
  // One timeline fetch and one changes source per session, shared by the header, status bar and inspector.
  const { events } = useSessionEvents(session?.id ?? null, liveEvents, `${session?.status ?? ''}:${connected}`);
  const fileEvents = session ? fileEventCounts[session.id] ?? 0 : 0;
  const sessionChanges = useSessionChanges(session, fileEvents);
  const changed = diffSummary(sessionChanges.changes)?.files ?? 0;
  const filesView = filesChoice ?? (changed ? 'changed' : 'all');
  // A preview or an older record never feeds the status bar.
  const sessionReceipt = session && receipt?.id === session.receiptId ? receipt : null;
  // A note's origin opens its session when it is loaded; otherwise the card shows no link.
  const openSession = (id: string) => { const target = sessions[id]; if (target) void selectSession(target); };
  const showSent = () => { setPanel('session'); layout.showInspector(); setPacketRequest(n => (n ?? 0) + 1); };
  // === Region B: inspector ===
  const inspector = (pane: 'full' | 'rail', overlay: boolean) => state && <Inspector pane={pane} inOverlay={overlay} overlayOpen={layout.inspector === 'overlay'} tab={panel} onTab={setPanel} badges={{ files: changed, memory: proposals.length }} shortcuts={bootstrap?.shortcuts}
      
    onHide={overlay ? () => layout.closeOverlays(true) : layout.mode === 'wide' ? layout.toggleInspector : undefined} onShow={tab => tab ? layout.showInspector() : layout.toggleInspector()}>
      {panel === 'session' && <SessionTab session={session} events={events} now={now} onShowSent={showSent} context={<ContextPanel receipt={receipt} session={session} bootstrap={bootstrap} history={state.receipts} disabled={disabled} events={events} now={now} packetRequest={packetRequest} onPacketShown={() => setPacketRequest(null)}
        project={state.project} trustVersion={trustVersion} sessions={ordered} onOpenSession={openSession}
        onToggle={id => { const next = disabled.includes(id) ? disabled.filter(x => x !== id) : [...disabled, id]; setDisabled(next); if (receipt?.state === 'prepared') void api<Receipt>('prepareContext', { projectId: state.project.id, task: receipt.query, workspaceId: workspaceId || null, disabled: next, references: referenceInputs }).then(setReceipt).catch(failed); }}
        onSelectReceipt={setReceipt} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />} />}
      {panel === 'files' && <FilesTab hasSession={!!session} view={filesView} onView={setFilesChoice} changed={changed} focusSignal={explorerFocus} onFocusHandled={() => setExplorerFocus(0)}
        changes={session && <ChangesPanel session={session} changes={sessionChanges.changes} loading={sessionChanges.loading} error={sessionChanges.error} refresh={sessionChanges.refresh} />}
        files={<ExplorerPanel key={state.project.id} project={state.project} session={session} onRoot={onExplorerRoot} rootsVersion={workspaces?.workspaces.map(w => `${w.id}:${w.state}`).join(',') ?? ''} revealLabel={`Reveal in ${revealLabel}`} focusSignal={explorerFocus} onFocusHandled={() => setExplorerFocus(0)} onPreviewing={setPreviewing} onError={failed}
        onAddReference={addReference} reveal={filesReveal}
        onSaveEvidence={source => setEvidenceSource({ kind: 'file', path: source.path, startLine: source.startLine, endLine: source.endLine, ...(source.rootKey.startsWith('root:') ? { rootId: source.rootKey.slice(5) } : {}) })} />} />}
      {panel === 'memory' && <MemoryTab><KnowledgePanel project={state.project} workspaces={workspaces?.workspaces} version={knowledgeVersion} trustVersion={trustVersion} sessions={ordered} filters={memoryFilters} onFilters={setMemoryFilters} focus={memoryFocus} onOpenSession={openSession} busy={busy} proposals={proposals} onEdit={setForm} onPropose={scope => void proposeUpdate(scope)} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} onRemembered={noteRemembered} justRemembered={justRemembered} /></MemoryTab>}
  </Inspector>;
  // === End region B: inspector ===
  // === Region C: the ResizableWorkspace wrapper (layout modes) ===
  return <ResizableWorkspace layout={layout} wide={previewing && panel === 'files'} inspector={state && !showFirstRun ? inspector : null}
    sidebar={(pane, overlay) => <Sidebar pane={pane} inOverlay={overlay} projects={projects} project={state?.project ?? null} sessions={ordered} proposals={proposals} selectedId={selectedId} connected={connected}
      runtimeState={runtime.state === 'connected' || runtime.state === 'disconnected' ? runtime.state : 'connecting'} now={now} canCompose={!!state}
      shortcuts={bootstrap?.shortcuts} appearance={appearance} update={state && session ? null : update}
      onSelect={next => { if (overlay || layout.inspector === 'overlay') layout.closeOverlays(false); void selectSession(next); }} onSessionMenu={(next, position) => void sessionMenu(next, position)} onNew={() => { if (overlay || layout.inspector === 'overlay') layout.closeOverlays(false); newSession(); }}
      onSwitchProject={position => void switcherMenu(position).catch(failed)} onProjectMenu={position => void projectMenu(position).catch(failed)}
      onOpenMemory={() => { setPanel('memory'); layout.showInspector(); }} onOpenSettings={() => setSettingsOpen(true)} onError={failed}
      onExpand={layout.toggleSidebar} onShowRecent={() => { layout.openSidebar(); requestAnimationFrame(() => document.getElementById('sidebar-recent')?.scrollIntoView({ block: 'start' })); }} />}>

    {/* === Region B: main column (session view) === */}
    <main className="workspace" aria-busy={busy || undefined}>
      {/* === Phase 8: runtime disconnected and crash recovery (board 9) === */}
      {/* The banner sits in a status region that stays mounted, so it is announced when it appears (Phase 9). */}
      <div className="runtime-live" role="status" ref={runtimeSlot}>{runtime.state === 'disconnected' && <RuntimeBanner runtime={runtime} onReconnect={() => api('reconnectRuntime')} />}</div>
      {runtime.warning && runtime.state !== 'disconnected' && <div className="error-banner" role="status"><span>{runtime.warning}</span></div>}
      {/* The recovery panel is a region, not a live one: this always-present region says once that it appeared. */}
      <div className="visually-hidden recovery-live" role="status">{recovery && recoveryShown ? `${statesCopy.crashTitle}. ${statesCopy.crashBody(recovery)}` : ''}</div>
      <div ref={recoverySlot}>{recovery && recoveryShown && <RecoveryPanel recovery={recovery} view={recoveryShown} busy={busy} onContinue={target => void start(target.provider, target)}
        onSelect={target => void selectSession(target)} onDone={() => acknowledgeRecovery(recovery.at)} />}</div>
      {/* === End Phase 8 === */}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {/* Phase 7: the first-note moment (its text is announced by this always-present region), then Welcome or Getting to know your project. */}
      <p className="visually-hidden" role="status">{firstNote ? `${firstRun.firstNoteTitle} ${firstRun.firstNoteBody}` : ''}</p>
      {firstNote && !session && firstNoteStrip('top')}
      {!state ? <Welcome mark={journalMark} agents={bootstrap?.agents} shortcut={bootstrap?.shortcuts['open-project']} busy={busy} providerBusy={providerBusy} notes={providerNotes}
          dragging={dragging === 'welcome'} dropError={dropError} handlers={providerHandlers} onOpen={() => void openProject()} />
        : showFirstRun && currentDrafts ? <GettingToKnow key={currentDrafts.projectId} drafts={currentDrafts} branch={state.project.branch} mark={journalMark} mac={bootstrap?.platform === 'darwin'}
          onRemember={rememberFirstRun} onSkip={skipFirstRun} onRedraft={redraftFirstRun} onShown={orientationShown}
          onEdit={(scope, statement) => { const draft = scope === 'checkout' ? currentDrafts.overview : currentDrafts.branch; if (draft) setForm({ draft: { ...draft, statement }, firstRun: scope }); }} />
        : firstRunPending ? <div className="first-run-pending" aria-busy="true" />
        : !session ? <NewSessionView project={state.project} bootstrap={bootstrap} workspaces={workspaces} workspaceId={workspaceId}
          task={task} onTask={editTask} taskRef={taskRef} references={references} disabled={disabled} onDisabled={setDisabled} provider={provider} mode={mode}
          connected={connected} liveCount={liveCount} busy={busy} startError={startError} knowledgeVersion={knowledgeVersion} onAddReference={openReferencePicker}
          {...composerCallbacks} providers={providerProps} mark={journalMark} justRemembered={justRemembered}
          emptyTerminal={firstSession ? bootstrap?.shortcuts['new-session']?.label ?? '' : null} />
        : <section className="session-view" aria-label="Session">
          <SessionHeader session={session} state={stateFor(session, now, connected)} connected={connected} busy={busy} canStart={canStart} now={now} mac={bootstrap?.platform === 'darwin'}
            projectBranch={session.projectId === state.project.id ? state.project.branch : session.branch ?? null} agentVersion={bootstrap?.agents.find(a => a.provider === session.provider)?.version ?? null}
            onInterrupt={() => void sessionAction('interrupt')} onStop={() => void sessionAction('stop')} onContinue={() => void start(session.provider, session)} hideContinue={wrapUpShown}
            onArchiveToggle={() => void (session.archived ? sessionActions.unarchive(session) : sessionActions.archive(session))}
            onEndOrphan={() => void sessionAction('terminateOrphan')} onEndSurvivors={() => void sessionAction('terminateSurvivors')} onMenu={position => void sessionMenu(session, position)} />
          <AttentionBanner session={session} />
          {projectBranchChanged && <p className="hint session-hint">The checkout is now on {state.project.branch ?? 'a detached HEAD'}; this session started on {session.branch ?? 'a detached HEAD'}.</p>}
          {session.status === 'orphaned' && <p className="hint session-hint">{session.identityVerified === false ? `A process with this session's PID (${(session as { pid?: number }).pid ?? 'unknown'}) is still running, but Journal cannot verify it is the original agent, so it will not signal it. Continuing stays blocked until it ends; check it outside Journal.` : 'The runtime that owned this terminal stopped while its process kept running. Journal cannot reattach to it. End it here, or leave it running; continuing this conversation stays blocked while it runs.'}</p>}
          {session.status === 'interrupted' && <p className="hint session-hint">This session's runtime stopped unexpectedly. Whether its first message reached the agent is uncertain, and nothing was resent.{resumable(session) ? ' Continue reopens the same conversation.' : ''}</p>}
          {!!session.survivors?.length && <p className="hint session-hint">Child processes outlived the agent: {session.survivors.map(s => `${s.pid} ${s.command}`).join('; ')}</p>}
          {/* === Phase 6: the wrap-up replaces the terminal of an ended session (Show terminal brings it back) === */}
          {/* Show terminal hides the wrap-up without unmounting it, so a staged Still true or Dismiss keeps its Undo;
              only another session or project (the key) commits it. */}
          {endedView(session) ? <><div className="wrap-scroll" hidden={!wrapUpShown}><WrapUp key={session.id} session={session} project={state.project} workspaces={workspaces?.workspaces ?? []} receipt={sessionReceipt} events={events} agents={bootstrap?.agents ?? []}
            appearance={appearance} mac={bootstrap?.platform === 'darwin'} busy={busy} canStart={canStart} connected={connected} justEnded={justEnded} hidden={!wrapUpShown} knowledgeVersion={knowledgeVersion} onRemembered={noteRemembered}
            onShowTerminal={() => setTerminalShown(current => ({ ...current, [session.id]: true }))} onContinue={() => void start(session.provider, session)}
            onConfirmId={nativeId => run(async () => { merge([await api<Session>('confirmNativeId', { id: session.id, nativeId })]); })} onCopyId={() => void sessionActions.copyNativeId(session)}
            onOpenDiff={() => { setFilesChoice('changed'); setPanel('files'); layout.showInspector(); }} onOpenMemory={() => { setPanel('memory'); layout.showInspector(); }}
            onEdit={(memory, done) => setForm({ memory, after: done })} onFinishDraft={() => void proposeUpdate('branch')} onHandoff={handoff}
            onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} /></div>
            {!wrapUpShown && <><div className="wrap-terminal-bar"><button type="button" onClick={() => setTerminalShown(current => ({ ...current, [session.id]: false }))}>{wrapUpCopy.showSummary}</button></div>
            <div className="terminal-panel"><EndedTerminal session={session} appearance={appearance} onError={setError} /></div></>}</>
          : <div className="terminal-panel"><TerminalPane key={session.id} sessionId={session.id} live={isLive(session) && connected} appearance={appearance} onError={setError} /></div>}
          {/* === End Phase 6 === */}
          {!wrapUpShown && !isLive(session) && session.status !== 'orphaned' && !session.nativeIdConfirmed && <div className="resume-id"><label>{wrapUpCopy.idLabel}<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder={wrapUpCopy.idPlaceholder} spellCheck={false} /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); merge([next]); })}>{wrapUpCopy.confirmId}</button></div>}
          {firstNote && firstNoteStrip('bottom')}
          <StatusBar receipt={sessionReceipt} changes={sessionChanges.changes} update={update} onShowSent={showSent} onError={failed} />
        </section>}
    </main>
    {/* === End region B: main column === */}

    {manageId && <ManageProjectDialog projectId={manageId} onClose={() => setManageId(null)} onChanged={() => { void reloadProjects().catch(failed); if (state?.project.id === manageId) void refresh().catch(failed); }}
      onRemoved={() => { const removed = manageId; setManageId(null); removedProject(removed); }} />}
    {renameTarget?.kind === 'project' && <RenameDialog title={`Rename ${renameTarget.project.name}`} label="Display name" value={renameTarget.project.displayName} fallback={renameTarget.project.folderName ?? renameTarget.project.name}
      note="Only Journal's label changes. The folder on disk keeps its name." onClose={() => setRenameTarget(null)}
      onSave={async name => { await api('renameProject', { id: renameTarget.project.id, name }); await reloadProjects(); if (state?.project.id === renameTarget.project.id) await refresh(); }} />}
    {renameTarget?.kind === 'session' && <RenameDialog title="Rename session" label="Session name" value={renameTarget.session.displayName} fallback={renameTarget.session.title}
      note="Only Journal's label changes. The native Claude, Codex or Cursor session ID and continuing the same conversation are unaffected." onClose={() => setRenameTarget(null)}
      onSave={async name => { merge([await api<Session>('renameSession', { id: renameTarget.session.id, name })]); }} />}
    {processView && <ProcessDialog id={processView.id} title={processView.title} command={processView.command} appearance={appearance} onClose={() => setProcessView(null)} onExit={() => {}} />}
    {palette && <CommandPalette mode={palette.mode} purpose={palette.purpose} lead={palette.lead} projectId={state?.project.id ?? null} rootKey={filesRoot} projectName={state?.project.name ?? null}
      sessions={ordered} now={now} connected={connected} mac={bootstrap?.platform === 'darwin'} keys={bootstrap?.shortcuts ?? NO_KEYS} blocks={paletteBlocks} {...paletteCallbacks} />}
    {settingsOpen && <SettingsDialog appearance={appearance} onAppearance={setAppearance} update={update} project={state?.project ?? null} onClose={() => setSettingsOpen(false)} onDataChanged={() => { setKnowledgeVersion(v => v + 1); void refresh().catch(() => {}); }} />}
    {state && workspaceDialog && <WorkspaceDialog project={state.project} onClose={() => setWorkspaceDialog(false)} onChanged={() => void refresh().catch(failed)} />}
    {state && evidenceSource && <KnowledgeForm project={state.project} initialSource={evidenceSource} onClose={() => setEvidenceSource(null)} onSaved={() => { setEvidenceSource(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} supersedes={form.supersedes} initialCategory={form.initialCategory} initialStatement={form.initialStatement} draft={form.draft} onClose={() => setForm(null)} onSaved={() => { if (form.firstRun) firstRunSaved(form.firstRun); form.after?.(); setForm(null); setPanel('memory'); setKnowledgeVersion(v => v + 1); }} />}
  </ResizableWorkspace>;
  // === End region C ===
}
