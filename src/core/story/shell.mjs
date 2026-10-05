// A small, deterministic shell reader for the Story (src/core/story/story.mjs). It does
// not run or expand anything: it splits a recorded command line into the simple commands
// it contains, so each can be classified. It understands quotes, escapes, $(...) and
// backticks, heredoc bodies (skipped), redirections and the connectors &&, ||, ;, | and &.
// Anything it cannot read stays a plain word: classification then treats it as unknown.

// One simple command: its words (assignments and redirections removed), the files it writes
// with > or >>, the command lines inside $(...) or backticks, and how it connects to the next.
// next: '&&', '||', ';', '|', '&' or null for the last one.

const isSpace = c => c === ' ' || c === '\t';
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/;

export function commandParts(line) {
  const text = typeof line === 'string' ? line : '';
  const parts = [];
  let words = []; let word = ''; let inWord = false; let writes = []; let subs = []; let redirect = null;
  const heredocs = []; let heredocBody = false;
  const endWord = () => {
    if (!inWord) return;
    if (redirect) { if (redirect === 'write' && word && !/^\/dev\/(?:null|stdout|stderr)$/.test(word)) writes.push(word); redirect = null; }
    else words.push(word);
    word = ''; inWord = false;
  };
  const endPart = next => {
    endWord();
    // Leading NAME=value words are assignments, not the command.
    let start = 0; while (start < words.length && ASSIGNMENT.test(words[start])) start++;
    const assignments = words.slice(0, start);
    parts.push({ words: words.slice(start), assignments, writes, subs, next });
    words = []; writes = []; subs = [];
  };
  // Reads a balanced $( ... ) or ` ... ` from i (at the opening), returning [content, index after].
  const readSub = (i, open) => {
    if (open === '`') { let j = i + 1; while (j < text.length && text[j] !== '`') { if (text[j] === '\\') j++; j++; } return [text.slice(i + 1, j), j + 1]; }
    let depth = 1; let j = i + 2; let quote = null;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (quote) { if (c === quote) quote = null; else if (c === '\\' && quote === '"') j++; }
      else if (c === "'" || c === '"') quote = c;
      else if (c === '\\') j++;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
      j++;
    }
    return [text.slice(i + 2, j - 1), j];
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\n') {
      endPart(';');
      // Heredoc bodies start after the line that opened them: skip to each delimiter line.
      i++;
      while (heredocs.length) {
        const { delimiter, strip } = heredocs.shift();
        while (i < text.length) {
          const end = text.indexOf('\n', i); const lineEnd = end === -1 ? text.length : end;
          const content = text.slice(i, lineEnd); i = lineEnd + 1;
          if ((strip ? content.replace(/^\t+/, '') : content) === delimiter) break;
          if (end === -1) heredocBody = true;
        }
      }
      continue;
    }
    if (isSpace(c)) { endWord(); i++; continue; }
    if (c === '#' && !inWord) { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === "'") { inWord = true; const end = text.indexOf("'", i + 1); const stop = end === -1 ? text.length : end; word += text.slice(i + 1, stop); i = stop + 1; continue; }
    if (c === '"') {
      inWord = true; let j = i + 1;
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\' && j + 1 < text.length) { word += text[j + 1]; j += 2; continue; }
        if (text[j] === '$' && text[j + 1] === '(') { const [inner, after] = readSub(j, '$('); subs.push(inner); word += `$(${inner})`; j = after; continue; }
        word += text[j]; j++;
      }
      i = j + 1; continue;
    }
    if (c === '\\') { inWord = true; if (text[i + 1] === '\n') { i += 2; continue; } word += text[i + 1] ?? ''; i += 2; continue; }
    if (c === '$' && text[i + 1] === '(') { inWord = true; const [inner, after] = readSub(i, '$('); subs.push(inner); word += `$(${inner})`; i = after; continue; }
    if (c === '`') { inWord = true; const [inner, after] = readSub(i, '`'); subs.push(inner); word += `\`${inner}\``; i = after; continue; }
    if (c === '&' && text[i + 1] === '&') { endPart('&&'); i += 2; continue; }
    if (c === '|' && text[i + 1] === '|') { endPart('||'); i += 2; continue; }
    if (c === '|') { endPart('|'); i += text[i + 1] === '&' ? 2 : 1; continue; }
    if (c === ';') { endPart(';'); i += text[i + 1] === ';' ? 2 : 1; continue; }
    if (c === '&' && text[i + 1] === '>') { endWord(); redirect = 'write'; i += text[i + 2] === '>' ? 3 : 2; continue; }
    if (c === '&') { endPart('&'); i++; continue; }
    if (c === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      // Heredoc: <<WORD, <<-WORD, <<'WORD' or <<"WORD"; its body is skipped at the next newline.
      endWord(); let j = i + 2; const strip = text[j] === '-'; if (strip) j++;
      while (isSpace(text[j])) j++;
      let delimiter = '';
      while (j < text.length && !isSpace(text[j]) && !'\n;&|<>()'.includes(text[j])) { if (text[j] !== "'" && text[j] !== '"' && text[j] !== '\\') delimiter += text[j]; j++; }
      if (delimiter) heredocs.push({ delimiter, strip });
      i = j; continue;
    }
    if (c === '<') { endWord(); redirect = 'read'; i += text[i + 1] === '<' ? 3 : 1; continue; }
    if (c === '>' || ((c === '1' || c === '2') && text[i + 1] === '>' && !inWord)) {
      endWord(); let j = c === '>' ? i : i + 1; j++;
      if (text[j] === '>') j++;
      // 2>&1 and >&2 duplicate a stream: nothing is written to a file.
      if (text[j] === '&') { j++; while (j < text.length && /[0-9-]/.test(text[j])) j++; i = j; continue; }
      if (text[j] === '|') j++;
      redirect = c === '2' ? 'read' : 'write';
      i = j; continue;
    }
    if ((c === '(' || c === ')' || c === '{' || c === '}') && !inWord) { endWord(); i++; continue; }
    inWord = true; word += c; i++;
  }
  endPart(null);
  // Whether the text ended inside a heredoc body (its command's words are complete).
  const inBody = heredocBody;
  const result = parts.filter(part => part.words.length || part.assignments.length || part.writes.length || part.subs.length)
    .map((part, index, all) => ({ ...part, next: index === all.length - 1 ? null : part.next }));
  return Object.assign(result, { endedInHeredoc: inBody });
}
