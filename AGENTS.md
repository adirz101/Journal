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

Fixture-based GitHub Actions CI (macOS, Linux and experimental Windows) was requested by
the user on 2 October 2026. The workflows are staged in `ci/github-actions/` until a token
with the `workflow` scope can push them (see the README there). CI never uses
real provider logins, provider requests or secrets; authenticated native trials and the
usefulness trial stay manual and local on the user's computer. Do not add nightly or
scheduled jobs. The release workflow builds unsigned artifacts only and publishes nothing.
Keep local test commands available. Repository documents and authored text use
English; Unicode fixture data may use escapes to retain multilingual coverage.
