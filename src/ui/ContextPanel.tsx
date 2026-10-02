import { useState } from 'react';
import { api, type Bootstrap, type Receipt, type Session } from './types';

const reasons: Record<string, string> = {
  stale: 'evidence changed', 'wrong-branch': 'other branch', 'area-not-requested': 'area not in task', duplicate: 'duplicate of a selected claim',
  'brief-limit': 'orientation limit', budget: 'context budget', 'category-limit': 'too many of one kind', 'left-out-for-task': 'left out by you',
};

// What the agent receives: the exact packet, why each claim is there, what
// was left out and why, and what Journal cannot observe.
export function ContextPanel({ receipt, session, bootstrap, history, disabled, onToggle, onSelectReceipt, onChanged, onError }: {
  receipt: Receipt | null; session: Session | null; bootstrap: Bootstrap | null; history: Receipt[]; disabled: string[];
  onToggle: (id: string) => void; onSelectReceipt: (receipt: Receipt) => void; onChanged: () => void; onError: (error: unknown) => void;
}) {
  const [raw, setRaw] = useState(false); const [open, setOpen] = useState<string | null>(null);
  const preview = receipt?.state === 'prepared';
  const agent = session ? bootstrap?.agents.find(a => a.provider === session.provider) : null;
  const act = async (action: () => Promise<unknown>) => { try { await action(); onChanged(); } catch (error) { onError(error); } };
  return <div className="panel-content context-content"><div className="section-heading"><div><span className="eyebrow">WHAT THE AGENT RECEIVES</span><h2>Context inspector</h2></div></div>
    {!receipt ? <div className="knowledge-empty"><h3>Inspect before you start.</h3><p>Enter an initial task and preview its context.</p></div> : <>
      <div className="receipt-meta"><span>{receipt.items.length} claim{receipt.items.length === 1 ? '' : 's'}</span><span>{new TextEncoder().encode(receipt.packet).length} bytes · ≈{receipt.estimatedTokens} tokens</span><span className="receipt-state">{receipt.state}</span></div>
      <dl className="receipt-facts"><dt>Task</dt><dd>{receipt.query || <em>none (orientation only)</em>}</dd>
        <dt>Checkout</dt><dd>⑂ {(receipt as any).checkout?.branch ?? 'detached'} @ {String((receipt as any).checkout?.head ?? '').slice(0, 7) || 'unborn'}{receipt.workspaceId ? ' · worktree' : ''}</dd>
        {session && <><dt>Route</dt><dd>{session.provider === 'claude' ? 'Claude Code' : 'Codex'} {agent?.version ?? ''} · initial CLI prompt{session.research ? ' · research mode' : ''}</dd>
          <dt>Not observable</dt><dd>{session.provider === 'claude' ? 'Whether the model read or used each claim; tool output; hidden reasoning.' : 'Whether the model read or used each claim; commands and test results; tool output; hidden reasoning.'}</dd></>}</dl>
      <ol className="receipt-items">{receipt.items.map(item => <li key={item.id}>
        <div className="memory-meta"><span>{item.category}{item.pinned ? ' · pinned' : ''}</span><span>{item.selection?.reason ?? 'selected'} · {item.selection?.bytes ?? 0} B</span></div>
        <p dir="auto">{item.statement}</p>
        <small className="memory-scope">{item.scope === 'branch' ? `⑂ ${item.branch}` : 'All branches'}{item.area ? ` · ${item.area}` : ''}{item.environment ? ` · applies when: ${item.environment}` : ''} · r{item.revision}</small>
        <button className="source-button" aria-expanded={open === item.id} onClick={() => setOpen(open === item.id ? null : item.id)}>{item.source.kind === 'file' ? `↗ ${item.source.path}:${item.source.startLine}` : item.source.kind === 'git' ? '↗ Git history' : '↗ Your statement'}<span>{open === item.id ? '−' : '+'}</span></button>
        {open === item.id && <div className="evidence-details"><pre dir="auto">{item.source.excerpt ?? item.source.note ?? `${item.source.base ?? ''} → ${item.source.head ?? ''}`}</pre></div>}
        <div className="memory-actions">
          {preview && <button onClick={() => onToggle(item.id)}>Leave out for this task</button>}
          {item.category !== 'brief' && <button onClick={() => void act(() => api('setPinned', { id: item.id, pinned: !item.pinned }))}>{item.pinned ? 'Unpin' : 'Pin'}</button>}
          <button onClick={() => void act(() => api('markIncorrect', { id: item.id }))}>Mark incorrect</button>
        </div>
      </li>)}</ol>
      {preview && disabled.length > 0 && <p className="hint">{disabled.length} claim{disabled.length === 1 ? '' : 's'} left out for the next start. <button className="text-button" onClick={() => disabled.forEach(onToggle)}>Restore all</button></p>}
      {receipt.excluded.length > 0 && <details><summary>{receipt.excluded.length} considered and excluded</summary>{receipt.excluded.map(x => <p key={x.id + x.reason} className="muted">{x.id.slice(0, 8)} · {reasons[x.reason] ?? x.reason}{x.reason === 'left-out-for-task' && preview ? <> · <button className="text-button" onClick={() => onToggle(x.id)}>restore</button></> : null}</p>)}</details>}
      {receipt.warnings?.map(warning => <p className="hint" key={warning}>{warning}</p>)}
      <button className="text-button" aria-expanded={raw} onClick={() => setRaw(!raw)}>{raw ? 'Hide' : 'Show'} exact {receipt.launchPrompt !== undefined ? 'launch text' : 'packet'}</button>
      {raw && <pre className="context-packet" data-testid="context-packet" dir="auto">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>}
      {!raw && <pre className="context-packet visually-hidden" data-testid="context-packet" aria-hidden="true">{(receipt.launchPrompt ?? receipt.packet) || 'No Journal text supplied at launch.'}</pre>}
      <p className="receipt-note">{receipt.state === 'prepared' ? 'Preview only. Sources are checked again when you start.' : receipt.state === 'submitted' ? 'Submitted means the CLI process started with this text. It does not prove the model read or used it.' : receipt.state === 'failed' ? 'Launch failed. Delivery to the native CLI was not confirmed.' : 'Delivery is uncertain after interruption. No input will be replayed automatically.'} Historical receipts never change.</p><small className="receipt-id">{receipt.id}</small>
    </>}
    {history.length > 0 && <div className="receipt-history"><span className="eyebrow">RECENT RECEIPTS</span>{history.slice(0, 10).map(r => <button key={r.id} onClick={() => onSelectReceipt(r)}><span>{r.query || 'Interactive session'}</span><small>{r.items.length} claims · {r.state} · {new Date(r.createdAt).toLocaleString()}</small></button>)}</div>}
  </div>;
}
