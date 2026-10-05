import { Profiler, type ProfilerOnRenderCallback } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { storedAppearance } from './theme';
// Set the theme before the first render (and so before the first paint): App
// applies it again whenever it changes.
document.documentElement.dataset.theme = storedAppearance();
// A terminal measures its cell size when it opens. Load the bundled monospace
// font first (regular and semibold), so it measures JetBrains Mono rather than a
// fallback. The italic faces are loaded too so the first italic text does not flash
// in a fallback face; cell size comes from the upright face. Bounded: a font
// problem never keeps the window from rendering.
const fonts = Promise.all(['400 13px', '600 13px', 'italic 400 13px', 'italic 600 13px'].map(font => document.fonts.load(`${font} "JetBrains Mono"`)));
void Promise.race([fonts, new Promise(resolve => setTimeout(resolve, 1500))]).catch(() => {})
  .finally(() => createRoot(document.getElementById('root')!).render(<Profiler id="journal" onRender={recordCommit}><App /></Profiler>));

// Commit times for tests/desktop-performance.spec.ts. React calls this only in a profiling
// build (npm run build:profile), and it records only when a test created the array.
function recordCommit(...[, phase, actualDuration, , startTime, commitTime]: Parameters<ProfilerOnRenderCallback>) {
  const commits = (globalThis as { __journalCommits?: unknown[] }).__journalCommits;
  if (Array.isArray(commits) && commits.length < 5000) commits.push({ phase, actualDuration, startTime, commitTime });
}
