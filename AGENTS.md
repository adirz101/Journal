# Journal project instructions

The product and GitHub repository are named **Journal** (formerly Blackbox).
Repository: `https://github.com/adirz101/Journal`.
The local repository is `/Users/azechary/Documents/GitHub/Journal`.
For continuation in a new conversation, read `HANDOFF.md` first.

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
on a future stack decision; the current design proposes React inside Tauri.
If the collection becomes unavailable, report the missing source instead of
claiming to have applied it.

For this developer cockpit, prioritize keyboard access, clear focus, readable
dense information, and responsiveness under terminal/event load. Frequent
interactions and keyboard commands should not acquire decorative animations.
Respect reduced motion and gate hover effects by pointer capability. Use simple
CSS transitions where sufficient; add a motion library only for a concrete need.
Adapt platform guidance to both macOS and Windows rather than prescribing an
Apple-only visual style.

The current approved project phase is research and design. The UI-skills request
sets the workflow for UI work; it does not change the original instruction to
defer product implementation until separately requested.
