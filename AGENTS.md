# Journal project instructions

The product and GitHub repository are named **Journal** (formerly Blackbox).
Repository: `https://github.com/adirz101/Journal`.
The local repository is `/Users/azechary/Documents/GitHub/Journal`.
For continuation, read `docs/TERMINAL-FIRST-SPEC.md` and
`docs/IMPLEMENTATION-STATUS.md`. The user deleted HANDOFF.md; do not recreate it.

## User-selected UI skills

The user requested that UI development use the skill collection at:
`/Users/azechary/Downloads/skills-main/skills/`.
These are local source files; they have not been installed globally.

Before designing, implementing, or reviewing UI, read
`emil-design-eng/SKILL.md` from that collection and apply its relevant guidance.
Read additional skills when the task calls for them:

- `pick-ui-library/SKILL.md`: selecting components or UI dependencies; inspect the existing stack first and choose only dependencies the feature needs.
- `animate/SKILL.md`: implementing purposeful motion.
- `review-animations/SKILL.md`: reviewing motion; read its referenced standards when needed.
- `improve-animations/SKILL.md` and `find-animation-opportunities/SKILL.md`: targeted motion improvements or an explicitly requested motion audit.
- `prototype/SKILL.md`: interactive prototypes.
- `apple-design/SKILL.md`: direct manipulation, interruptible gestures, and platform-sensitive interaction details.
- `ask-sonner/SKILL.md`: Sonner-specific work if Sonner is selected.
- `animation-vocabulary/SKILL.md`: discussing or specifying motion precisely.

Read each selected skill before applying it. Expo and Swift skills are conditional
on a future stack decision; the implemented app uses React inside Electron.
If the collection becomes unavailable, report the missing source instead of
claiming to have applied it.

For this developer cockpit, prioritize keyboard access, clear focus, readable
dense information, and responsiveness under terminal/event load. Frequent
interactions and keyboard commands should not acquire decorative animations.
Respect reduced motion and gate hover effects by pointer capability. Use simple
CSS transitions where sufficient; add a motion library only for a concrete need.
Adapt platform guidance to both macOS and Windows rather than prescribing an
Apple-only visual style.

The user separately approved the first terminal-only implementation and continuous
execution after investigation. See `docs/TERMINAL-FIRST-SPEC.md` and
`docs/IMPLEMENTATION-STATUS.md`. This does not authorize the full roadmap, chat or
public release. The user rejected all dev3 vendoring and code reuse: use original
Journal code or another appropriate source.

Use Node >=24. Run `npm test`, `npm run check` and `npm run build`; desktop changes
also need `npm run test:desktop` with Electron-native node-pty. Distinguish fixture
acceptance from authenticated native provider behavior. Preserve native settings,
permissions, exact-ID resume, reviewed evidence and immutable receipts.

Fixture-based GitHub Actions CI (macOS and experimental Windows) was requested by
the user on 2 October 2026 and is active in `.github/workflows/` since the user granted the
`workflow` token scope on 4 October 2026. Linux was dropped from CI on 5 October 2026 because
the product targets only macOS and Windows. CI never uses
real provider logins, provider requests or secrets; authenticated native trials and the
usefulness trial stay manual and local on the user's computer. Do not add nightly or
scheduled jobs. The release workflow (requested by the user) builds unsigned artifacts and, for a
pushed tag, creates only a draft pre-release that a maintainer publishes by hand.
Keep local test commands available. Repository documents and authored text use
English; Unicode fixture data may use escapes to retain multilingual coverage.

## Testing: provider isolation

Tests must never run a real provider CLI, use a real login, send a provider request or read a
secret. Every desktop spec, launch helper and committed script that starts Electron builds its
environment with `fixtureEnv({ root, bin, extra })` from `tests/support/env.ts`, the only file
that reads the real environment:

- PATH is the spec's fixture `bin` plus `root/tools/`, links to only the system tools the app and
  fixtures need (node, git, sh, bash, ps, env, sleep, curl). Never add a real system folder or
  Node's install folder (fnm, Homebrew and npm -g folders often hold a real `claude` or `codex`).
- HOME, USERPROFILE, LOCALAPPDATA, APPDATA, XDG_*_HOME, CODEX_HOME and CLAUDE_CONFIG_DIR point
  at a fixture home in `root`. No ANTHROPIC_*, OPENAI_*, CURSOR_*, CODEX_* or CLAUDE_* variable
  is passed. Add other variables only through `extra`, never by spreading `process.env`.
- `assertNoRealProviders` (called by `fixtureEnv`) throws if `claude`, `codex`, `agent` or
  `cursor-agent` resolves outside `bin` through PATH or a known install location under the home.
- `fixtureEnv` sets `JOURNAL_TEST_PROVIDER_DIR` to `root`. In headless runs Journal itself then
  refuses to probe or launch a provider CLI whose real path is outside it, and Cursor is looked
  for only after a spec sets `__journalAuthProbes` (true, or a list such as `['cursor']`).
- A spec that needs a provider version or sign-in state uses a fixture CLI for it, never the
  output of an installed CLI.

`tests/isolation.test.mjs` fails if a desktop spec, a `tests/support` helper or a launch script
reads `process.env` (other than one of Journal's own `JOURNAL_*` switches) or starts Electron
without `fixtureEnv`. Do not run a desktop spec or screenshot script whose environment keeps the
real PATH or HOME.
