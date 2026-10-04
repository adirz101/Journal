import type { Changes, Receipt, UpdateState } from './types';
import { diffSummary, statusLine } from './sessionView';
import { shell, tip } from './copy';
import { UpdateNotice } from './UpdateNotice';

// The bar under the terminal (board B4): what the agent got at launch, what
// the session changed, and that output is never saved. receipt: this
// session's own receipt only (never a preview).
export function StatusBar({ receipt, changes, update, onShowSent, onError }: {
  receipt: Receipt | null; changes: Changes | null; update: UpdateState | null; onShowSent(): void; onError(error: unknown): void;
}) {
  const line = statusLine(receipt); const diff = diffSummary(changes);
  return <footer className="status-bar">
    {line.text && <span className="status-delivery">{line.text}{line.link && <> · <button className="link" title={tip.seeWhatWasSent} onClick={onShowSent}>{line.link === 'sent' ? shell.seeWhatWasSent : shell.seeWhatWasPrepared}</button></>}</span>}
    {diff && <span className="status-diff">{diff.files ? <><span className="t-g">+{diff.additions}</span> <span className="t-r">−{diff.deletions}</span> {shell.diffFiles(diff.files)}</> : shell.noChanges}</span>}
    <span className="status-right"><span className="status-native">{shell.nativePermissions} · </span><span title={tip.outputNotSaved}>{shell.outputNotSaved}</span></span>
    <UpdateNotice compact state={update} onError={onError} />
  </footer>;
}
