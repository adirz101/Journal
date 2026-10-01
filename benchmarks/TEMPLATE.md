# Benchmark suite template

Copy this folder layout to `benchmarks/<name>/` and write `suite.mjs`:

```js
export default {
  name: 'my-suite',
  description: 'What the suite measures',
  // Either a generated repository built by the timeline, or a frozen checkout:
  repository: { kind: 'frozen', source: '/path/or/url/to/repo.git', commit: '<40-char sha>', branch: 'main' },
  overviewPurpose: 'Purpose: …',           // overview text for AGENTS.md and memory conditions
  timeline: [                              // applied in order for every condition
    { commit: { message: '…', files: { 'path': 'content' }, delete: ['old/path'] } },
    { branch: 'feature/x', from: 'main' }, { switch: 'main' },
    { knowledge: 'label' },                // record knowledge items with at: 'label' here
  ],
  knowledge: [
    { kind: 'overview', at: 'label', constraints: '…' },
    { kind: 'claim', at: 'label', category: 'decision', scope: 'checkout', statement: '…', source: { kind: 'user', note: '…' } },
    { kind: 'status', at: 'label', current: '…', next: '…' },   // branch update on the branch active at that label
  ],
  tasks: [{ id: 'kebab-id', branch: 'main', kind: 'stale knowledge', differentiating: true, prompt: '…', grader: '<ESM source printing {"pass":bool,"trap":string|null}>' }],
  criteria: { minReps: 5, goDelta: 0.15 },  // optional overrides of DEFAULT_CRITERIA
};
```

Rules: freeze before running (`node scripts/benchmark.mjs benchmarks/<name> freeze`); graders read the final checkout (argv[2]) and print one JSON line; mark only tasks where knowledge should matter as `differentiating`. A real-repository suite needs the repository owner to choose the repository and tasks; none is included.
