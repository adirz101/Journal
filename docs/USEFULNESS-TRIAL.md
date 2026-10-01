# Usefulness trial, round 1

1–2 October 2026. A manual, local comparison of the same project knowledge delivered four ways. It was run on the user's Mac with the installed Claude Code CLI. Harness: `scripts/usefulness-trial.mjs`; fixtures, knowledge, tasks and graders: `fixtures/usefulness/`. These were committed before any trial run (`c555bd0`). Raw transcripts and results stay in ignored `.cache/usefulness/`.

**Result: inconclusive by design ceiling.** All four conditions passed all 48 graded runs, including the condition with no injected context. On this small synthetic repository, the model rediscovered every rule from the code or from common practice. The trial does not show that Journal reduces mistakes compared with no context, AGENTS.md or native memory. It shows modest efficiency differences and one avoided mistake: editing a generated file.

## Setup

- **Repository:** a synthetic `ledger` Node project with 3 branches. On `main`, a storage refactor lands after knowledge was recorded. `feature/refunds` is half finished. `experiment/sqlite` holds a decision that applies only on that branch.
- **Knowledge:** identical text across conditions: a repo overview, a money decision, a document-number lesson, a vendor constraint, a generated-file lesson, a storage convention that the refactor makes stale, a refunds branch update and the SQLite branch decision.
  - **none:** no AGENTS.md, no memory, no packet.
  - **agents:** `AGENTS.md` committed on `main`, with the branch status and SQLite decision committed only on their branches. Claude Code loaded it through its built-in AGENTS.md support. It was not updated after the refactor.
  - **memory:** native Claude auto memory, seeded by 3 "please remember this" sessions on the matching branches. Claude stored 8 memory files and kept the branch qualifiers; the stale storage rule went into its overview file. The memory was not updated after the refactor, and each run restored the seeded snapshot.
  - **journal:** reviewed Journal claims. The overview and branch update were drafted by the new status helper. The storage claim used a file excerpt, so Journal marked it stale after the refactor and excluded it. The SQLite decision was branch scoped. Each run's prompt is the real Journal packet followed by the task, the same composition as the desktop launcher.
- **Model:** Claude Code 2.1.286, `--model sonnet --effort medium`, user/global settings and plugins excluded (`--setting-sources project,local`), edits accepted inside the fixture and a fixed Bash allowlist. Anything else was denied, never prompted. Budget $3 per run; 2 repetitions per task; runs were independent.
- **Graders:** hidden deterministic graders. Before any run, each was checked to pass a reference solution and fail the targeted mistake.

| Task | Designed to expose | none | agents | memory | journal |
| --- | --- | --- | --- | --- | --- |
| discount | float money / skipped helpers | 2/2 | 2/2 | 2/2 | 2/2 |
| credit-notes | clock-derived document numbers | 2/2 | 2/2 | 2/2 | 2/2 |
| payout-descriptor | unknown vendor limit (22 chars, ASCII) | 2/2 | 2/2 | 2/2 | 2/2 |
| tax-region | editing the generated file | 2/2 | 2/2 | 2/2 | 2/2 |
| continue-refunds | missing branch status ("continue") | 2/2 | 2/2 | 2/2 | 2/2 |
| customer-notes | stale storage rule; other-branch decision | 2/2 | 2/2 | 2/2 | 2/2 |

| Mean per run | none | agents | memory | journal |
| --- | --- | --- | --- | --- |
| Tool calls | 5.8 | 5.2 | 5.8 | 4.6 |
| Tool calls before first edit | 2.0 | 1.4 | 2.4 | 1.3 |
| Input tokens (incl. cache) | 97k | 91k | 99k | 80k |
| Cost reported by CLI (USD) | 0.070 | 0.068 | 0.071 | 0.073 |
| Wall time (s) | 19 | 18 | 19 | 18 |
| Injected knowledge (bytes) | 0 | 1,597 | 803 index + files read on demand | 1,855 |
| Runs that edited the generated file | 2 | 0 | 0 | 0 |

## Observations

- **Code made the rules derivable.** The repository already used `money.mjs`, `sequence.mjs` and `repo.mjs` consistently. The deprecated storage module said so in a comment. With no context, the model followed the current code each time.
- **The "non-derivable" vendor constraint was not.** With no context, the model assumed the common 22-character, ASCII card statement-descriptor limit and wrote a comment saying it was an assumption. This task was frozen before the run and was not changed afterward.
- **Repeated mistake avoided:** the generated-file trap was the only task where knowledge changed behavior. Both no-context runs edited `src/generated/taxRates.mjs` first, then found that `npm test` regenerated it and moved the change to the CSV. All knowledge conditions edited the CSV directly. The final outcome was the same; the no-context runs paid one detour.
- **Stale and branch-scoped knowledge did no harm here.** The stale storage rule reached the agents and memory runs, but every run read the current code and used `repo.mjs`. The SQLite decision never leaked: native memory had recorded it as branch specific, and the code on `main` contradicted it. Journal's staleness exclusion and branch scope were correct, but they were not needed to pass.
- **Branch status did not shorten "continue" work.** On `continue-refunds`, Journal used 7–9 tool calls compared with 4–5 for AGENTS.md, despite equivalent status text. With no context, the model found the next step from the code, tests and Git history.
- **Efficiency:** Journal had the lowest mean tool calls and input tokens. With 12 runs per condition and per-task variance as large as the gaps, this is not a reliable difference.

## Maintenance overhead (operator-typed characters to set up)

| Condition | Setup | After the refactor |
| --- | --- | --- |
| agents | 2,175 characters typed into AGENTS.md across three branches | No signal that the storage rule went stale |
| memory | 2,536 characters of "remember this" prompts; Claude chose the file layout | No signal |
| journal | 1,837 characters across 8 reviewed claims. The status helper generated the commit summary for the branch update; the operator typed only `Current work` and `Next` (288 characters vs 532 for AGENTS.md) | One stale flag on the storage claim, which was excluded automatically |

Journal required roughly the same up-front writing, plus explicit approval clicks. Its maintenance advantages are visible staleness flags and automatically summarized progress. Neither was needed to pass this trial.

## Limits

- One small, synthetic, internally consistent repository; one provider (Claude Sonnet); 2 repetitions; one operator who wrote both the tasks and the knowledge. Codex was not run.
- Graders score the final state. Hidden reasoning and native context were not inspected. Bash allowlist denials (mostly heredoc file writes that were retried with the Write tool) occurred at similar rates in every condition.
- The trial cannot distinguish Journal from AGENTS.md when the knowledge is fresh, because the delivered text was equivalent.

## Decision

**MODIFY, not GO** for the knowledge thesis as tested: no reduction in mistakes was demonstrated. The direction is not disproved either; this repository was too easy. A decisive round 2 needs:

- a larger or real repository where the code does not reveal the rule: conventions contradicted by legacy code, external systems or incidents absent from the tree;
- long-running branches whose status cannot be recovered from Git alone;
- stale knowledge that the code does not contradict locally;
- tasks frozen before running, more repetitions, and Codex as a second provider.

Product work that does not depend on the knowledge thesis, such as a durable multi-session terminal workspace, remains justified by workflow value and is the next milestone.
