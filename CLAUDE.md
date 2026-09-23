# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bayes Studio: a visual editor for hierarchical Bayesian decision models (influence diagrams). A
document is a DAG of prior / conditional / decision / utility nodes; the engine propagates
uncertainty by Monte Carlo so every node ends up with an empirical distribution. `PLAN.md` is the
full product plan (phases 0–7); the repo is currently at roughly Phase 1 (schema + engine done,
studio canvas working, no server/connectors yet). When PLAN.md and code disagree, the code wins;
several schema features (`evidence`, `prior.sourced` bindings, `correlations`) are
schema-complete but not yet implemented in the engine or UI.

## Commands

pnpm workspace (`pnpm@11`, Node 22). Git `main` tracks `origin` = https://github.com/zalo/BayesianStudio
(public; `gh` is authenticated as that account). Toolchain as of
September 2026: Vite 8 (rolldown), vitest 5, zod 4, React 19.3, TypeScript 5.9, wrangler 4.

```bash
pnpm install
pnpm test                 # vitest in packages/schema and packages/engine (apps/studio has no tests)
pnpm typecheck            # tsc --noEmit in every workspace package
pnpm build                # only apps/studio has a build (vite build → apps/studio/dist)

# single package / single test
pnpm --filter @bayes-studio/engine test
pnpm --filter @bayes-studio/engine exec vitest run test/drake.test.ts
pnpm --filter @bayes-studio/engine exec vitest run -t "golden"

# dev server (port 5173)
pnpm --filter @bayes-studio/studio dev

# publish: vite build + wrangler deploy → https://bayes.sels.tech
pnpm --filter @bayes-studio/studio deploy
```

There is no linter or formatter configured. `apps/studio/wrangler.jsonc` is an assets-only
Cloudflare Worker (`bayes-studio`) serving `dist/` on the custom domain `bayes.sels.tech`; the
wrangler login on this machine (OAuth) owns that zone, and `account_id` is pinned in the config
because wrangler once resolved a different account and failed with an authentication error. `pnpm-workspace.yaml` allowlists the
`esbuild` and `workerd` postinstall scripts, which pnpm otherwise blocks.

## Architecture

Three workspace packages, strictly layered: `schema` ← `engine` ← `studio`. Packages are consumed
as raw TypeScript (`main`/`exports` point at `src/index.ts`, no build step); Vite and vitest
compile them on the fly. All relative imports use `.js` extensions (`verbatimModuleSyntax` +
bundler resolution), even though the files are `.ts`.

### `packages/schema` — document format, validation, expression language, units

- `dist.ts`: the 11 distribution primitives (zod discriminated union on `dist`). Discrete ones
  (`bernoulli`, `categorical`) sample to **label indexes**, not values; `distLabels()` tells you
  whether a dist is discrete. `percentiles` (P10/P90, optional P50) is fitted by
  `percentiles.ts`: lognormal/normal without a median, 3-term metalog with one, in log space when
  P10 > 0. The metalog is only valid with the median inside the middle two-thirds of the band
  (`P50_BAND`), and validation rejects it otherwise. Engine sampling and the studio's curve both
  go through `fitPercentiles`, so keep them in sync by changing only that module.
- `doc.ts`: `BayesDoc` and the 12 node kinds (discriminated on `kind`). Node ids must be
  identifier-shaped because they are referenced by name inside formula expressions.
- **Edges are never authored.** Graph structure is derived from node fields by
  `nodeDependencies()` in `validate.ts` (CPT `parents`, mixture `on`, formula/utility expression
  identifiers, etc.). `deriveEdges()`, `topologicalOrder()`, the engine and the canvas all go
  through it. If you add a node kind, `nodeDependencies` and `nodeLabels` are the two switch
  statements that must be extended first.
- `validateDoc()` is the single gate for every document mutation (store edits, worker input,
  bundled examples). It runs zod, then semantic checks (unique ids, reserved identifiers, refs,
  CPT/mixture label coverage, probability sums), then acyclicity, then dimensional analysis. It
  returns `{ ok, doc, issues, units }` rather than throwing.
- `expr.ts`: tiny shunting-yard parser → RPN. Parsing lives here (it is part of the format);
  evaluation lives in the engine. `FUNCTIONS`/`CONSTANTS`/keywords define the reserved identifier
  set. Besides arithmetic it has comparisons (`< <= > >= == !=`), the words `and`/`or`/`not`
  (Python precedence: `not a > b` is `not (a > b)`), `true`/`false`, log-odds helpers
  (`logit`, `inv_logit`, `odds`, `prob`), and **distribution queries** (`cdf`, `prob_lt`,
  `prob_gt`, `quantile`) whose first argument is consumed as a whole sample vector rather than
  per sample. Booleans are 0/1; truthiness is `> 0.5`. There is no `?:`; the parser points to
  `if()`. Adding a function means touching `FUNCTIONS`, the engine's `evalRpn`, and
  `units-derive.ts`.
- `unit.ts` + `units-derive.ts`: units are free-form exponent vectors (`"stars/yr"`, `"$"`),
  declared on priors/mixtures and *derived* through formulas in topological order. A `unit` on a
  formula is an assertion. Log/CRRA utility transforms make the result dimensionless.

### `packages/engine` — Monte Carlo inference, zero DOM deps

- `runInference(doc, opts)` validates, topo-sorts, and evaluates each node into a `Float64Array`
  of `n` samples. Discrete nodes hold label indexes. Result: per-node `Summary` (quantiles, CI80/95,
  histogram or categorical probs, `probTrue` for booleans), `outputs` (output id → target id), and
  `decisions` (per-alternative conditional means for every decision × utility/output).
- **Per-node blocking.** Invalid documents still throw `EngineError`, but a runtime failure
  (every sample non-finite, no matching CPT row, unsupported `evidence`) blocks only that node and
  its downstream cone: the node lands in `result.blocked` with a reason, dependents get
  `Blocked by upstream '<id>'`, and everything else evaluates. Blocked utilities simply drop out
  of the decision analysis. Don't reintroduce throw-on-first-error inside the node loop.
- Comparisons (`==` in formulas and `comparator` nodes, `<`/`>` too) use a relative tolerance of
  1e-9 so floating-point noise doesn't flip a boolean. Non-finite samples are excluded from
  statistics and counted in `summary.nonFinite`; the UI surfaces that as a warning rather than
  failing the node.
- Decisions are sampled **uniformly** and analysed by partitioning samples per alternative;
  downstream nodes branch on them via `cond.mixture`/`cond.cpt`/`if()`.
- Determinism: `rng.ts` is sfc32 seeded per node via `nodeRng(seed, nodeId)` (mixture cases get
  `${id}::case::${label}`), so adding/reordering nodes never changes another node's draws. Tests
  rely on this; don't share one RNG stream across nodes.
- `evidence` nodes are blocked with a Phase 5 pointer (likelihood weighting is not built).
- `test/drake.test.ts` is the golden test: it checks the Drake example against closed-form
  log-uniform results and unit derivation. Keep it passing when touching sampling or stats.

### `apps/studio` — Vite + React 19 + `@xyflow/react` + Zustand

- `store.ts` is the only state. The `BayesDoc` JSON is the source of truth; the canvas is a
  projection (`graph.ts::toFlow` derives React Flow nodes/edges, with a layered auto-layout for
  nodes missing a `layout` entry). Every mutation builds a new doc, runs `validateDoc`, and only
  commits if `ok`; mutators return an error string / issue list instead of throwing.
  `replaceNode(id, node)` is the generic same-id swap used by in-place equation edits.
- Inference runs in a Web Worker (`engine.worker.ts`). The store keeps a latest-wins queue: at most
  one run in flight, edits collapse into one queued run, and mid-drag `scrubNodeDist` runs a
  reduced-sample preview (`PREVIEW_SAMPLES`) while `setNodeDist` on release runs full quality.
  `setDoc` debounces 250 ms. Responses are matched by `requestId`, so stale results are dropped.
- `examples.ts` imports `examples/*.json` from the repo root (Vite `server.fs.allow` is widened
  for this) and validates them at module load; an invalid bundled example throws on startup. The
  same JSON files are test fixtures: `packages/engine/test/examples.test.ts` requires every file
  in `examples/` to validate with zero issues, run with nothing blocked, produce no non-finite
  samples, and carry a layout entry for every node. Adding an example means dropping a JSON file
  there and registering it in `examples.ts`. Four ship: Drake, the Great Filter, P(doom), and
  the AI bubble (the decision demo).
- `App.tsx` remounts the canvas per example key because different examples share node ids.
- `diagnostics.ts` merges validator warnings (`store.issues`), engine `blocked` reasons, and
  non-finite-sample warnings into one list; the idle inspector shows all of them and the focused
  inspector shows the selected node's. Blocked nodes render dashed with the reason in place of
  the readout (`StudioNode`).
- `DistEditor.tsx` is a direct-manipulation PDF editor (drag handles per family); `Sparkline`,
  `StudioNode`, `Inspector` render `Summary` data. A family's `log` flag may be a function of
  the distribution (percentiles plot on a log axis only when positive); the axis transform is
  frozen for the duration of a drag alongside the domain.
- **Equations.** `explain.ts::describeNode(node, byId)` gives every node kind a KaTeX source
  string, a plain-English reading (`Segment[]`: words and coloured variables), the inputs in
  reading order, and editable numeric *slots*. `components/Equation.tsx` renders it (KaTeX
  `renderToString` with `trust` limited to `\htmlClass`/`\htmlData`), shrinks the typeset
  line to fit the card by measuring the span (fonts load late, so a ResizeObserver re-measures),
  and turns a click on a `.eq-num` into an inline field whose commit calls the slot's `apply`
  and then `store.replaceNode`. Expression literals carry `src` positions from the parser
  (`RpnItem.pos/len` → `ExprAst.num.src`) so a slot splices the typed text into the source;
  distribution parameters, comparator thresholds, `k`, and CRRA γ are slots too. Variables are
  never editable there. Adding a function means extending `fnTex` and `fnWords` as well.
- **Ports and edges.** A card renders one target `Handle` per input (id = the input's node id)
  inside its legend row, so wires arrive next to the variable they feed; `graph.ts` sets
  `targetHandle` accordingly and `StudioNode` calls `useUpdateNodeInternals` when the input
  list changes. The source handle sits on the readout row. `StudioEdge` draws a gradient from
  the source's family accent to the target's variable colour (`userSpaceOnUse`, so it follows
  the actual endpoints).
- **Theme.** `theme.css` is token-driven: dark by default, light via `prefers-color-scheme` or an
  explicit `data-theme` on `<html>` (toggle in the top bar, persisted in `localStorage` under
  `bayes-theme`, applied pre-paint by an inline script in `index.html`). Colour means two
  things. Across the canvas: node family, via `graph.ts::familyAccent(kind)` on card rules,
  kind labels, the out-port, and the start of each edge. Inside a card: which input is which,
  via `--var-0…7` (`explain.ts::varClass/varColour`, assigned in reading order) on equation
  terms, sentence words, in-ports, legend rows, and the end of each edge. The palette is
  ordered so early indexes avoid the family hues. Fonts are Instrument Sans (words), DM Mono
  (numbers), and KaTeX's own faces for equations. Kind labels come from `FAMILY_LABEL` in
  sentence case; don't reintroduce uppercase mono eyebrows or middle-dot separated metadata.
- Cards are about 200–400 px tall (priors shortest; multi-case mixtures and many-input formulas tallest), so stored
  layouts space rows roughly 320 px apart and the auto-layout uses a 340 × 220 grid.

## Conventions worth knowing

- Never display a bare point estimate: node/inspector readouts pair the headline with a CI.
  Numbers go through `format.ts` (`fmt`, `fmtPct`).
- Probability sums are checked to `1e-6`; samplers tolerate tiny normalization error by scaling
  the CDF by its total rather than assuming 1.
- Booleans everywhere are `0/1` with labels `["false","true"]` (`BOOL_LABELS`); continuous values
  feeding logic/`if()` are treated as true when `> 0.5`.
- Store mutators that add nodes use `defaultNode()` to produce a valid starter anchored to the
  selected node; new node kinds need a `ID_PREFIX` entry and a `defaultNode` case.
