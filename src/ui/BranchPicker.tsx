import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useModalDialog } from './useModalDialog';
import { branches as words } from './copy';
import { branchDetail, branchGroups, keepActiveBranch, matchSpan, moveActiveBranch, type Branch, type BranchList, type BranchOption, type SwitchResult } from './branchModel';
import { api, type FileRoot } from './types';

// Switch the branch of one repository of the project: the checkout, one of its worktrees, or
// an added Git folder. The repository is chosen first (a list, shown when the project has more
// than one) and named in the title, so it is always clear which working tree changes.
// Same pattern as the command palette: the search input is a combobox controlling a named
// listbox (aria-activedescendant), opening and closing are instant, Escape closes and focus
// returns to the control that opened it (useModalDialog). Creating a local branch from a remote
// one asks first; every other switch happens on Enter.
interface Repo { key: string; label: string; branch: string | null }

export function BranchPicker({ projectId, rootKey, onClose, onSwitched }: {
  projectId: string; rootKey: string; onClose(): void; onSwitched(result: SwitchResult): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null); const input = useRef<HTMLInputElement>(null); const confirmButton = useRef<HTMLButtonElement>(null);
  useModalDialog(dialog);
  useEffect(() => { input.current?.focus(); }, []);
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [key, setKey] = useState(rootKey);
  const [list, setList] = useState<BranchList | null>(null); const [loadError, setLoadError] = useState('');
  const [query, setQuery] = useState(''); const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); const [failure, setFailure] = useState(''); const [hint, setHint] = useState('');
  const [confirm, setConfirm] = useState<Branch | null>(null);

  // Every Git working tree of the project: the checkout and ready worktrees, then Git folders that exist.
  useEffect(() => {
    let current = true;
    void api<{ primary: FileRoot[]; folders: FileRoot[] }>('fileRoots', { projectId }).then(found => {
      if (!current) return;
      setRepos([...found.primary, ...found.folders.filter(root => root.git && root.exists !== false)].map(root => ({ key: root.key, label: root.label, branch: root.branch })));
    }).catch(() => { if (current) setRepos([]); });
    return () => { current = false; };
  }, [projectId]);

  const ticket = useRef(0);
  useEffect(() => {
    const mine = ++ticket.current; setList(null); setLoadError(''); setFailure(''); setChosen(null); setEnterPending(false);
    void api<BranchList>('branches', { projectId, rootKey: key }).then(next => { if (mine === ticket.current) setList(next); })
      .catch(error => { if (mine === ticket.current) setLoadError(error instanceof Error ? error.message : String(error)); });
  }, [projectId, key]);

  const groups = useMemo(() => branchGroups(list, query), [list, query]);
  const flat = useMemo(() => groups.flatMap(group => group.options), [groups]);
  const active = keepActiveBranch(groups, chosen);
  const domIds = useMemo(() => new Map(flat.map((option, i) => [option.id, `branch-option-${i}`])), [flat]);
  const activeDom = active ? domIds.get(active) : undefined;
  useEffect(() => { if (activeDom) document.getElementById(activeDom)?.scrollIntoView({ block: 'nearest' }); }, [activeDom]);
  useEffect(() => { if (confirm) confirmButton.current?.focus(); }, [confirm]);

  const repoLabel = list?.label ?? repos?.find(repo => repo.key === key)?.label ?? '';
  const title = words.title(repoLabel);

  async function choose(option: BranchOption | undefined) {
    if (!option || busy) return;
    // An unavailable branch says why in the note (not as an error); a running session is already explained above the list.
    if (!option.enabled) { setHint(list?.blocked && !option.branch.worktree && !option.branch.conflict ? '' : option.reason ?? ''); return; }
    if (option.branch.current) { onClose(); return; }
    if (option.branch.kind === 'remote') { setConfirm(option.branch); return; }
    await run(option.branch);
  }
  async function run(branch: Branch) {
    setBusy(branch.name); setFailure('');
    try {
      const result = await api<SwitchResult>('switchBranch', { projectId, rootKey: key, kind: branch.kind, name: branch.name });
      onSwitched(result); onClose();
    } catch (error) {
      setBusy(null); setConfirm(null); setFailure(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => input.current?.focus());
      // The list may have changed meanwhile (a worktree took the branch, a session started).
      void api<BranchList>('branches', { projectId, rootKey: key }).then(next => setList(next)).catch(() => {});
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.altKey || event.metaKey || event.ctrlKey) return;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? 'last' : event.key === 'PageUp' ? 'first' : null;
    if (step !== null) { event.preventDefault(); setChosen(moveActiveBranch(groups, active, step)); setHint(''); return; }
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (!list && !loadError) setEnterPending(true); else void choose(flat.find(option => option.id === active)); }
  }
  // Enter typed before the list arrived (a quick type-and-Enter) acts once it is there, on what the query then matches.
  const [enterPending, setEnterPending] = useState(false);
  useEffect(() => { if (enterPending && list) { setEnterPending(false); void choose(flat.find(option => option.id === active)); } }); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (loadError) setEnterPending(false); }, [loadError]);

  const note = loadError ? loadError : !list ? words.loading : busy ? words.switching(busy)
    : !list.local.length && !list.remote.length ? words.empty : query.trim() && !flat.length ? words.none(query.trim()) : '';
  const many = (repos?.length ?? 0) > 1;

  const option = (item: BranchOption) => {
    const on = item.id === active; const branch = item.branch; const span = matchSpan(branch.name, query);
    const name = span ? <>{branch.name.slice(0, span[0])}<mark>{branch.name.slice(span[0], span[1])}</mark>{branch.name.slice(span[1])}</> : branch.name;
    return <div key={item.id} id={domIds.get(item.id)} role="option" aria-selected={on} aria-disabled={!item.enabled || undefined} aria-current={branch.current || undefined}
      className={`palette-option branch-option${on ? ' active' : ''}${branch.current ? ' current' : ''}`} title={branch.subject || undefined}
      onPointerMove={() => { if (!on) { setChosen(item.id); setHint(''); } }} onMouseDown={event => event.preventDefault()} onClick={() => void choose(item)}>
      <span className="palette-glyph" aria-hidden="true">{branch.current ? '✓' : branch.kind === 'remote' ? '↓' : '⑂'}</span>
      <span className="palette-label branch-name">{name}</span>
      {item.reason ? <span className="palette-detail palette-reason">{item.reason}</span> : <span className="palette-detail">{branchDetail(branch, Date.now())}</span>}
    </div>;
  };

  // Escape: back to the list from the confirmation, else close (the dialog's native cancel).
  return <dialog ref={dialog} className="palette branch-picker" aria-label={title} onCancel={event => { event.preventDefault(); if (confirm) { setConfirm(null); requestAnimationFrame(() => input.current?.focus()); } else onClose(); }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="palette-box">
      <div className="branch-head">
        <h2 className="branch-title">{words.heading}</h2>
        {many ? <label className="branch-repo"><span className="visually-hidden">{words.repository}</span>
          <select aria-label={words.repository} value={key} disabled={!!busy || !!confirm} onChange={event => { setKey(event.target.value); setQuery(''); setConfirm(null); }}>
            {repos!.map(repo => <option key={repo.key} value={repo.key}>{repo.label}{repo.branch ? ` · ${repo.branch}` : ''}</option>)}
          </select></label>
          : <span className="branch-repo-name">{repoLabel}</span>}
      </div>
      {confirm ? <div className="branch-confirm" role="group" aria-labelledby="branch-confirm-title" aria-describedby="branch-confirm-body">
        <p id="branch-confirm-title" className="branch-confirm-title">{words.confirmTitle}</p>
        <p id="branch-confirm-body">{words.confirmBody(confirm.localName ?? confirm.name, confirm.name, repoLabel)}</p>
        <div className="branch-confirm-actions">
          <button type="button" disabled={!!busy} onClick={() => { setConfirm(null); requestAnimationFrame(() => input.current?.focus()); }}>{words.cancel}</button>
          <button type="button" ref={confirmButton} className="primary" disabled={!!busy} onClick={() => void run(confirm)}>{busy ? words.switching(confirm.localName ?? confirm.name) : words.confirm}</button>
        </div>
      </div> : <>
        <div className="palette-search">
          <svg className="palette-icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={input} role="combobox" aria-expanded="true" aria-controls="branch-list" aria-autocomplete="list" aria-activedescendant={activeDom} aria-label={title} aria-describedby="branch-how"
            placeholder={words.placeholder} value={query} onChange={event => { setQuery(event.target.value); setChosen(null); setFailure(''); setHint(''); }} onKeyDown={onKeyDown}
            spellCheck={false} autoComplete="off" maxLength={200} readOnly={!!busy} />
          <kbd aria-hidden="true">esc</kbd>
        </div>
        <p id="branch-how" className="visually-hidden">{words.howTo}</p>
        {list?.blocked && <p className="branch-blocked" role="status">{list.blocked}</p>}
        {list?.detached && <p className="branch-detached">{words.detached}{list.head ? ` · ${list.head.slice(0, 7)}` : ''}</p>}
        <div id="branch-list" role="listbox" aria-label={words.list} aria-busy={!list || undefined} className="palette-list">
          {groups.map(group => <div key={group.id} role="group" aria-labelledby={`branch-group-${group.id}`} className="palette-group">
            <div id={`branch-group-${group.id}`} role="presentation" className="palette-caption">{group.label}</div>
            {group.options.map(option)}
          </div>)}
        </div>
      </>}
      <p className={`palette-note${failure ? ' branch-failure' : ''}${note || failure || hint || list?.truncated ? '' : ' empty'}`} role={failure || loadError ? 'alert' : 'status'}>{failure || note || hint || (list?.truncated ? words.truncated(2000) : '')}</p>
      <p className="visually-hidden" role="status" aria-live="polite">{list && !confirm ? words.resultCount(flat.length) : ''}</p>
      {!confirm && <div className="palette-footer" aria-hidden="true">
        <span><kbd>↑↓</kbd> {words.move}</span><span><kbd>↵</kbd> {words.choose}</span>{many && <span className="palette-footer-end"><kbd>tab</kbd> {words.repoKey}</span>}
      </div>}
    </div>
  </dialog>;
}
