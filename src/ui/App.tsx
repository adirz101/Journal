import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { KnowledgePanel } from './KnowledgePanel';
import { ResizableWorkspace } from './ResizableWorkspace';
import { SessionList, needsAttention, resumable, stateLabel } from './SessionList';
import { ChangesPanel } from './ChangesPanel';
import { ActivityPanel } from './ActivityPanel';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import journalWordmark from '../../assets/branding/journal-wordmark.png';
import { storedAppearance, type Appearance } from './theme';
import { api, isLive, type Bootstrap, type Memory, type Project, type ProjectState, type Provider, type Receipt, type Session, type StatusDraft, type TimelineEvent } from './types';

const MAX_SESSIONS = 4;
type Panel = 'knowledge' | 'context' | 'changes' | 'activity';

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
  const [panel, setPanel] = useState<Panel>('knowledge');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; initialCategory?: string; draft?: StatusDraft } | null>(null);
  const [knowledgeVersion, setKnowledgeVersion] = useState(0);
  const [runtime, setRuntime] = useState<{ state: string; warning?: string | null }>({ state: 'connecting' });
  const [liveEvents, setLiveEvents] = useState<TimelineEvent[]>([]);
  const [now, setNow] = useState(Date.now());
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; value: string } | null>(null);
  const session = selectedId ? sessions[selectedId] ?? null : null;
  // A confirmation draft belongs to one launch, never to another conversation.
  const resumeValue = resumeDraft?.sessionId === session?.id ? resumeDraft?.value ?? '' : session?.nativeId ?? '';
  const taskRef = useRef<HTMLTextAreaElement>(null); const projectRef = useRef<Project | null>(null);
  projectRef.current = state?.project ?? null;
  const connected = runtime.state === 'connected';
  const failed = useCallback((error: unknown) => setError(error instanceof Error ? error.message : String(error)), []);
  const merge = useCallback((items: Session[]) => setSessions(current => { const next = { ...current }; for (const item of items) next[item.id] = { ...next[item.id], ...item }; return next; }), []);
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance, failed]);
  // Relative times only; no animation.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 15000); return () => clearInterval(timer); }, []);
  const refresh = useCallback(async (id?: string) => {
    const projectId = id ?? projectRef.current?.id; if (!projectId) return;
    const next = await api<ProjectState>('project', { projectId }); setState(next); merge(next.sessions); return next;
  }, [merge]);
  const reloadSessions = useCallback(async () => {
    const result = await api<{ live: Session[]; active: Session[] }>('sessions'); merge([...result.active, ...result.live]);
  }, [merge]);
  useEffect(() => {
    void api<Bootstrap>('bootstrap').then(async data => {
      setBootstrap(data); setProjects(data.projects); setRuntime(data.runtime); merge([...data.active, ...data.live]);
      const remembered = (() => { try { return localStorage.getItem('journal-project'); } catch { return null; } })();
      const selected = data.projects.find(p => p.id === (data.live.find(isLive)?.projectId ?? remembered));
      if (selected) {
        const next = await refresh(selected.id);
        const live = data.live.find(s => isLive(s) && s.projectId === selected.id);
        if (live) { setSelectedId(live.id); setReceipt(await api<Receipt>('getReceipt', { id: live.receiptId })); }
        else if (next?.receipts[0]) setReceipt(next.receipts[0]);
      }
    }).catch(failed);
    return window.journal?.onEvent(event => {
      if (event.type === 'error') { setError(event.message); return; }
      if (event.type === 'runtime') {
        setRuntime({ state: event.state, warning: event.warning });
        if (event.state === 'connected') void reloadSessions().then(() => refresh()).catch(failed);
        return;
      }
      if (event.type === 'timeline') { setLiveEvents(current => [...current.slice(-1999), event.event]); return; }
      if (event.type !== 'status') return;
      merge([event.session]);
    });
  }, [refresh, reloadSessions, merge, failed]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  async function chooseProject(project: Project) {
    await run(async () => { const next = await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ }
      const live = Object.values(sessions).find(s => isLive(s) && s.projectId === project.id);
      setSelectedId(live?.id ?? null); setReceipt(next?.receipts[0] ?? null); setTask(''); });
  }
  async function openProject() {
    await run(async () => { const project = await api<Project | null>('openProject'); if (!project) return; setProjects(items => [project, ...items.filter(p => p.id !== project.id)]); await refresh(project.id); try { localStorage.setItem('journal-project', project.id); } catch { /* optional */ } setSelectedId(null); setReceipt(null); });
  }
  const ordered = useMemo(() => Object.values(sessions).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [sessions]);
  const liveCount = ordered.filter(isLive).length;
  const canStart = connected && liveCount < MAX_SESSIONS;
  async function selectSession(next: Session) {
    await run(async () => {
      if (next.projectId !== state?.project.id) await refresh(next.projectId);
      setSelectedId(next.id); setReceipt(await api<Receipt>('getReceipt', { id: next.receiptId }));
    });
  }
  function newSession() { setSelectedId(null); setPanel(current => current === 'changes' || current === 'activity' ? 'knowledge' : current); requestAnimationFrame(() => taskRef.current?.focus()); }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      // Switch active sessions: ⌘1–4 on macOS, Alt+1–4 elsewhere (Ctrl+digit stays with the terminal).
      const switching = bootstrap?.platform === 'darwin' ? event.metaKey && !event.altKey : event.altKey && !event.ctrlKey && !event.metaKey;
      if (switching && /^[1-4]$/.test(event.key)) {
        const target = ordered.filter(s => isLive(s) || s.status === 'orphaned')[Number(event.key) - 1];
        if (target) { event.preventDefault(); void selectSession(target); }
        return;
      }
      if (!mod) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      if (event.key.toLowerCase() === 'n' && !event.shiftKey) { event.preventDefault(); newSession(); }
      if (event.shiftKey && event.key.toLowerCase() === 'k' && projectRef.current) { event.preventDefault(); setForm({}); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  async function start(provider: Provider, resumeFrom?: Session) {
    const projectId = resumeFrom?.projectId ?? state?.project.id; if (!projectId) return;
    await run(async () => {
      const result = await api<{ session: Session; receipt: Receipt }>('start', { projectId, provider, task: resumeFrom ? '' : task, resumeId: resumeFrom?.id });
      merge([result.session]); setSelectedId(result.session.id); setReceipt(result.receipt); if (!resumeFrom) setTask(''); setPanel('context'); await refresh(projectId);
    });
  }
  const sessionAction = (action: string, extra: object = {}) => session && run(async () => { await api(action, { id: session.id, ...extra }); });
  async function closeSession() {
    if (!session) return;
    await run(async () => { const closed = await api<Session>('archiveSession', { id: session.id }); merge([closed]); setSelectedId(null); });
  }
  async function proposeUpdate(scope: 'checkout' | 'branch') {
    if (!state) return;
    await run(async () => { setForm({ draft: await api<StatusDraft>('proposeStatusUpdate', { projectId: state.project.id, scope }) }); });
  }
  const available = (provider: Provider) => bootstrap?.agents.some(a => a.provider === provider && a.available);
  const label = session ? stateLabel(session, connected) : '';
  const projectBranchChanged = session && state && session.projectId === state.project.id && isLive(session) && session.branch !== undefined && session.branch !== state.project.branch;

  return <ResizableWorkspace hasKnowledge={!!state}>
    <aside className="sidebar" id="project-sidebar">
      <div className="brand"><img className="brand-icon" src={journalMark} alt="" width={32} height={32} /><div>Journal<small>PROJECT MEMORY</small></div><span className="local-tag">LOCAL</span></div>
      <button className="open-project" onClick={() => void openProject()} disabled={busy}><span>＋</span> Open project <kbd>{bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl'} O</kbd></button>
      <div className="nav-caption">PROJECTS <span>{projects.length}</span></div>
      <nav aria-label="Projects">{projects.map(project => <button key={project.id} className={`project-link ${state?.project.id === project.id ? 'selected' : ''}`} onClick={() => void chooseProject(project)}><svg className="folder-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 11h18" /></svg><span>{project.name}</span>{ordered.some(s => s.projectId === project.id && needsAttention(s)) && <span className="attention" aria-label="needs attention">●</span>}</button>)}</nav>
      <SessionList sessions={ordered} projects={projects} selectedId={selectedId} currentProjectId={state?.project.id ?? null} connected={connected} now={now} onSelect={next => void selectSession(next)} onNew={newSession} canStart={!!state && canStart} />
      <div className="sidebar-footer"><button className="theme-toggle" aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setAppearance(value => value === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{appearance === 'dark' ? '☀' : '◐'}</span> {appearance === 'dark' ? 'Light mode' : 'Dark mode'}</button><span className={`status-dot ${connected ? 'running' : 'waiting'}`} /> {connected ? 'Runtime connected' : runtime.state === 'connecting' ? 'Starting runtime…' : 'Runtime disconnected'}<small>No terminal transcripts saved</small></div>
    </aside>

    <main className="workspace">
      <header className="workspace-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{state?.project.name ?? 'Welcome to Journal'}</h1></div>{state && <span className="branch-badge">⑂ {state.project.branch ?? 'detached HEAD'} <span>{state.project.head?.slice(0, 7)}</span></span>}</header>
      {runtime.state === 'disconnected' && <div className="error-banner" role="status"><span>The Journal runtime is not connected. Reconnecting… Running sessions are shown as disconnected until their state is known; nothing is resent.</span></div>}
      {runtime.warning && <div className="error-banner" role="status"><span>{runtime.warning}</span></div>}
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!state ? <section className="welcome"><img className="welcome-wordmark" src={journalWordmark} alt="Journal" width={280} height={84} /><span className="eyebrow">A CONTINUOUS THREAD</span><h2>Your project, remembered.</h2><p>Work with Claude Code and Codex in their native terminals.<br />Carry the decisions and lessons into the next session.</p><button className="primary" onClick={() => void openProject()} disabled={busy}>Open project</button><div className="welcome-steps"><span>01 <strong>Open a checkout</strong></span><span>02 <strong>Work in a terminal</strong></span><span>03 <strong>Keep what matters</strong></span></div></section>
        : <>
          <section className="launch-bar" aria-label="Start an agent terminal"><label htmlFor="initial-task">Initial task <span className="optional">optional · used to select relevant knowledge</span></label><textarea ref={taskRef} id="initial-task" value={task} onChange={e => setTask(e.target.value)} maxLength={4000} rows={2} placeholder="What are you working on? Mention a module or path to include knowledge scoped to it." />
            <div className="launch-actions"><div><button className="primary" disabled={busy || !canStart || !available('claude')} onClick={() => void start('claude')}>Start Claude</button><button disabled={busy || !canStart || !available('codex')} onClick={() => void start('codex')}>Start Codex</button>{liveCount >= MAX_SESSIONS && <span className="hint inline">{MAX_SESSIONS} sessions are running. Stop one to start another.</span>}</div><button className="text-button" disabled={busy} onClick={() => void run(async () => { setReceipt(await api<Receipt>('prepareContext', { projectId: state.project.id, task })); setPanel('context'); })}>Preview context ↗</button></div>
            {bootstrap?.agents.some(a => !a.available) && <p className="hint">{bootstrap.agents.filter(a => !a.available).map(a => a.provider).join(', ')} not found on PATH. Install the native CLI, then reopen Journal.</p>}
          </section>
          <section className="terminal-panel"><div className="terminal-heading"><div><span className={`status-dot ${session?.status ?? ''}`} /><strong>{session ? session.provider === 'claude' ? 'Claude Code' : 'Codex' : 'Terminal'}</strong><span className="terminal-label">{session ? `${label}${session.branch ? ` · ⑂ ${session.branch}` : ''}` : 'Ready to start'}</span>{session && <span className="terminal-title" title={session.title}>{session.title}</span>}</div>
            {session && <div className="terminal-actions">
              {isLive(session) && connected && <><button onClick={() => void sessionAction('interrupt')}>Interrupt <kbd>^C</kbd></button><button onClick={() => void sessionAction('stop')} disabled={session.status === 'stopping'}>Stop terminal</button></>}
              {resumable(session) && <button disabled={busy || !canStart} onClick={() => void start(session.provider, session)}>Resume</button>}
              {session.status === 'orphaned' && <button onClick={() => void sessionAction('terminateOrphan')}>End orphaned process</button>}
              {!!session.survivors?.length && <button onClick={() => void sessionAction('terminateSurvivors')}>End {session.survivors.length} leftover process{session.survivors.length === 1 ? '' : 'es'}</button>}
              {!isLive(session) && session.status !== 'orphaned' && <button onClick={() => void closeSession()}>Close</button>}
            </div>}</div>
            {projectBranchChanged && <p className="hint session-hint">The checkout is now on {state.project.branch ?? 'a detached HEAD'}; this session started on {session.branch ?? 'a detached HEAD'}.</p>}
            {session?.status === 'orphaned' && <p className="hint session-hint">The runtime that owned this terminal stopped while its process kept running. Journal cannot reattach to it. End it here, or leave it running and close it later.</p>}
            {session?.status === 'interrupted' && <p className="hint session-hint">This session's runtime stopped unexpectedly. Its prompt delivery is marked uncertain and nothing was resent.{resumable(session) ? ' Resume reopens the exact native conversation.' : ''}</p>}
            {!!session?.survivors?.length && <p className="hint session-hint">Child processes outlived the agent: {session.survivors.map(s => `${s.pid} ${s.command}`).join('; ')}</p>}
            {session ? <TerminalPane key={session.id} sessionId={session.id} live={isLive(session) && connected} appearance={appearance} onError={setError} /> : <div className="terminal-empty"><img className="terminal-brand-mark" src={journalMark} alt="" width={50} height={50} /><h2>A familiar place to work.</h2><p>Start an agent above. Your native login, settings,<br />and tool approvals stay with the CLI.</p></div>}
            {session && !isLive(session) && session.status !== 'orphaned' && !session.nativeIdConfirmed && <div className="resume-id"><label>Native session ID<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder="Exact UUID from the native CLI" /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); merge([next]); })}>Confirm resume ID</button></div>}
            <footer className="terminal-footer"><span>{state.project.root}</span><span>Native permissions · volatile output</span></footer>
          </section>
        </>}
    </main>

    {state && <aside className="knowledge-panel" id="knowledge-sidebar"><div className="panel-tabs" role="tablist" aria-label="Project information">
      <button role="tab" aria-selected={panel === 'knowledge'} onClick={() => setPanel('knowledge')}><span className="panel-tab-label">Knowledge</span></button>
      <button role="tab" aria-selected={panel === 'context'} onClick={() => setPanel('context')}><span className="panel-tab-label">Context</span></button>
      <button role="tab" aria-selected={panel === 'changes'} disabled={!session} onClick={() => setPanel('changes')}><span className="panel-tab-label">Changes</span></button>
      <button role="tab" aria-selected={panel === 'activity'} disabled={!session} onClick={() => setPanel('activity')}><span className="panel-tab-label">Activity</span></button></div>
      {panel === 'knowledge' && <KnowledgePanel project={state.project} version={knowledgeVersion} busy={busy} onEdit={setForm} onPropose={scope => void proposeUpdate(scope)} onChanged={() => setKnowledgeVersion(v => v + 1)} onError={failed} />}
      {panel === 'changes' && session && <ChangesPanel session={session} />}
      {panel === 'activity' && session && <ActivityPanel session={session} live={liveEvents} />}
      {(panel === 'context' || (!session && (panel === 'changes' || panel === 'activity'))) && <div className="panel-content context-content"><div className="section-heading"><div><span className="eyebrow">WHAT THE AGENT RECEIVES</span><h2>Context receipt</h2></div></div><p className="muted panel-intro">{receipt?.launchPrompt !== undefined ? 'Exact launch text, including reviewed knowledge and the initial task.' : 'Reviewed knowledge selected for this task.'} Native instructions and conversation history remain separate.</p>
        {receipt ? <><div className="receipt-meta"><span>{receipt.items.length} claims</span><span>≈{receipt.estimatedTokens} knowledge tokens</span><span className="receipt-state">{receipt.state}</span></div><pre className="context-packet" data-testid="context-packet" dir="auto">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>{receipt.excluded.length > 0 && <details><summary>{receipt.excluded.length} matching claims excluded</summary>{receipt.excluded.map(x => <p key={x.id + x.reason} className="muted">{x.id.slice(0, 8)} · {x.reason}</p>)}</details>}<p className="receipt-note">{receipt.state === 'prepared' ? 'Preview only. Sources are checked again when you start.' : receipt.state === 'submitted' ? 'Submitted means the CLI process started with this text. It does not prove the model read or used it.' : receipt.state === 'failed' ? 'Launch failed. Delivery to the native CLI was not confirmed.' : 'Delivery is uncertain after interruption. No input will be replayed automatically.'}</p><small className="receipt-id">{receipt.id}</small></> : <div className="knowledge-empty"><h3>Inspect before you start.</h3><p>Enter an initial task and preview its context.</p></div>}
        {receipt?.warnings?.map(warning => <p className="hint" key={warning}>{warning}</p>)}
        {state.receipts.length > 0 && <div className="receipt-history"><span className="eyebrow">RECENT RECEIPTS</span>{state.receipts.slice(0, 10).map(r => <button key={r.id} onClick={() => setReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{r.items.length} claims · {r.state}</small></button>)}</div>}
      </div>}
    </aside>}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} initialCategory={form.initialCategory} draft={form.draft} onClose={() => setForm(null)} onSaved={() => { setForm(null); setPanel('knowledge'); setKnowledgeVersion(v => v + 1); }} />}
  </ResizableWorkspace>;
}
