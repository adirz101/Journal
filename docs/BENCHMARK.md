# Usefulness benchmark (round 2 infrastructure)

Round 1 ([report](USEFULNESS-TRIAL.md)) was inconclusive because every condition passed every task. This harness makes the next round reproducible and decides it by criteria written down **before** running.

## Conditions
| | Condition | Knowledge delivery |
| --- | --- | --- |
| A | `none` | Nothing beyond the repository |
| B | `agents` | `AGENTS.md` committed at each knowledge point, branch status only on its branch; not updated afterwards |
| C | `memory` | Native Claude Code auto memory, seeded by "please remember" sessions at each knowledge point |
| D | `journal` | Reviewed Journal claims (overview and branch status drafted by the status helper), delivered as the real packet |

All conditions get identical knowledge text at the same points in history. Runs use headless `claude -p` with user settings and plugins excluded, a fixed Bash allowlist, edits accepted only inside the disposable checkout, a per-run budget, and isolated memory directories restored before each run. Codex is not automated here; run it manually if needed.

## Suite format
A suite is `benchmarks/<name>/suite.mjs` (see [TEMPLATE](../benchmarks/TEMPLATE.md)): a **generated** repository built by a timeline of commits, branches and knowledge points, or a **frozen checkout** (exact 40-character commit cloned from a path or URL). Tasks name a branch, a prompt, a hidden grader (ESM source run against the final checkout, printing one JSON line) and whether they are **differentiating** (knowledge should matter: non-derivable rules, stale knowledge, branch status, repeated mistakes). `freeze` records hashes of the suite files and of the evaluated suite (timeline files, knowledge, prompts and grader source, including imported fixtures); `setup` and `run` refuse to proceed if anything changed after freezing.

```sh
node scripts/benchmark.mjs benchmarks/<name> freeze
node scripts/benchmark.mjs benchmarks/<name> setup
node scripts/benchmark.mjs benchmarks/<name> run --reps 5
node scripts/benchmark.mjs benchmarks/<name> report     # report.md, summary.json in .cache/benchmarks/<name>/
```

Raw transcripts, prompts (including the exact Journal packet) and per-run grades are kept in `.cache/benchmarks/<name>/` (ignored). Reports include pass rates with 95% Wilson intervals per task and condition, mean tool calls, tokens, cost and context size, and operator-typed characters to set up knowledge.

## Decision criteria (defaults; a suite may tighten them)
- **No verdict** below 5 repetitions per task and condition, or with no differentiating tasks.
- **GO** when Journal's pass rate on differentiating tasks is at least **15 points** above the better of AGENTS.md and native memory, its overall pass rate is no more than 5 points below that baseline, and its setup effort is at most 1.25× the cheaper baseline.
- **ABANDON** (the knowledge thesis) when Journal is more than 10 points worse than no context overall.
- **MODIFY** otherwise.

Token or tool-call savings alone never produce GO.

## Status
- Harness, suite format, round-1 port (`benchmarks/ledger-round1`), offline tests: **done**.
- **BLOCKED — real round 2:** needs the repository owner to choose a real (or realistic, larger) repository, frozen commit and 8–15 tasks whose answers are not derivable from the code, and to accept the cost of about `4 conditions × tasks × 5 repetitions` paid Claude runs. Next action: create `benchmarks/<name>/suite.mjs` from the template, freeze it, then run `setup`, `run --reps 5` and `report`.
