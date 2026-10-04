import type { AgentInfo } from './types';
import { ProviderMark } from './ProviderMark';

// Cursor's provider row when something needs the user: not installed, not the
// real Cursor CLI, too old, or signed out. Installing and signing in always run
// visibly, after confirmation; Journal never handles Cursor credentials.
export function CursorStatus({ agent, checking, note, onInstall, onLogin, onCheck }: {
  agent: AgentInfo | undefined; checking: boolean; note: string;
  onInstall: () => void; onLogin: () => void; onCheck: () => void;
}) {
  if (!agent) return null;
  const check = <button className="text-button" disabled={checking} onClick={onCheck}>{checking ? 'Checking…' : 'Check again'}</button>;
  const install = <button disabled={checking} onClick={onInstall}>Install Cursor CLI</button>;
  const signIn = <button disabled={checking} onClick={onLogin}>Sign in to Cursor</button>;
  let body: React.ReactNode = null;
  if (agent.state === 'checking') body = <p className="muted">Checking for the Cursor CLI…</p>;
  else if (agent.state === 'unlaunchable') body = <><p><strong>Cursor Agent</strong> · cannot be started</p><p className="muted">Journal found {agent.unlaunchable?.path} but cannot start it safely: {agent.unlaunchable?.reason}</p><div className="provider-actions">{check}</div></>;
  else if (agent.state === 'missing') body = <><p><strong>Cursor Agent</strong> · CLI not found</p><p className="muted">Run Cursor's official installer to add the Cursor Agent CLI.</p><div className="provider-actions">{install}{check}</div></>;
  else if (agent.state === 'not-cursor') body = <><p><strong>Cursor Agent</strong> · not the Cursor CLI</p><p className="muted">An <code>agent</code> command at {agent.impostor} does not identify as the Cursor CLI, so Journal will not run it.</p><div className="provider-actions">{install}{check}</div></>;
  else if (agent.state === 'unsupported') body = <><p><strong>Cursor Agent</strong> {agent.version} · unsupported version</p><p className="muted">This version cannot open a chat by its exact ID. Update it in a terminal with <code>agent update</code>.</p><div className="provider-actions">{check}</div></>;
  else if (agent.state === 'login-required') body = <><p><strong>Cursor</strong> {agent.version} · login required</p><p className="muted">Sign in with Cursor's own login flow. Journal does not see or store your credentials.</p><div className="provider-actions">{signIn}{check}</div></>;
  else if (agent.available && agent.auth !== 'signed-in') body = <><p><strong>Cursor</strong> {agent.version} · {agent.auth === 'unchecked' ? 'checking sign-in…' : 'sign-in status unknown'}</p><div className="provider-actions">{signIn}{check}</div></>;
  const hints = [
    agent.available && agent.onPath === false && `Journal uses ${agent.path}, which is not on your PATH. To run agent in your own terminal, add its folder to PATH (the installer printed the command).`,
    agent.available && agent.supports && !agent.supports.mode && 'This version has no Ask or Plan mode, so Read-only and Plan are unavailable for Cursor. Update with agent update.',
  ].filter(Boolean) as string[];
  if (!body && !hints.length && !note) return null;
  return <section className="provider-status" aria-label="Cursor provider status"><ProviderMark provider="cursor" size={20} />{body}{hints.map(hint => <p className="hint" key={hint}>{hint}</p>)}{note && <p className="hint" role="status">{note}</p>}</section>;
}
