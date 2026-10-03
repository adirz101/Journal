import { useEffect, useRef } from 'react';
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { standardKeymap } from '@codemirror/commands';
import { classHighlighter } from '@lezer/highlight';

// Read-only, text-only preview: nothing is rendered as HTML, control and
// bidirectional characters are shown visibly, and only the viewport is drawn.
// Loaded on first use so the editor costs nothing until a file is opened.

export interface LineRange { startLine: number; endLine: number; }

async function language(path: string, diff: boolean): Promise<Extension | null> {
  if (diff) return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff);
  const name = path.split('/').pop()!.toLowerCase(); const ext = name.includes('.') ? name.split('.').pop()! : name;
  const legacy = async (load: () => Promise<Record<string, any>>, key: string) => StreamLanguage.define((await load())[key]);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return (await import('@codemirror/lang-javascript')).javascript();
    case 'jsx': return (await import('@codemirror/lang-javascript')).javascript({ jsx: true });
    case 'ts': case 'mts': case 'cts': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true });
    case 'tsx': return (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true });
    case 'json': case 'jsonc': return (await import('@codemirror/lang-json')).json();
    case 'md': case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'py': return (await import('@codemirror/lang-python')).python();
    case 'yml': case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'sh': case 'bash': case 'zsh': return legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell');
    case 'toml': return legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml');
    case 'rs': return legacy(() => import('@codemirror/legacy-modes/mode/rust'), 'rust');
    case 'go': return legacy(() => import('@codemirror/legacy-modes/mode/go'), 'go');
    case 'rb': return legacy(() => import('@codemirror/legacy-modes/mode/ruby'), 'ruby');
    case 'swift': return legacy(() => import('@codemirror/legacy-modes/mode/swift'), 'swift');
    case 'c': case 'h': return legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'c');
    case 'cc': case 'cpp': case 'hpp': case 'cxx': return legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'cpp');
    case 'java': return legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'java');
    case 'kt': case 'kts': return legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'kotlin');
    case 'cs': return legacy(() => import('@codemirror/legacy-modes/mode/clike'), 'csharp');
    case 'css': case 'scss': case 'less': return legacy(() => import('@codemirror/legacy-modes/mode/css'), 'css');
    case 'html': case 'htm': case 'xml': case 'svg': return legacy(() => import('@codemirror/legacy-modes/mode/xml'), 'xml');
    case 'sql': return legacy(() => import('@codemirror/legacy-modes/mode/sql'), 'standardSQL');
    case 'diff': case 'patch': return legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff');
    case 'dockerfile': return legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile');
    default: return null;
  }
}

// The selected lines; a selection ending at the start of a line excludes that line.
function selectedLines(state: EditorState): LineRange | null {
  const range = state.selection.main; if (range.empty) return null;
  const start = state.doc.lineAt(range.from); let end = state.doc.lineAt(range.to);
  if (range.to === end.from && end.number > start.number) end = state.doc.line(end.number - 1);
  return { startLine: start.number, endLine: end.number };
}

export default function FilePreview({ text, path, highlight, diff = false, initialLine, onSelection }: {
  text: string; path: string; highlight: boolean; diff?: boolean; initialLine?: number; onSelection: (range: LineRange | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null); const view = useRef<EditorView | null>(null);
  const selection = useRef(onSelection); selection.current = onSelection;
  useEffect(() => {
    let disposed = false; let anchor: number | null = null;
    const gutter = lineNumbers({ domEventHandlers: {
      // Click a line number to select the line; Shift-click extends the selection.
      mousedown: (target, line, event) => {
        const mouse = event as MouseEvent; const clicked = target.state.doc.lineAt(line.from);
        if (mouse.shiftKey && anchor !== null) {
          const first = target.state.doc.line(Math.min(anchor, clicked.number)); const last = target.state.doc.line(Math.max(anchor, clicked.number));
          target.dispatch({ selection: EditorSelection.single(first.from, last.to) });
        } else { anchor = clicked.number; target.dispatch({ selection: EditorSelection.single(clicked.from, clicked.to) }); }
        target.focus(); return true;
      },
    } });
    const languageSlot = new Compartment();
    const extensions: Extension[] = [gutter, highlightSpecialChars(), drawSelection(), EditorState.readOnly.of(true), languageSlot.of([]),
      search({ top: true }), keymap.of([...searchKeymap, ...standardKeymap]), syntaxHighlighting(classHighlighter),
      EditorView.contentAttributes.of({ 'aria-label': `${diff ? 'Diff of' : 'Contents of'} ${path}`, 'aria-readonly': 'true' }),
      EditorView.updateListener.of(update => { if (update.selectionSet) selection.current(selectedLines(update.state)); })];
    const state = EditorState.create({ doc: text, extensions });
    const editor = new EditorView({ state, parent: host.current! }); view.current = editor;
    if (initialLine && initialLine <= state.doc.lines) {
      const line = state.doc.line(initialLine); editor.dispatch({ selection: EditorSelection.single(line.from, line.to), effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
    }
    // Languages load after the text is shown; very large files stay plain.
    if (highlight) void language(path, diff).then(lang => { if (!disposed && lang) editor.dispatch({ effects: languageSlot.reconfigure(lang) }); }).catch(() => {});
    selection.current(null);
    return () => { disposed = true; editor.destroy(); view.current = null; };
  }, [text, path, highlight, diff, initialLine]);
  return <div className="file-preview-editor" ref={host} />;
}
