import { commandParts } from './shell.mjs';

// Fixed categories for the Story (src/core/story/story.mjs). Classification reads only the
// command text and tool names Journal recorded; it never guesses what the work was about.
export const CATEGORIES = Object.freeze(['commit', 'push', 'pr', 'ci', 'test', 'build', 'install', 'delete', 'create', 'edit', 'git', 'script', 'agent', 'web',
  'git-inspect', 'search', 'explore', 'noise']);
// Highest first: a command line with several simple commands is described by its most significant one.
const RANK = new Map(CATEGORIES.map((category, index) => [category, index]));
export const rank = category => RANK.get(category) ?? RANK.get('script');
// Milestones each get their own atom when one command line holds several (git commit && git push).
export const MILESTONES = new Set(['commit', 'push', 'pr', 'ci', 'test', 'build', 'install']);

const NOISE = new Set(['seq', 'cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'true', 'false', ':', 'sleep', 'export', 'unset', 'set', 'source', '.', 'clear', 'exit', 'wait',
  'read', 'alias', 'type', 'which', 'command', 'date', 'whoami', 'hash', 'shopt', 'trap', 'test', '[', '[[', 'let', 'local', 'declare', 'return', 'break', 'continue']);
// Noise that cannot fail, so a failed line is never blamed on it (anything else can fail:
// test, [, which, false, read, exit and an assignment that runs a command are not here).
const SAFE = new Set(['cd', 'pushd', 'popd', 'pwd', 'echo', 'printf', 'true', ':', 'sleep', 'export', 'unset', 'set', 'clear', 'date', 'alias', 'local', 'declare', 'shopt', 'seq']);
const CONTROL = new Set(['for', 'case', 'select', 'function']);
const CLOSERS = new Set(['done', 'fi', 'esac', '}', ')', 'in']);
// Words before the command: if/while/until conditions are commands like any other.
const LEADERS = new Set(['do', 'then', 'else', 'if', 'elif', 'while', 'until', 'time', 'nohup', 'exec', 'builtin', 'noglob']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
const EXPLORE = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'nl', 'wc', 'file', 'stat', 'ls', 'tree', 'du', 'df', 'od', 'xxd', 'hexdump', 'jq', 'yq', 'awk',
  'gawk', 'cut', 'sort', 'uniq', 'column', 'diff', 'cmp', 'realpath', 'readlink', 'basename', 'dirname', 'sed', 'md5', 'md5sum', 'shasum', 'sha256sum', 'strings', 'plutil',
  'ps', 'lsof', 'env', 'printenv', 'uname', 'tr', 'xargs', 'tee', 'comm', 'paste', 'fold', 'expand', 'base64', 'sw_vers', 'defaults', 'mdls', 'otool', 'nm', 'codesign', 'spctl']);
const SEARCH = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate', 'mdfind']);
const WEB = new Set(['curl', 'wget', 'http', 'https']);
const SCRIPT = new Set(['python', 'python3', 'node', 'ruby', 'perl', 'bash', 'sh', 'zsh', 'deno', 'php', 'osascript', 'swift']);
const GIT_INSPECT = new Set(['status', 'diff', 'log', 'show', 'branch', 'blame', 'rev-parse', 'remote', 'reflog', 'ls-files', 'describe', 'shortlog', 'grep', 'ls-remote', 'rev-list', 'cat-file', 'config']);
// Options that take a value, per command, so the value is not mistaken for a path.
const VALUE_OPTIONS = { head: ['-n', '-c'], tail: ['-n', '-c'], cut: ['-f', '-d', '-c', '-b'], sort: ['-k', '-t', '-o'], sed: ['-e', '-f'], awk: ['-F', '-f', '-v'],
  gawk: ['-F', '-f', '-v'], jq: ['--arg', '--argjson'], xargs: ['-I', '-n', '-L', '-P', '-d'], timeout: ['-s', '-k'], rm: [], mkdir: ['-m'], touch: ['-t', '-r', '-d'],
  cp: ['-t'], mv: ['-t'], tee: [], wc: [], cat: [], less: [], nl: ['-b', '-w', '-s'], file: ['-m', '-f'], stat: ['-f', '-c', '-t'], diff: ['-U', '-C', '-x'], od: ['-t', '-N', '-j'],
  xxd: ['-l', '-s', '-c'], git: ['-C', '-c'] };
const base = word => String(word ?? '').replace(/^.*\//, '');
const options = words => words.filter(w => w.startsWith('-'));
// Package-runner prefixes that only start another tool: the tool decides the category.
function unwrap(words, flags = {}) {
  let w = [...words];
  for (let guard = 0; guard < 8 && w.length; guard++) {
    const head = base(w[0]);
    // ! inverts the exit status: the command's own result is then unknown.
    if (w[0] === '!') { flags.negated = true; w = w.slice(1); continue; }
    if (LEADERS.has(head) || head === 'sudo' || head === 'caffeinate') { w = w.slice(1); continue; }
    // Assignments after do/then (do f=$(...)) are assignments too.
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w[0])) { w = w.slice(1); continue; }
    if (head === 'env') { w = w.slice(1); while (w.length && (w[0].startsWith('-') || w[0].includes('='))) w = w.slice(1); continue; }
    if (head === 'timeout' || head === 'gtimeout') { w = w.slice(1); while (w.length && (w[0].startsWith('-') || /^\d/.test(w[0]))) w = w.slice(1); continue; }
    if (head === 'npx' || head === 'bunx' || head === 'pnpx') { w = w.slice(1); while (w.length && w[0].startsWith('-')) w = w.slice(1); continue; }
    if ((head === 'pnpm' || head === 'yarn') && w[1] === 'dlx') { w = w.slice(2); continue; }
    if (head === 'uv' && w[1] === 'run') { w = w.slice(2); continue; }
    if (head === 'poetry' && w[1] === 'run') { w = w.slice(2); continue; }
    if (head === 'bundle' && w[1] === 'exec') { w = w.slice(2); continue; }
    if ((head === 'python' || head === 'python3') && w[1] === '-m' && w[2]) { w = w.slice(2); continue; }
    if (head === 'xargs') { w = w.slice(1); while (w.length && w[0].startsWith('-')) w = w.slice(VALUE_OPTIONS.xargs.includes(w[0]) ? 2 : 1); continue; }
    break;
  }
  return w;
}

// Non-option arguments, skipping the values of options that take one (for this command).
function operands(words) {
  const takes = VALUE_OPTIONS[base(words[0])] ?? []; const out = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { out.push(...words.slice(i + 1)); break; }
    if (w === '') continue;
    if (w.startsWith('-') && w !== '-') { if (takes.includes(w)) i++; continue; }
    out.push(w);
  }
  return out;
}
const looksLikePath = w => !!w && w !== '-' && !w.includes('$') && !w.includes('`') && !/^\d+(?:,\d+)?p?$/.test(w) && !/[*?{}]/.test(w) && /[A-Za-z0-9_.~/-]/.test(w) && w.length <= 300;
const paths = list => list.filter(looksLikePath);

const SCRIPT_KIND = name => /(?:^|:)(?:test|tests|spec|e2e)(?::|$)/.test(name) || /^test/.test(name) ? 'test'
  : /typecheck|type-check|tsc|^check$|:check$|^check:/.test(name) ? 'typecheck' : /lint|format:check|fmt:check/.test(name) ? 'lint'
  : /build|compile|dist|package|bundle/.test(name) ? 'build' : null;
const TEST_TOOLS = new Set(['jest', 'vitest', 'mocha', 'pytest', 'rspec', 'phpunit', 'ava', 'tap', 'karma', 'cypress', 'ctest', 'nextest']);
const LINT_TOOLS = new Set(['eslint', 'biome', 'ruff', 'flake8', 'pylint', 'stylelint', 'clippy', 'golangci-lint', 'rubocop', 'shellcheck', 'swiftlint', 'oxlint']);
const TYPE_TOOLS = new Set(['tsc', 'mypy', 'pyright', 'vue-tsc']);
const BUILD_TOOLS = new Set(['webpack', 'esbuild', 'rollup', 'electron-builder', 'xcodebuild', 'cmake', 'ninja', 'gcc', 'clang', 'javac', 'msbuild', 'parcel', 'turbo']);

// One simple command (words already unwrapped) → { category, kind?, paths?, ... }.
function classifyWords(words, writes) {
  if (!words.length) return { category: writes.length ? 'edit' : 'noise', paths: writes };
  const head = base(words[0]); const sub = words[1]; const rest = words.slice(1);
  if (CLOSERS.has(head) || CONTROL.has(head) || /^[A-Za-z_][\w-]*\(\)$/.test(words[0])) return { category: 'noise' };
  if (NOISE.has(head)) return writes.length ? { category: 'edit', paths: writes } : { category: 'noise' };
  if (head === 'git') {
    const g = words.findIndex((w, i) => i > 0 && !w.startsWith('-') && !(i > 1 && ['-C', '-c', '--git-dir', '--work-tree'].includes(words[i - 1])));
    const verb = g > 0 ? words[g] : ''; const args = g > 0 ? words.slice(g) : [];
    if (verb === 'commit') return { category: 'commit', amend: args.includes('--amend') };
    if (verb === 'push') { const targets = operands(args); return { category: 'push', remote: targets[0] ?? null, ref: targets[1] ?? null }; }
    if (verb === 'rm') return { category: 'delete', paths: paths(operands(args)) };
    if (verb === 'mv') return { category: 'edit', paths: paths(operands(args).slice(-1)) };
    if (verb === 'apply' || verb === 'am') return { category: 'edit', paths: [] };
    if (writes.length) return { category: 'edit', paths: paths(writes) };
    if (GIT_INSPECT.has(verb) || !verb) return { category: 'git-inspect' };
    return { category: 'git', verb };
  }
  if (head === 'gh') {
    const verb = `${sub ?? ''} ${words[2] ?? ''}`.trim();
    if (/^pr checks/.test(verb)) return { category: 'ci', tool: 'gh pr checks', semantics: 'pr-checks' };
    if (/^run (?:watch|view)/.test(verb)) return { category: 'ci', tool: `gh ${verb}`, semantics: rest.includes('--exit-status') ? 'exit-status' : null };
    if (/^(?:run|workflow) /.test(verb)) return { category: 'ci', tool: `gh ${verb}`, semantics: null };
    if (/^pr (?:create|merge|ready|close|reopen)/.test(verb)) return { category: 'pr', action: words[2] };
    if (/^(?:pr|issue|repo|release) (?:view|list|diff|status)/.test(verb)) return { category: 'git-inspect' };
    return { category: 'script', tool: 'gh' };
  }
  // Package managers and their scripts.
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(head)) {
    const verb = sub ?? '';
    if (verb === 'test' || verb === 't' || (head === 'bun' && verb === 'test')) return { category: 'test' };
    if (['install', 'i', 'ci', 'add', 'update', 'up', 'upgrade', 'uninstall', 'remove', 'rm', 'un'].includes(verb) || (head === 'yarn' && !verb)) return { category: 'install' };
    const script = verb === 'run' || verb === 'run-script' ? words[2] ?? '' : head !== 'npm' && !verb.startsWith('-') ? verb : '';
    const kind = SCRIPT_KIND(script);
    if (kind === 'test') return { category: 'test' };
    if (kind) return { category: 'build', kind };
    if (head === 'bun' && verb && /\.[cm]?[jt]sx?$/.test(verb)) return { category: 'script' };
    return { category: 'script', tool: `${head} ${verb}${script && script !== verb ? ` ${script}` : ''}`.trim() };
  }
  if (head === 'node' && rest.includes('--test')) return { category: 'test' };
  if (head === 'deno' && sub === 'test') return { category: 'test' };
  if (['go', 'cargo', 'dotnet', 'swift'].includes(head)) {
    if (sub === 'test' || (head === 'cargo' && sub === 'nextest')) return { category: 'test' };
    if (['build', 'check', 'vet', 'publish', 'pack'].includes(sub) && !(head === 'cargo' && sub === 'publish')) return { category: 'build', kind: sub === 'check' || sub === 'vet' ? 'typecheck' : 'build' };
    if (sub === 'clippy' || sub === 'fmt' && rest.includes('--check')) return { category: 'build', kind: 'lint' };
    if ((head === 'go' && (sub === 'get' || (sub === 'mod' && words[2] === 'tidy'))) || (head === 'cargo' && (sub === 'add' || sub === 'update')) || (head === 'dotnet' && sub === 'add')) return { category: 'install' };
    if (head === 'swift' && sub === 'package' && words[2] === 'resolve') return { category: 'install' };
    return { category: 'script', tool: `${head} ${sub ?? ''}`.trim() };
  }
  if (['mvn', 'gradle', 'gradlew', './gradlew'].includes(head) || head === 'mvnw') {
    if (rest.some(w => w === 'test' || w === 'verify')) return { category: 'test' };
    return { category: 'build', kind: 'build' };
  }
  if (head === 'make' || head === 'gmake') return rest.some(w => /^(?:test|check|tests)$/.test(w)) ? { category: 'test' } : rest.some(w => /^lint$/.test(w)) ? { category: 'build', kind: 'lint' } : { category: 'build', kind: 'build' };
  if (head === 'playwright' && sub === 'test') return { category: 'test' };
  if (TEST_TOOLS.has(head)) return { category: 'test' };
  if (head === 'xcodebuild') return rest.includes('test') ? { category: 'test' } : { category: 'build', kind: 'build' };
  if (TYPE_TOOLS.has(head)) return { category: 'build', kind: 'typecheck' };
  if (LINT_TOOLS.has(head) || (head === 'prettier' && rest.includes('--check'))) return { category: 'build', kind: 'lint' };
  if (BUILD_TOOLS.has(head) || ((head === 'vite' || head === 'next' || head === 'astro' || head === 'nuxt') && sub === 'build')) return { category: 'build', kind: 'build' };
  if (['pip', 'pip3', 'uv', 'poetry', 'pipenv', 'gem', 'bundle', 'brew', 'composer', 'pod', 'conda', 'apt', 'apt-get'].includes(head)) {
    if (['install', 'add', 'update', 'upgrade', 'uninstall', 'remove', 'sync', 'lock', 'require'].includes(sub ?? '') || (head === 'uv' && sub === 'pip') || (head === 'bundle' && !sub)) return { category: 'install' };
    return { category: 'script', tool: head };
  }
  // Files.
  if (head === 'rm' || head === 'rmdir' || head === 'unlink' || head === 'trash') return { category: 'delete', paths: paths(operands(words)) };
  if (head === 'mkdir' || head === 'touch') return { category: 'create', paths: paths(operands(words)) };
  if (head === 'cp' || head === 'mv' || head === 'ln' || head === 'rsync' || head === 'install' || head === 'ditto') return { category: 'edit', paths: paths(operands(words).slice(-1)) };
  if ((head === 'sed' || head === 'perl') && options(words).some(o => /^-[a-zA-Z]*i/.test(o) || o.startsWith('--in-place'))) {
    const list = operands(words); const scripted = words.some(w => w === '-e' || w === '-f');
    return { category: 'edit', paths: paths(head === 'sed' && !scripted ? list.slice(1) : head === 'perl' ? list.slice(1) : list) };
  }
  if (head === 'tee') return { category: 'edit', paths: paths(operands(words)) };
  if (head === 'patch' || head === 'truncate' || head === 'chmod' || head === 'chown') return { category: head === 'patch' ? 'edit' : 'script', paths: [] };
  if (writes.length) return { category: 'edit', paths: paths(writes) };
  if (head === 'find' && rest.includes('-delete')) return { category: 'delete', paths: [] };
  if (SEARCH.has(head)) return { category: 'search' };
  if (EXPLORE.has(head)) {
    const list = operands(words);
    // sed and awk take a script first; the files follow it.
    const scripted = (head === 'sed' || head === 'awk' || head === 'gawk') && words.some(w => w === '-e' || w === '-f');
    const files = scripted ? list : head === 'sed' || head === 'awk' || head === 'gawk' || head === 'jq' || head === 'yq' ? list.slice(1) : head === 'ls' || head === 'tree' || head === 'du' || head === 'ps' || head === 'env' ? [] : list;
    return { category: 'explore', paths: paths(files) };
  }
  if (WEB.has(head)) return { category: 'web' };
  if (SCRIPT.has(head)) return { category: 'script', tool: head };
  return { category: 'script', tool: TOOL_NAME.test(head) ? head : null };
}
// A label only for a well-formed command name (not $VAR, a fragment or a path with spaces).
const TOOL_NAME = /^[A-Za-z][\w.+-]{1,30}$/;

// A recorded command line → its simple commands, each classified, with the connector after it.
// Journal records at most this many characters of a command (src/core/terminal.mjs).
export const RECORDED_LIMIT = 300;
export function classifyCommand(command) {
  let parts = commandParts(command);
  // A command cut at the recording limit ends in a fragment: its last part is not read.
  const truncated = typeof command === 'string' && command.length >= RECORDED_LIMIT;
  // (A cut inside a heredoc body leaves its command's words whole.)
  if (truncated && parts.length > 1 && !parts.endedInHeredoc) parts = parts.slice(0, -1);
  const out = [];
  for (const part of parts) {
    const flags = {}; const words = unwrap(part.words, flags);
    // sh -c '...' and bash -lc '...' run a script: classify the script.
    if (SHELLS.has(base(words[0])) && /^-[a-z]*c[a-z]*$/.test(words[1] ?? '') && typeof words[2] === 'string') {
      const inner = classifyCommand(words[2]);
      inner.forEach((entry, index) => out.push({ ...entry, next: index === inner.length - 1 ? part.next : entry.next, ...(flags.negated ? { negated: true } : {}), ...(truncated ? { truncated: true } : {}) }));
      continue;
    }
    const info = classifyWords(words, part.writes);
    // Whether this part could have made the line fail: only noise that cannot fail, and plain assignments, cannot.
    const safe = info.category === 'noise' && (words.length ? SAFE.has(base(words[0])) || CLOSERS.has(base(words[0])) || CONTROL.has(base(words[0])) || /\(\)$/.test(words[0]) : !part.subs.length);
    out.push({ ...info, next: part.next, words: words.slice(0, 12), safe, ...(flags.negated ? { negated: true } : {}), ...(truncated ? { truncated: true } : {}) });
    // Command substitutions run commands too: $(grep -rl x) is a search.
    for (const sub of part.subs) for (const inner of classifyCommand(sub)) if (inner.category !== 'noise' && !(inner.category === 'explore' && !inner.paths?.length)) out.push({ ...inner, next: ';', inner: true });
  }
  return out;
}

// The first line of a commit message given with -m/--message (also -am, and Claude's
// "$(cat <<'EOF' ... EOF)" form), or null.
export function commitMessage(command) {
  const text = String(command ?? '');
  // -m "$(cat <<'EOF' ... EOF)" and -F - <<'EOF' ... EOF: the message is the heredoc's first line.
  const heredoc = /git\s+(?:-[Cc]\s+\S+\s+)*commit\b[^\n]*?(?:(?:-m|--message)\s*=?\s*"?\$\(cat\s+|(?:-F|--file)[\s=]+-\s+[^\n]*?)<<-?\s*'?"?(\w+)'?"?[^\n]*\n([^\n]*)/.exec(text);
  if (heredoc && heredoc[2].trim() && heredoc[2].trim() !== heredoc[1]) return heredoc[2].trim().slice(0, 100);
  for (const part of commandParts(text)) {
    const words = unwrap(part.words);
    if (base(words[0]) !== 'git' || !words.includes('commit')) continue;
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if ((w === '-m' || w === '--message' || /^-[a-zA-Z]*m$/.test(w)) && words[i + 1] !== undefined) return firstLine(words[i + 1]);
      if (w.startsWith('--message=')) return firstLine(w.slice(10));
      if (/^-m.+/.test(w)) return firstLine(w.slice(2));
    }
  }
  return null;
}
const firstLine = value => { const line = String(value).split('\n').map(l => l.trim()).find(Boolean) ?? ''; return line && !line.startsWith('$(') ? line.slice(0, 100) : null; };
