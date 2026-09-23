# Bayesian Studio — Project Plan

A visual studio for building **Hierarchical Bayesian decision models**: a React Flow canvas of
prior, conditional, and decision nodes wired into probability graphs, with live data feeding the
priors, Monte Carlo uncertainty propagation, and a canonical JSON representation that AI agents
can read and author.

---

## 1. What the tool actually is (semantics first)

Before UI: the model class. Bayesian Studio documents are **influence diagrams** — directed
acyclic graphs mixing three families of nodes:

1. **Chance nodes** — uncertain quantities. Every chance node's value is a *distribution*, never a
   point. Discrete (event happens / doesn't; categorical) or continuous (salary, N in Drake).
2. **Decision nodes** — enumerated choices under the modeler's control ("stay at job" / "join
   startup"). Not random; the engine evaluates the graph *per alternative*.
3. **Value/utility nodes** — map outcomes to a scalar (dollars, utils, QALYs) so alternatives can
   be ranked by expected utility, with risk-aversion transforms available.

Deterministic function nodes (arithmetic, comparators, logic) are chance nodes whose distribution
is fully induced by their parents.

**Propagation is Monte Carlo.** Exact inference (variable elimination) only works for small
discrete networks; this tool mixes continuous distributions, arbitrary formulas, and empirical
data, so the engine samples: topological sort, draw N = 10k–100k joint samples, every node ends up
with an empirical distribution. This is what makes "propagate confidence along with the
prediction" automatic — the output *is* a distribution, and every displayed number carries its
credible interval. Evidence/conditioning ("given the Fed cuts rates…") uses likelihood weighting
so observed nodes reweight rather than reject samples.

**Confidence has two layers**, and the UI must keep them distinct:
- *Aleatory* spread — the distribution itself (a Beta(2,8) prior is genuinely uncertain).
- *Epistemic* quality — how much we trust the source (market liquidity, forecaster count, sample
  size, staleness). Stored as node metadata; surfaced as a 0–1 "confidence" badge, used to widen
  distributions (e.g., effective-sample-size discounting of Beta priors) and to weight opinion
  pooling when multiple sources feed one quantity.

---

## 2. Node taxonomy

### Priors (chance)
| Node | Purpose |
|---|---|
| **Distribution prior** | Manual: Bernoulli, Beta, Normal, LogNormal, Uniform, PERT, Triangular, Categorical, or quantile-specified ("5% chance below X, 95% below Y" → fitted metalog). |
| **Sourced prior** | Value(s) pulled from a connector (§4): Polymarket price → Bernoulli p; FRED series → point or fitted distribution over recent values; Metaculus community CDF → sampled directly; scraped number; PDF extraction; dataset column → empirical/fitted distribution. Carries TTL, staleness state, refresh history. |
| **Pooled prior** | Combines multiple parents estimating the *same* quantity: linear or logarithmic (log-odds) opinion pooling, weights from epistemic confidence, optional extremization factor. |

### Structure (chance)
| Node | Purpose |
|---|---|
| **Conditional (CPT)** | Discrete conditional probability table over discrete parents — the classic Bayes-net node. Table editor with row-normalization; rows can themselves be Beta-uncertain rather than fixed. |
| **Conditional (mixture)** | Continuous output switched by a discrete parent: "if startup succeeds → LogNormal(equity); else → 0". |
| **Formula** | Expression over parents (`N = R* · fp · ne · fl · fi · fc · L`), evaluated per-sample. Safe expression language (mathjs subset), no side effects. |
| **Comparator / Logic** | `>, <, between, ==` on continuous parents → Bernoulli/discrete; AND/OR/NOT/k-of-n over discrete parents. |
| **Evidence** | Pins an observed value onto a node (likelihood weighting); toggleable, so "what if we learn X" is one click. |

### Decision layer
| Node | Purpose |
|---|---|
| **Decision** | Enumerated alternatives; downstream nodes may branch on the active alternative. |
| **Utility** | Formula → scalar per sample; built-in transforms: linear, log, CRRA(γ) risk aversion; NPV with discount rate for multi-year cashflows. |
| **Payoff matrix (game)** | 2-player normal-form game; entries may be uncertain (distributions). Solves pure/mixed Nash equilibria, dominance, minimax/maximin regret — with equilibrium probabilities carrying the entries' uncertainty via MC over the matrix. |
| **Output / Report** | Marks a node as a headline result; feeds the results panel and export. |

Every node: title, notes/rationale (markdown), tags, source links — models double as arguments.

---

## 3. Inference & analysis engine

- Pure TypeScript package `@bayes-studio/engine`, **zero DOM deps**, runs in a Web Worker
  (structured-clone sample buffers as `Float64Array`; WASM is a later optimization, not needed at
  100k samples for graphs under ~200 nodes).
- Deterministic seeded RNG (PCG) → same doc + seed = same numbers; cache per-node samples keyed by
  the hash of the node's upstream subgraph so edits only recompute the dirty cone.
- **Analyses** (each a pure function over the sample matrix):
  - Summary stats + credible intervals (50/80/95%), P(event), full histogram/CDF per node.
  - **Sensitivity**: one-at-a-time tornado diagram (swing each input across its 10–90% range) and
    sample-based Sobol first-order indices for "which prior dominates my answer".
  - **Value of information**: EVPI per uncertain node, EVSI for a proposed observation — directly
    answers "is it worth waiting for more data before deciding".
  - **Decision evaluation**: expected utility per alternative, P(alternative A beats B), regret
    table, stochastic dominance check, certainty-equivalent under the chosen risk aversion.
  - **Bayesian updating**: conjugate updates where they apply (Beta-Binomial, Normal-Normal) when
    a dataset node feeds a prior; otherwise weighting handles it generically.
- Correlation between priors: v1 supports explicit dependence (wire A into B's formula/CPT);
  Gaussian-copula rank correlation between marginal priors is a fast-follow (schema reserves a
  `correlations` block so documents don't break).

---

## 4. Sourced priors: connectors, pickers, freshness

### Server side
A server component is required because browsers can't scrape cross-origin, hold API keys, or
refresh on a schedule. Responsibilities: `/proxy` (CORS), `/extract` (run a stored extraction
rule, return value + timestamp), `/history` (time series of every refresh), `/schedule` (TTL
refresher). Two deployment shapes: a local **Hono (Node) sidecar** with SQLite, or — preferred —
**Cloudflare Workers** (see §11), where Browser Rendering replaces the proxy/scrape machinery
entirely and Durable Object alarms replace the scheduler.

### Connectors (v1)
- **Polymarket** — Gamma API: search markets, pick outcome, price → probability; store liquidity/
  volume as epistemic confidence inputs. Conditional markets map beautifully onto CPT rows.
- **Metaculus** — API v2: question search; community prediction as p (binary) or the actual
  community CDF (continuous — sample it directly, best-in-class prior). Forecaster count → confidence.
- **FRED** — series search (API key in server env); latest value, or trailing-window distribution,
  or YoY transform.
- **Generic JSON API** — user pastes URL; response rendered as an interactive tree; clicking a
  value records a **JSONPath** extraction rule.
- **Web page scrape** — proxied page rendered in a sandboxed iframe with an injected picker
  (hover-highlight, click → robust CSS selector + number-parsing regex, à la browser-extension
  element pickers). Server re-runs selector on refresh; selector breakage → node enters an
  `error` freshness state, keeps last good value, flags the canvas.
- **PDF (upload or URL)** — pdf.js render; select a text span or table cell → extraction anchored
  by page + text-quad; table detection for grabbing a column.
- **Dataset (CSV/JSON upload)** — column picker; use as empirical distribution, fit a parametric
  family (with fit-quality shown), or Bayesian-update a designated prior node.

### Picker UX (shared shell)
One "Bind source" modal for all connectors: left = source browser (search/tree/page/PDF),
right = live preview of the extracted value *and the distribution it will induce*, plus the
mapping choice (point → degenerate? price → Bernoulli? window → fitted LogNormal?). The mapping
is part of the stored rule, so refreshes re-derive the distribution, not just the number.

### Freshness model
Every sourced node: `fetchedAt`, `ttl`, state ∈ `fresh | stale | refreshing | error`. Stale nodes
get an amber ring on canvas; document header shows "3 sources stale — refresh all". Auto-refresh
on document open + TTL expiry (server schedule); every refresh appended to history → sparkline of
the prior's drift over time on the node.

---

## 5. Canonical JSON format + AI authoring

The **JSON document is the source of truth**; the canvas is a view. One Zustand store holds the
doc; React Flow state and the Monaco text editor are two synchronized projections (text edits are
parsed → validated → patched into the store; canvas edits serialize back; conflict-free because
both write through the same store).

```jsonc
{
  "$schema": "https://bayes.studio/schema/v1.json",
  "version": 1,
  "meta": { "title": "Leave job for startup?", "author": "…", "seed": 42, "samples": 50000 },
  "nodes": [
    { "id": "p_success", "kind": "prior.sourced", "title": "Startup succeeds (exit > $0 for me)",
      "source": { "connector": "metaculus", "questionId": 12345, "mapping": "community_cdf",
                  "ttl": "24h" },
      "fallback": { "dist": "beta", "alpha": 2, "beta": 8 },
      "confidence": { "basis": "forecaster_count", "value": 0.7 },
      "notes": "Base rate for seed-stage startups reaching acquisition …" },
    { "id": "equity_value", "kind": "cond.mixture", "on": "p_success",
      "cases": { "true":  { "dist": "lognormal", "mu": 12.1, "sigma": 1.4 },
                 "false": { "dist": "point", "value": 0 } } },
    { "id": "decision", "kind": "decision", "alternatives": ["stay", "join"] },
    { "id": "utility", "kind": "utility", "expr": "crra(npv(cashflow, 0.04), 2.0)" }
  ],
  "edges": [ { "from": "p_success", "to": "equity_value" }, … ],
  "layout": { "p_success": { "x": 120, "y": 80 } },   // separate from semantics — AI may omit it
  "correlations": []
}
```

Design rules that make it AI-friendly:
- **Semantics and layout are separate top-level keys** — an LLM authors `nodes`/`edges` only and
  the app auto-layouts (dagre/ELK) anything missing coordinates.
- Published **JSON Schema** with rich `description`s (LLMs read schemas well) + strict validation
  with human-readable errors surfaced in the Monaco gutter.
- **`AUTHORING.md`**: the guide — node kind reference, the ten distribution primitives, the
  expression-language spec, 3 fully worked example documents, and a "checklist for probabilistic
  hygiene" (every chance node needs a distribution or parents; probabilities sum to 1; cite
  sources in `notes`). Shipped in-repo and served at `/authoring` in-app.
- In-app **"Copy for AI"** (doc + schema + guide excerpt in one clipboard payload) and **"Paste
  from AI"** (validate → diff preview → merge).
- A first-class **agent API** (HTTP + MCP, §12) so agents author and adjust graphs
  programmatically rather than only via clipboard.

---

## 6. Visualization & results

(Design per the `dataviz` skill system when building.)

- **On-node**: mini histogram/spark-CDF, headline stat (`P = 0.23` or `median $184k`), 80% CI as a
  subtle band, freshness ring, epistemic-confidence dot. Edge thickness ∝ sensitivity of the
  target to that parent (computed, not manual).
- **Inspector (right rail)**: full PDF/CDF plots with draggable percentile readouts, distribution
  parameter editors with live preview, source binding + refresh history sparkline.
- **Results drawer (bottom)**: per Output node — distribution, table of alternatives × expected
  utility with CI whiskers, tornado diagram, regret matrix, EVPI ranking, game-theory equilibrium
  view. All exportable (SVG/PNG/CSV).
- **What-if scrubbing**: drag a prior's slider → downstream nodes re-render live (cached-cone
  recompute makes this feel instant).

---

## 7. Frontend design & stack

**Stack**: Vite + React 19 + TypeScript, `@xyflow/react` v12, Zustand + Immer, Tailwind v4,
Monaco (lazy-loaded), visx for plots (composable, themeable, small), Web Worker engine, Hono on
**Cloudflare Workers** (Static Assets + Browser Rendering + Durable Object store + R2 + KV — §11).
Monorepo (pnpm workspaces): `packages/engine`, `packages/schema`, `packages/connectors`,
`apps/studio`, `apps/worker`.

**Aesthetic**: dark-first "scientific instrument" — near-black canvas with subtle dot grid, one
restrained accent per node family (priors teal, conditionals violet, decisions amber, utilities
green), tabular-figures mono for all numbers, glassy panels, uncertainty always drawn as gradient
bands rather than hard lines. Sleek means restrained: no gratuitous glow, motion only for state
changes (refresh pulse, sample-run progress along edges). Design pass via the `frontend-design`
skill; light theme supported from day one via tokens.

**Desktop layout**: left node palette (searchable, drag-to-add) · center canvas · right inspector
· bottom results drawer · toggleable JSON split-pane (canvas ⇄ text side-by-side, cursor↔node
highlight both directions). Command palette (⌘K) for everything.

**Mobile** (works, not primary): read-and-run first — pan/zoom canvas, tap node → inspector as
bottom sheet, results as swipeable cards, "refresh sources" and evidence toggles fully usable;
graph *editing* available but simplified (tap-tap to connect instead of drag). Breakpoint
collapses rails into sheets; React Flow's touch support handles the canvas.

---

## 8. Shipped examples (seed documents)

Shipped today (`examples/`):

1. **Drake Equation / Fermi paradox** — seven log-uniform priors → product formula →
   distribution over N. Shows *why* point estimates mislead: median N can be ≪ 1 while the mean is
   huge ("Dissolving the Fermi Paradox" reproduction). Tornado will show fl/fi dominate. Great
   first-run demo: no sources needed, pure structure. Also the engine's golden test.
2. **The Great Filter** — the Drake structure with a categorical prior on *where* the filter sits,
   mixtures switching the biological terms on it, and CPTs for "is the filter ahead of us" and
   "long future". Exercises categorical, mixture, and CPT nodes.
3. **P(doom)** — the Carlsmith-style chain: a percentile timeline collapsed to P(TAI by 2100) with
   `cdf()`, beta credences for alignment failure, deployment and disempowerment, a misuse path,
   and a comparator for "is the risk above 10%". Exercises percentiles, distribution queries, and
   probability-valued formulas.
4. **Will the AI bubble pop before 2030?** — overbuild (a comparator on a spending gap), a rate
   shock and a capability plateau feed a three-parent CPT; a mixture sizes the drawdown; a
   stay-versus-trim decision with log utility. The bundled decision demo.

Planned:

5. **Fed rate path → market outcome** — FRED (CPI, FFR) + Polymarket rate-cut markets + a CPT
   linking them; demonstrates sourced conditionals, staleness/refresh, and pooling Polymarket vs
   Metaculus on the same question.
6. **Metaculus long-shot** (e.g., an AGI-milestone question) — community CDF as a prior feeding a
   personal conditional model; demonstrates "start from the crowd, then add your structure".

Examples double as `AUTHORING.md` fixtures and as engine golden tests. They ship as **read-only
built-in projects** owned by a `system` account — users fork one to get their own editable copy
(§13 Forking), which is also the onboarding path.

---

## 9. Milestones

| Phase | Scope | Exit criterion |
|---|---|---|
| **0. Foundations** (schema + engine) | Monorepo; JSON Schema v1; engine: distributions, topo-sort MC, formula/comparator/CPT/mixture eval, summary stats; golden tests incl. Drake | Drake doc → correct N distribution from a CLI test, no UI |
| **1. Studio core** | React Flow canvas, palette, inspector, manual priors + structure nodes, worker integration, on-node viz, results drawer, undo/redo, IndexedDB persistence + file export | Build & run Drake entirely in the UI |
| **2. Text ⇄ canvas + agent API** | Monaco pane, two-way sync, validation gutter, auto-layout for layout-less docs, `AUTHORING.md`, Copy-for-AI / Paste-from-AI with diff preview; deploy Worker behind Cloudflare Access (Google login), D1 control plane + project DOs (WebSocket sync); agent HTTP API + MCP server with per-user tokens (§12–13) | Two Google accounts see separate project lists; Claude edits a live graph via MCP; docs survive reload |
| **3. Sources** | Polymarket + Metaculus + FRED + JSON-API connectors in the Worker, picker modal (JSONPath tree + market search), freshness/TTL via DO alarm + history sparkline | Rate-path example live-refreshing with no tab open |
| **4. Deep extraction** | Web-page element picker (Browser Rendering snapshot), scrape-refresh + self-healing `/json` fallback, PDF picker, dataset upload + distribution fitting (R2), pooled-prior node | Bind a prior to a number on an arbitrary JS-rendered page and a PDF table |
| **5. Decision & analysis suite** | Decision/utility/evidence nodes, tornado + Sobol, EVPI/EVSI, regret, payoff-matrix node + Nash solver, what-if scrubbing | Job-vs-startup example end-to-end with sensitivity + EVPI |
| **6. Assistant, keys & sharing** | Settings: encrypted per-user Anthropic keys + agent tokens; in-app assistant (tool runner over the semantic ops, streaming chat panel); view-only shares (email grant + public link, read-only WebSocket, run-mode share page); **forking** (examples, shared projects, share pages → private editable copy with provenance + R2 asset copies) | "Build me a Drake model" in chat → nodes appear live; a shared link opens read-only for a logged-out viewer; forking the Drake example yields an editable private copy |
| **7. Polish & mobile** | Design pass, mobile sheets/touch flow, command palette, onboarding tour riding the Drake example, perf (cone caching, 60fps scrub) | Sleek on a 27" monitor, usable on a phone |

Phases 3, 5, and 6 are independent after Phase 2 and can be parallelized.

## 10. Risks & mitigations

- **Scraper fragility** → last-good-value + explicit error state + manual fallback distribution
  required on every sourced node (schema-enforced).
- **MC perf on big graphs** → cone-based caching, adjustable sample count (10k interactive / 100k
  for reports), worker keeps buffers resident; WASM escape hatch.
- **Users misreading confidence** → never show a bare point estimate anywhere; intervals are part
  of the number component, not an option.
- **Two-way sync divergence** → single store, both views are projections; property-test round-trip
  (doc → canvas → doc is identity).
- **API terms/keys** → keys server-side only; per-connector rate limiting + response cache.

---

## 11. Deployment target: Cloudflare Workers

The whole system runs as **one Worker** (Hono routes + Static Assets serving the Vite build)
plus bindings — no Node sidecar. Mapping:

| Plan component | Cloudflare primitive |
|---|---|
| SPA | Workers **Static Assets** (single `wrangler deploy` ships app + API) |
| API connectors (Polymarket, Metaculus, FRED, generic JSON) | Plain `fetch` from the Worker; **KV** response cache; FRED key as a Worker secret |
| Web scraping + element picker | **Browser Rendering** (see below) |
| TTL refresh scheduler + canonical store | **Durable Object** with SQLite storage + alarms |
| Uploaded PDFs / datasets | **R2** |
| Agent API / MCP | Same Worker (Hono routes) + **Agents SDK** `McpAgent` |
| MC engine server-side (for agent `infer` calls) | The pure `engine` package runs in the Worker too — bounded sample counts to respect CPU limits; interactive runs stay in the browser Web Worker |

### Browser Rendering (this is an upgrade, not a port)
The original plan's proxied-iframe picker is fragile (CSP, X-Frame-Options, JS-rendered pages).
Browser Rendering replaces it outright:

- **Picker**: call `/snapshot` (fully rendered HTML with resources inlined) → serve the snapshot
  bytes from *our* origin into a sandboxed iframe with the picker script injected. No cross-origin
  issues, and selectors are recorded against the **rendered** DOM, so JS-heavy pages (most market
  sites) just work. Screenshot fallback for pathological pages.
- **Refresh**: REST `/scrape` with the stored CSS selectors for cheap re-extraction; Workers
  binding + Puppeteer when a page needs interaction (cookie banners, tabs); `/json`
  (schema-guided AI extraction) as a **self-healing fallback** when a selector breaks — propose a
  repaired selector, mark the node "needs confirmation" rather than erroring silently.
- **Limits to design around** (paid tier): 30 concurrent sessions, 180 req/min, 10-min session
  keep-alive. Always `browser.close()` in `finally`; reuse sessions (sessionId in KV — warm
  connect ~100–200ms vs ~1–2s cold); block image/font/stylesheet requests for speed; batch due
  refreshes into one browser session with multiple pages. Free tier (10 min browser time/day) is
  dev-only. Verify current numbers against docs at build time.

### Persistence: control plane + project DOs (multi-user)
- **D1 control plane**: `users` (Google identity → user id), `projects` (id, owner, title),
  `shares` (project id, grantee email or link token, role), `api_keys` (encrypted per-user
  Anthropic keys — §13), `agent_tokens` (per-user bearer tokens for §12).
- **One Durable Object per project** (`idFromName(projectId)`) owns that project's live state:
  documents, source bindings, refresh history, revision log in DO SQLite; WebSocket room for
  everyone viewing the project (owner edits, viewers watch, agent edits animate in).
- Every request resolves identity → checks the D1 grant → routes to the project DO. IndexedDB
  remains the offline/optimistic cache per client; version-counter guard + revision log for
  conflict recovery (a single writer per project keeps this simple in v1).

**Scheduling**: DOs allow one alarm each — each project DO keeps a min-heap of its sources'
next-due TTLs, sets its alarm to the earliest, and on wake refreshes everything due (API fetches
directly, scrapes via Browser Rendering), appends history, re-arms, and pushes updates over
WebSocket. Sources refresh even when no tab is open; per-user rate caps keep aggregate Browser
Rendering usage inside the 30-concurrent/180-rpm platform limits.

**Local dev**: `wrangler dev` + Miniflare for tests; Browser Rendering binding available in dev
(local or `--remote`).

---

## 12. Built-in agent API (first-class, not a fast-follow)

Two transports over one implementation, both hitting the same Durable Object store the UI uses.
Auth: **per-user agent tokens** (created/revoked in Settings, hashed in D1) scoping every call to
that user's projects and grants — never a global token.

- **HTTP** under `/api/agent/*`:
  - `GET /documents`, `GET /documents/:id`
  - `PUT /documents/:id` — full document, schema-validated
  - `PATCH /documents/:id` — **semantic ops**, not raw JSON Patch: `add_node`, `update_node`,
    `remove_node`, `connect`, `disconnect`, `set_evidence`, `bind_source`, `set_meta`. Ops apply
    atomically, validated against the schema **and** DAG acyclicity; response returns the updated
    doc plus validation warnings ("node X has no parents and no distribution").
  - `POST /documents/:id/infer` — run MC server-side, return summaries/analyses as JSON
  - `POST /documents/:id/refresh` — force-refresh sources
  - `POST /projects/:id/fork` — fork any readable project into the caller's account (§13)
  - `GET /schema`, `GET /node-kinds`, `GET /authoring-guide` — self-describing for agents
- **MCP server** (Agents SDK) exposing the same operations as tools, so Claude Code / claude.ai
  connect directly and author or adjust graphs conversationally.

Agent edits push over WebSocket to open tabs → the canvas animates the change with a toast and
an undo entry ("Agent added 3 nodes — review / undo"). Every agent write lands in the revision
log, so nothing an agent does is unrecoverable.

---

## 13. Accounts, per-user Claude keys, and sharing

### Google login
Two viable shapes; start with the first, keep the seam clean:

1. **Cloudflare Access with Google as IdP (recommended v1)** — zero auth code. Access sits in
   front of the Worker; the Worker verifies the `Cf-Access-Jwt-Assertion` JWT and reads the
   email. Free for small user counts, MFA/session policy for free, revocation in the Zero Trust
   dashboard. Public view-only links require an Access **bypass policy** on `/share/*` (the
   Worker still validates the link token itself).
2. **In-Worker Google OIDC** (openauth/arctic; sessions in KV) — the public-SaaS shape if this
   ever needs arbitrary signups without touching a Zero Trust dashboard.

Either way, the auth middleware resolves to a `userId` + email and nothing downstream knows
which one is in use — swapping later is contained to one file.

### Per-user Anthropic API keys (for the in-app agent)
- Users paste their key in Settings. Stored **encrypted at rest** (AES-GCM via WebCrypto, master
  key in a Worker secret), ciphertext in D1; write-only thereafter — the UI shows provider +
  last 4 characters only. Delete/replace anytime.
- Keys are used **server-side only**: the Worker runs the agent loop and never sends the key to
  the browser. Usage is metered per user (token counts logged per call) so people can see what
  their key is spending.

### In-app graph-authoring assistant
A chat panel ("Ask the studio") powered by the user's own key:

- Worker-side agentic loop using the **TypeScript SDK's tool runner**
  (`client.beta.messages.toolRunner` with `betaTool` definitions) — the SDK drives the
  request → execute → loop cycle; we supply the tools, which are exactly the §12 semantic ops
  (`add_node`, `connect`, `bind_source`, `infer`, …) plus `get_document` and the authoring guide.
- Model `claude-opus-5`, streaming responses (SSE to the panel), adaptive thinking (the default),
  with the JSON Schema + `AUTHORING.md` excerpt as the cached system prompt.
- Tool executions flow through the same project-DO write path as human edits: validated,
  revision-logged, pushed to the canvas live. "Build me a Drake equation model" becomes nodes
  appearing on screen with an undo entry.
- External agents (Claude Code via MCP, scripts via HTTP) authenticate with §12 agent tokens and
  spend *their own* keys; the stored key is only for the assistant the app itself runs.

### Sharing (view-only in v1)
- **Grant to a person**: owner enters an email → row in `shares` → grantee logs in with Google
  and sees the project in their list, read-only.
- **Public link**: unguessable token → `/share/:token` renders run-mode (pan/zoom, inspect
  distributions, toggle evidence *locally* in a client-side sandbox — nothing persists).
- Enforcement is **server-side**: viewer sessions get a read-only WebSocket and every mutating
  route checks role, so view-only can't be escalated from the client. Editor role is a schema
  field from day one (`owner | editor | viewer`) but editor UX ships later.

### Forking
Anything a user can *view*, they can **fork** — a "Fork" button on every example, shared
project, and public share page (for logged-in users; on a public link the button routes through
login first). Semantics:

- Fork = new project **owned by the forker**: copies the document(s), source bindings, and
  layout; starts a **fresh** revision log and refresh history (sources fetch anew under the
  forker's rate budget). Provenance is recorded (`forkedFrom: {projectId, revision}`) and shown
  as a badge linking back to the original — if the forker still has access to it.
- **Uploaded assets are copied, not referenced**: R2 objects (PDFs, datasets) backing sourced
  nodes are duplicated into the fork's namespace at fork time, so the original owner deleting
  their project never breaks a fork. Server-held secrets are never involved (connector keys are
  global server config; user Anthropic keys are per-account, not per-project).
- Forks are private to the forker by default, fully editable, and themselves shareable/forkable.
- Implementation is cheap: serialize from the source project DO at its current revision → write
  into a new project DO + D1 row + R2 copies. One RPC, no schema changes beyond `forkedFrom`.

**Examples are just built-in forkable projects**: the §8 seed documents ship as read-only
projects visible to every account (a `system` owner), so "try the Drake equation" is the same
gesture as forking a colleague's shared model.
