import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TerminalPane } from './TerminalPane';
import { KnowledgeForm } from './KnowledgeForm';
import { ResizableWorkspace } from './ResizableWorkspace';
import journalMarkWhite from '../../assets/branding/journal-mark-white.png';
import journalMarkDark from '../../assets/branding/journal-mark.png';
import journalWordmark from '../../assets/branding/journal-wordmark.png';
import { storedAppearance, type Appearance } from './theme';
import { api, type Bootstrap, type Memory, type Project, type ProjectState, type Provider, type Receipt, type Session } from './types';

const isLive = (session: Session | null) => !!session && ['starting', 'running', 'waiting'].includes(session.status);

export default function App() {
  const [appearance, setAppearance] = useState<Appearance>(storedAppearance);
  const journalMark = appearance === 'light' ? journalMarkDark : journalMarkWhite;
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = appearance;
    try { localStorage.setItem('journal-theme', appearance); } catch { /* Keep the toggle usable if storage is unavailable. */ }
  }, [appearance]);
  const [bootstrap, setBootstrap] = useState<Bootstrap | null>(null); const [projects, setProjects] = useState<Project[]>([]);
  const [state, setState] = useState<ProjectState | null>(null); const [session, setSession] = useState<Session | null>(null); const [active, setActive] = useState<Session | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null); const [task, setTask] = useState('');
  const [panel, setPanel] = useState<'knowledge' | 'context'>('knowledge'); const [filter, setFilter] = useState('all'); const [search, setSearch] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false); const [form, setForm] = useState<{ memory?: Memory; initialCategory?: string } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [resumeDraft, setResumeDraft] = useState<{ sessionId: string; value: string } | null>(null);
  // A confirmation draft belongs to one launch, never to another conversation.
  const resumeValue = resumeDraft?.sessionId === session?.id ? resumeDraft?.value ?? '' : session?.nativeId ?? '';
  const taskRef = useRef<HTMLTextAreaElement>(null); const projectRef = useRef<Project | null>(null); const sessionRef = useRef<Session | null>(null);
  projectRef.current = state?.project ?? null; sessionRef.current = session;
  const failed = (error: unknown) => setError(error instanceof Error ? error.message : String(error));
  useEffect(() => { void api('setAppearance', { appearance }).catch(failed); }, [appearance]);
  const refresh = useCallback(async (id?: string) => {
    const projectId = id ?? projectRef.current?.id; if (!projectId) return;
    const next = await api<ProjectState>('project', { projectId }); setState(next); return next;
  }, []);
  useEffect(() => {
    void api<Bootstrap>('bootstrap').then(async data => {
      setBootstrap(data); setProjects(data.projects); setActive(data.activeSession);
      const selected = data.projects.find(p => p.id === (data.activeSession?.projectId ?? localStorage.getItem('journal-project')));
      if (selected) {
        const next = await refresh(selected.id);
        if (data.activeSession) { setSession(data.activeSession); setReceipt(await api<Receipt>('getReceipt', { id: data.activeSession.receiptId })); }
        else if (next?.receipts[0]) setReceipt(next.receipts[0]);
      }
    }).catch(failed);
    return window.journal?.onEvent(event => {
      if (event.type === 'error') { setError(event.message); return; }
      if (event.type !== 'status') return;
      setActive(isLive(event.session) ? event.session : null);
      if (sessionRef.current?.id === event.session.id) setSession(event.session);
      if (projectRef.current?.id === event.session.projectId) void refresh().catch(failed);
    });
  }, [refresh]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(''); try { await action(); } catch (error) { failed(error); } finally { setBusy(false); } }
  async function chooseProject(project: Project) {
    await run(async () => { const next = await refresh(project.id); localStorage.setItem('journal-project', project.id); setSession(active?.projectId === project.id ? active : null); setReceipt(next?.receipts[0] ?? null); setTask(''); });
  }
  async function openProject() {
    await run(async () => { const project = await api<Project | null>('openProject'); if (!project) return; setProjects(items => [project, ...items.filter(p => p.id !== project.id)]); await refresh(project.id); localStorage.setItem('journal-project', project.id); setSession(null); setReceipt(null); });
  }
  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'o') { event.preventDefault(); void openProject(); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); taskRef.current?.focus(); }
      if (event.shiftKey && event.key.toLowerCase() === 'k' && projectRef.current) { event.preventDefault(); setForm({}); }
    };
    window.addEventListener('keydown', keyboard); return () => window.removeEventListener('keydown', keyboard);
  });
  async function start(provider: Provider, resumeId?: string) {
    if (!state) return;
    await run(async () => {
      const result = await api<{ session: Session; receipt: Receipt }>('start', { projectId: state.project.id, provider, task, resumeId });
      setSession(result.session); setActive(isLive(result.session) ? result.session : null); setReceipt(result.receipt); setTask(''); setPanel('context'); await refresh();
    });
  }
  async function selectSession(next: Session) {
    await run(async () => { setSession(next); setReceipt(await api<Receipt>('getReceipt', { id: next.receiptId })); });
  }
  const memories = state?.memories.filter(m => (filter === 'all' ? !['archived', 'rejected'].includes(m.status) : filter === 'review' ? m.status === 'candidate' : filter === 'active' ? m.status === 'active' : true) && `${m.statement} ${m.category} ${m.source.path ?? ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) ?? [];
  const candidates = state?.memories.filter(m => m.status === 'candidate').length ?? 0;
  const available = (provider: Provider) => bootstrap?.agents.some(a => a.provider === provider && a.available);

  return <ResizableWorkspace hasKnowledge={!!state}>
    <aside className="sidebar" id="project-sidebar">
      <div className="brand"><img className="brand-icon" src={journalMark} alt="" width={32} height={32} /><div>Journal<small>PROJECT MEMORY</small></div><span className="local-tag">LOCAL</span></div>
      <button className="open-project" onClick={() => void openProject()} disabled={busy}><span>＋</span> Open project <kbd>{bootstrap?.platform === 'darwin' ? '⌘' : 'Ctrl'} O</kbd></button>
      <div className="nav-caption">PROJECTS <span>{projects.length}</span></div>
      <nav aria-label="Projects">{projects.map(project => <button key={project.id} className={`project-link ${state?.project.id === project.id ? 'selected' : ''}`} onClick={() => void chooseProject(project)}><svg className="folder-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /><path d="M3 11h18" /></svg><span>{project.name}</span></button>)}</nav>
      {state && <><div className="nav-caption sessions-caption">SESSIONS <span>{state.sessions.length}</span></div><nav aria-label="Sessions" className="session-nav">{state.sessions.map(next => <div key={next.id} className={`session-row ${next.id === session?.id ? 'selected' : ''}`}>
        <button className="session-select" onClick={() => void selectSession(next)}><span className={`status-dot ${next.status}`} /><span><strong>{next.provider === 'claude' ? 'Claude Code' : 'Codex'}</strong><small>{next.title}</small></span><span className="session-status">{next.status}</span></button>
        {!isLive(next) && next.nativeIdConfirmed && <button className="resume-button" disabled={!!active || busy} onClick={() => void start(next.provider, next.id)}>Resume</button>}
      </div>)}{!state.sessions.length && <p className="nav-empty">Your sessions will appear here.</p>}</nav></>}
      <div className="sidebar-footer"><button className="theme-toggle" aria-label={`Switch to ${appearance === 'dark' ? 'light' : 'dark'} mode`} onClick={() => setAppearance(value => value === 'dark' ? 'light' : 'dark')}><span aria-hidden="true">{appearance === 'dark' ? '☀' : '◐'}</span> {appearance === 'dark' ? 'Light mode' : 'Dark mode'}</button><span className="status-dot running" /> Stored on this device<small>No terminal transcripts saved</small></div>
    </aside>

    <main className="workspace">
      <header className="workspace-heading"><div><span className="eyebrow">WORKSPACE</span><h1>{state?.project.name ?? 'Welcome to Journal'}</h1></div>{state && <span className="branch-badge">⑂ {state.project.branch ?? 'detached HEAD'} <span>{state.project.head?.slice(0, 7)}</span></span>}</header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError('')}>×</button></div>}
      {!state ? <section className="welcome"><img className="welcome-wordmark" src={journalWordmark} alt="Journal" width={280} height={84} /><span className="eyebrow">A CONTINUOUS THREAD</span><h2>Your project, remembered.</h2><p>Work with Claude Code and Codex in their native terminals.<br />Carry the decisions and lessons into the next session.</p><button className="primary" onClick={() => void openProject()} disabled={busy}>Open project</button><div className="welcome-steps"><span>01 <strong>Open a checkout</strong></span><span>02 <strong>Work in a terminal</strong></span><span>03 <strong>Keep what matters</strong></span></div></section>
        : <>
          <section className="launch-bar" aria-label="Start an agent terminal"><label htmlFor="initial-task">Initial task <span className="optional">optional · used to select relevant knowledge</span></label><textarea ref={taskRef} id="initial-task" value={task} onChange={e => setTask(e.target.value)} maxLength={4000} rows={2} placeholder="What are you working on? Add a path to include knowledge scoped to that area." />
            <div className="launch-actions"><div><button className="primary" disabled={busy || !!active || !available('claude')} onClick={() => void start('claude')}>Start Claude</button><button disabled={busy || !!active || !available('codex')} onClick={() => void start('codex')}>Start Codex</button></div><button className="text-button" disabled={busy} onClick={() => void run(async () => { setReceipt(await api<Receipt>('prepareContext', { projectId: state.project.id, task })); setPanel('context'); })}>Preview context ↗</button></div>
            {bootstrap?.agents.some(a => !a.available) && <p className="hint">{bootstrap.agents.filter(a => !a.available).map(a => a.provider).join(', ')} not found on PATH. Install the native CLI, then reopen Journal.</p>}
          </section>
          <section className="terminal-panel"><div className="terminal-heading"><div><span className={`status-dot ${session?.status ?? ''}`} /><strong>{session ? session.provider === 'claude' ? 'Claude Code' : 'Codex' : 'Terminal'}</strong><span className="terminal-label">{session?.status ?? 'Ready to start'}</span></div>{session && isLive(session) && <div><button onClick={() => void api('interrupt', { id: session.id }).catch(failed)}>Interrupt <kbd>^C</kbd></button><button onClick={() => void api('stop', { id: session.id }).catch(failed)}>Stop terminal</button></div>}</div>
            {session ? <TerminalPane sessionId={session.id} live={isLive(session)} appearance={appearance} onError={setError} /> : <div className="terminal-empty"><img className="terminal-brand-mark" src={journalMark} alt="" width={50} height={50} /><h2>A familiar place to work.</h2><p>Start an agent above. Your native login, settings,<br />and tool approvals stay with the CLI.</p></div>}
            {session && !isLive(session) && !session.nativeIdConfirmed && <div className="resume-id"><label>Native session ID<input value={resumeValue} onChange={e => setResumeDraft({ sessionId: session.id, value: e.target.value })} placeholder="Exact UUID from the native CLI" /></label><button disabled={busy} onClick={() => void run(async () => { const next = await api<Session>('confirmNativeId', { id: session.id, nativeId: resumeValue }); setSession(next); await refresh(); })}>Confirm resume ID</button></div>}
            <footer className="terminal-footer"><span>{state.project.root}</span><span>Native permissions · volatile output</span></footer>
          </section>
        </>}
    </main>

    {state && <aside className="knowledge-panel" id="knowledge-sidebar"><div className="panel-tabs" role="tablist" aria-label="Project information"><button role="tab" aria-selected={panel === 'knowledge'} onClick={() => setPanel('knowledge')}><span className="panel-tab-label">Knowledge <span className="panel-tab-count">{state.memories.filter(m => m.status === 'active').length}</span></span></button><button role="tab" aria-selected={panel === 'context'} onClick={() => setPanel('context')}><span className="panel-tab-label">Context</span></button></div>
      {panel === 'knowledge' ? <div className="panel-content"><div className="section-heading"><div><span className="eyebrow">A SHARED FOUNDATION</span><h2>Project knowledge</h2></div><button className="icon-button" aria-label="Add knowledge" onClick={() => setForm({})}>＋</button></div><p className="muted panel-intro">A repo overview and current branch update orient every session. Relevant decisions and lessons add task context.</p><button onClick={() => setForm({ initialCategory: 'brief' })}>Add project brief</button>
        <input className="knowledge-search" aria-label="Search knowledge" placeholder="Search knowledge…" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="filter-tabs"><button aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>Current</button><button aria-pressed={filter === 'review'} onClick={() => setFilter('review')}>Needs review <span>{candidates}</span></button><button aria-pressed={filter === 'active'} onClick={() => setFilter('active')}>Approved</button><button aria-pressed={filter === 'history'} onClick={() => setFilter('history')}>History</button></div>
        <div className="memory-list">{memories.map(memory => <article className="memory-card" key={memory.id}><div className="memory-meta"><span>{memory.category}</span><span className={`memory-state ${memory.validation !== 'current' ? 'stale' : memory.status}`}>{memory.validation !== 'current' ? memory.validation : memory.status === 'active' ? 'approved' : memory.status === 'candidate' ? 'needs review' : memory.status}</span></div><p dir="auto">{memory.statement}</p><div className="memory-scope">{memory.scope === 'branch' ? `⑂ ${memory.branch}` : 'This checkout'}{memory.area && ` · ${memory.area}`} · r{memory.revision}</div>
          <button className="source-button" onClick={() => setExpanded(expanded === memory.id ? null : memory.id)}>{memory.source.kind === 'file' ? `↗ ${memory.source.path}:${memory.source.startLine}` : '↗ Your statement'} <span>{expanded === memory.id ? '−' : '+'}</span></button>
          {expanded === memory.id && <div className="evidence-details"><pre dir="auto">{memory.source.excerpt ?? memory.source.note}</pre>{memory.source.contentHash && <small>Source fingerprint {memory.source.contentHash.slice(0, 12)}</small>}<small>Revision {memory.revisionId}</small></div>}
          <div className="memory-actions">{memory.status === 'candidate' && <><button className="approve" disabled={memory.validation !== 'current' || busy} onClick={() => void run(async () => { await api('setMemoryStatus', { id: memory.id, status: 'active' }); await refresh(); })}>Approve</button><button disabled={busy} onClick={() => void run(async () => { await api('setMemoryStatus', { id: memory.id, status: 'rejected' }); await refresh(); })}>Reject</button></>}<button onClick={() => setForm({ memory })}>Revise</button>{memory.status === 'active' && <button onClick={() => void run(async () => { await api('setMemoryStatus', { id: memory.id, status: 'archived' }); await refresh(); })}>Withdraw</button>}</div>
        </article>)}{!memories.length && <div className="knowledge-empty"><span>◇</span><h3>{search ? 'No matching knowledge' : filter === 'review' ? 'Nothing waiting for review' : 'Keep the useful parts.'}</h3><p>Add a decision, a constraint, or a lesson.<br />It becomes shared knowledge after you approve it.</p>{!search && <button onClick={() => setForm({})}>Add knowledge</button>}</div>}</div>
      </div> : <div className="panel-content context-content"><div className="section-heading"><div><span className="eyebrow">WHAT THE AGENT RECEIVES</span><h2>Context receipt</h2></div></div><p className="muted panel-intro">{receipt?.launchPrompt !== undefined ? 'Exact launch text, including reviewed knowledge and the initial task.' : 'Reviewed knowledge selected for this task.'} Native instructions and conversation history remain separate.</p>
        {receipt ? <><div className="receipt-meta"><span>{receipt.items.length} claims</span><span>≈{receipt.estimatedTokens} knowledge tokens</span><span className="receipt-state">{receipt.state}</span></div><pre className="context-packet" data-testid="context-packet" dir="auto">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>{receipt.excluded.length > 0 && <details><summary>{receipt.excluded.length} matching claims excluded</summary>{receipt.excluded.map(x => <p key={x.id} className="muted">{x.id.slice(0, 8)} · {x.reason}</p>)}</details>}<p className="receipt-note">{receipt.state === 'prepared' ? 'Preview only. Sources are checked again when you start.' : receipt.state === 'submitted' ? 'Submitted means the CLI process started with this text. It does not prove the model read or used it.' : receipt.state === 'failed' ? 'Launch failed. Delivery to the native CLI was not confirmed.' : 'Delivery is uncertain after interruption. No input will be replayed automatically.'}</p><small className="receipt-id">{receipt.id}</small></> : <div className="knowledge-empty"><h3>Inspect before you start.</h3><p>Enter an initial task and preview its context.</p></div>}
        {receipt?.warnings?.map(warning => <p className="hint" key={warning}>{warning}</p>)}
        {state.receipts.length > 0 && <div className="receipt-history"><span className="eyebrow">RECENT RECEIPTS</span>{state.receipts.slice(0, 10).map(r => <button key={r.id} onClick={() => setReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{r.items.length} claims · {r.state}</small></button>)}</div>}
      </div>}
    </aside>}
    {state && form && <KnowledgeForm project={state.project} memory={form.memory} initialCategory={form.initialCategory} onClose={() => setForm(null)} onSaved={() => { setForm(null); setPanel('knowledge'); void refresh().catch(failed); }} />}
  </ResizableWorkspace>;
}
