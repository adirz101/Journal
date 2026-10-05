import { CRASH_COLORS } from './window-colors.mjs';

// Phase 9: what the window shows after its renderer process is gone (a crash, an out-of-memory
// kill). Without it the window stays blank until Journal restarts. Sessions are unaffected: they
// run in the runtime, which keeps buffering their output until a window attaches again.
// The page is static (no script; its CSP allows inline styles only): one sentence and Reload,
// focused on load. Reload submits a form to RELOAD_URL, a reserved address that main's
// will-navigate handler intercepts (and always cancels) to load the app again.

// Shown text; tests/copy.test.mjs checks it with the renderer's voice rules.
export const CRASH_COPY = {
  title: 'Something went wrong',
  body: 'Journal’s window stopped unexpectedly; running sessions were not affected.',
  reload: 'Reload',
};

// .invalid never resolves (RFC 2606); the navigation is cancelled before any request.
export const RELOAD_URL = 'https://journal.invalid/reload';
export const isReloadRequest = url => typeof url === 'string' && url.split('?')[0] === RELOAD_URL;

const FONT = '-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
const escape = text => text.replace(/[&<>"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]);

export function crashPageHtml(theme = 'dark') {
  const c = CRASH_COLORS[theme === 'light' ? 'light' : 'dark'];
  return `<!doctype html><html lang="en" data-theme="${theme === 'light' ? 'light' : 'dark'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Journal</title><style>
:root{color-scheme:${theme === 'light' ? 'light' : 'dark'}}
html,body{height:100%}
body{margin:0;background:${c.bg};color:${c.text};font:13px/1.5 ${FONT};display:flex;align-items:center;justify-content:center}
main{max-width:420px;padding:24px;display:flex;flex-direction:column;align-items:flex-start;gap:10px}
h1{margin:0;font-size:16px;font-weight:600}
p{margin:0 0 6px;color:${c.body}}
form{margin:0}
button{font:inherit;font-weight:600;padding:8px 14px;border-radius:6px;border:1px solid ${c.button};background:${c.button};color:${c.onButton};cursor:pointer}
button:focus-visible{outline:2px solid ${c.ring};outline-offset:2px}
@media (forced-colors:active){button{border-color:ButtonText}button:focus-visible{outline-color:Highlight}}
</style></head><body><main>
<h1>${escape(CRASH_COPY.title)}</h1>
<p>${escape(CRASH_COPY.body)}</p>
<form method="get" action="${RELOAD_URL}"><button type="submit" autofocus>${escape(CRASH_COPY.reload)}</button></form>
</main></body></html>`;
}

export const crashPageUrl = theme => `data:text/html;charset=utf-8,${encodeURIComponent(crashPageHtml(theme))}`;
