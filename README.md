# Bayes Studio

A visual studio for hierarchical Bayesian decision models. You lay out an influence diagram of
priors, conditionals, decisions and utilities; the engine propagates uncertainty by Monte Carlo,
so every node shows a distribution and every number carries its credible interval.

Live at **https://bayes.sels.tech**.

## What is here

| Path | Purpose |
| --- | --- |
| `packages/schema` | The JSON document format (zod), validation, the expression language, dimensional analysis, percentile fitting |
| `packages/engine` | Monte Carlo inference: seeded per-node sampling, summaries, decision analysis. Zero DOM dependencies. |
| `apps/studio` | The React canvas (Vite, React Flow, Zustand). Runs the engine in a Web Worker. |
| `examples/` | Bundled models, listed below. Every one is checked by the engine's test suite. |
| `PLAN.md` | The product plan, phases 0–7. The repo is at roughly Phase 1. |

## Examples

- **Drake Equation / Fermi Paradox** — seven order-of-magnitude priors multiplied out. The median
  number of civilisations is modest while the mean is enormous, and P(we are alone) is not small.
- **The Great Filter** — the same structure with a hidden cause: where the filter sits couples
  life, intelligence and lifetime, with probability tables for "is it still ahead of us".
- **P(doom): AI and the end of humanity** — a chain of credences from AI timelines through
  alignment failure, deployment and disempowerment, plus a misuse path. The answer is a
  distribution over p(doom).
- **Will the AI bubble pop before 2030?** — overbuild, rate shocks and a capability plateau feed
  a probability table; a mixture sizes the drawdown; an allocation decision with log utility
  shows what the uncertainty is worth to a portfolio.

## Reading a card

Every node card carries its defining equation, typeset with KaTeX, and the same equation read
aloud in plain English beneath it. Each input the equation uses gets its own colour, used for
the term in the equation, the word in the sentence, the port the incoming wire lands on, and the
arriving end of the wire itself, so following a connection tells you which variable it feeds.
Wires leave a card in its family colour. Numbers in an equation are editable in place: click a
coefficient, threshold, or distribution parameter, type, and press Enter; the model re-runs.
Variable names are not editable on the card because they are the connected inputs.

## Documents

A model is one JSON document. Semantics live in `nodes`; layout is a separate, optional map, so an
agent can author `nodes` alone and the studio lays them out. Edges are never written down: they
are derived from what each node references.

```jsonc
{
  "version": 1,
  "meta": { "title": "Drake equation", "seed": 42, "samples": 20000 },
  "nodes": [
    { "id": "R_star", "kind": "prior.dist", "unit": "stars/yr", "dist": { "dist": "loguniform", "min": 1, "max": 100 } },
    { "id": "L", "kind": "prior.dist", "unit": "yr", "dist": { "dist": "percentiles", "p10": 100, "p90": 1e10 } },
    { "id": "N", "kind": "formula", "expr": "R_star * L", "unit": "stars" },
    { "id": "alone", "kind": "comparator", "input": "N", "op": "<", "value": 1 }
  ]
}
```

Node kinds: `prior.dist`, `prior.sourced`, `prior.pooled`, `cond.cpt`, `cond.mixture`, `formula`,
`comparator`, `logic`, `decision`, `utility`, `output`, and `evidence` (schema only for now).

Distributions: `point`, `uniform`, `loguniform`, `normal`, `lognormal`, `beta`, `bernoulli`,
`triangular`, `pert`, `categorical`, and `percentiles` (P10/P90 with an optional P50; fitted as
lognormal, normal, or a metalog).

Formulas: arithmetic, `^`, comparisons, `and`/`or`/`not`, `if(c, a, b)`, `min`/`max`/`clamp`,
logs and roots, `logit`/`inv_logit`/`odds`/`prob`, and the distribution queries `cdf(node, x)`,
`prob_lt`, `prob_gt`, `quantile(node, p)`. Units are declared on priors and derived through
formulas; a `unit` on a formula is checked.

## Develop

```bash
pnpm install
pnpm test                                   # schema + engine (vitest)
pnpm typecheck
pnpm --filter @bayes-studio/studio dev      # http://localhost:5173
pnpm --filter @bayes-studio/studio build
pnpm --filter @bayes-studio/studio run deploy   # build + wrangler deploy → bayes.sels.tech
```

Node 22 and pnpm 11. The studio deploys as a Cloudflare Worker serving static assets; the config
is `apps/studio/wrangler.jsonc`.
