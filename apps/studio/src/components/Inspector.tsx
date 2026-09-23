import { useMemo } from "react";
import { useStudio } from "../store.js";
import { fmt, fmtPct } from "../format.js";
import { FAMILY_LABEL, familyAccent } from "../graph.js";
import { collectDiagnostics } from "../diagnostics.js";
import { NodeEditor } from "./NodeEditor.js";
import { DistEditor } from "./DistEditor.js";
import { DiagnosticsList } from "./Diagnostics.js";
import { Equation } from "./Equation.js";
import { describeNode, humanize, varClass, varColour } from "../explain.js";
import type { DecisionAnalysis } from "@bayes-studio/engine";

function DecisionPanel({ analysis }: { analysis: DecisionAnalysis }) {
  return (
    <div className="decision-card">
      <div className="dc-title">{analysis.title ?? analysis.decisionId}</div>
      {analysis.metrics.map((m) => (
        <div className="dc-metric" key={m.nodeId}>
          <div className="dc-metric-title">
            {m.title ?? m.nodeId}
            {m.unit && <span className="dc-unit">{m.unit}</span>}
            <span className={`dc-kind ${m.kind}`}>{m.kind === "utility" ? "utility" : "expected value"}</span>
          </div>
          {m.perAlternative.map((a) => (
            <div className={`dc-row${a.label === m.best ? " best" : ""}`} key={a.label}>
              <span className="dc-alt">
                {a.label === m.best ? "★ " : ""}
                {a.label}
              </span>
              <span className="dc-mean">{fmt(a.mean)}</span>
              <span className="dc-ci">
                {fmt(a.ci80[0])} to {fmt(a.ci80[1])}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Inspector() {
  const doc = useStudio((s) => s.doc);
  const results = useStudio((s) => s.results);
  const issues = useStudio((s) => s.issues);
  const status = useStudio((s) => s.status);
  const selectedId = useStudio((s) => s.selectedId);

  const select = useStudio((s) => s.select);
  const setNodeDist = useStudio((s) => s.setNodeDist);
  const scrubNodeDist = useStudio((s) => s.scrubNodeDist);
  const replaceNode = useStudio((s) => s.replaceNode);
  const node = doc.nodes.find((n) => n.id === selectedId);
  const desc = useMemo(() => {
    if (!node) return null;
    const byId = new Map(doc.nodes.map((n) => [n.id, n]));
    return describeNode(node, byId);
  }, [node, doc.nodes]);

  const diagnostics = useMemo(() => collectDiagnostics(issues, results, status), [issues, results, status]);

  if (!node) {
    return (
      <aside className="inspector idle">
        <h2>{doc.meta.title}</h2>
        <div className="sub">
          <span>{doc.nodes.length} nodes</span>
          <span>seed {doc.meta.seed ?? 42}</span>
          <span>{(doc.meta.samples ?? 10000).toLocaleString()} samples</span>
        </div>
        {doc.meta.description && <p className="notes">{doc.meta.description}</p>}
        <DiagnosticsList title="Diagnostics" items={diagnostics} />
        {results && results.decisions.length > 0 && (
          <div>
            <h3>Decision analysis</h3>
            {results.decisions.map((d) => (
              <DecisionPanel analysis={d} key={d.decisionId} />
            ))}
          </div>
        )}
        {results && Object.keys(results.outputs).length > 0 && (
          <div className="outputs">
            <h3>Headline results</h3>
            {Object.entries(results.outputs).map(([outId, targetId]) => {
              const r = results.nodes[targetId];
              if (!r) return null;
              const out = doc.nodes.find((n) => n.id === outId);
              const v =
                r.summary.probTrue !== undefined
                  ? fmtPct(r.summary.probTrue)
                  : `${fmt(r.summary.quantiles.p50)}`;
              return (
                <div className="outrow" key={outId}>
                  <span>{out?.title ?? outId}</span>
                  <span className="v">{v}</span>
                </div>
              );
            })}
          </div>
        )}
        <p className="empty-hint" style={{ marginTop: 16 }}>
          Select a node to inspect its distribution, quantiles, and definition.
        </p>
      </aside>
    );
  }

  const accent = familyAccent(node.kind);
  const result = results?.nodes[node.id];
  const s = result?.summary;

  return (
    <aside className="inspector focused" style={{ "--acc": accent } as React.CSSProperties}>
      <button className="sheet-close" onClick={() => select(null)} aria-label="Close inspector">
        ✕
      </button>
      <h2>{node.title ?? node.id}</h2>
      <div className="sub">
        <span className="k">{FAMILY_LABEL[node.kind]}</span>
        <span>{node.id}</span>
        {result?.unit && <span className="unit-chip">{result.unit}</span>}
      </div>
      {desc && (desc.latex || desc.error) && (
        <div className="eq-block">
          <Equation desc={desc} fit onEdit={(next) => replaceNode(node.id, next)} />
          {desc.inputs.length > 0 && (
            <div className="eq-legend">
              {desc.inputs.map((input) => (
                <button
                  type="button"
                  className="legend-row"
                  key={input.id}
                  style={{ "--pc": varColour(input.index) } as React.CSSProperties}
                  onClick={() => select(input.id)}
                  title={`Go to ${input.id}`}
                >
                  <span className="legend-dot" />
                  <span className={`in-name eqv ${varClass(input.index)}`}>{humanize(input.id)}</span>
                  <span className="in-title">{input.title ?? input.id}</span>
                </button>
              ))}
            </div>
          )}
          {desc.slots.length > 0 && <div className="eq-hint">Click a number in the equation to change it.</div>}
        </div>
      )}
      {node.notes && <p className="notes">{node.notes}</p>}
      <DiagnosticsList items={diagnostics.filter((d) => d.nodeId === node.id)} />

      {(node.kind === "prior.dist" || node.kind === "prior.sourced") && (
        <>
          {node.kind === "prior.sourced" && (
            <div className="de-caption">Fallback distribution, used until a source is connected</div>
          )}
          <DistEditor
            dist={node.kind === "prior.dist" ? node.dist : node.fallback}
            unit={result?.unit}
            onScrub={(d) => scrubNodeDist(node.id, d)}
            onCommit={(d) => setNodeDist(node.id, d)}
          />
        </>
      )}

      {s?.categorical && (
        <div>
          {s.categorical.labels.map((label, i) => {
            const p = s.categorical!.probs[i];
            return (
              <div className="catrow" key={label}>
                <span className="cat-label" title={label}>{label}</span>
                <div className="bar">
                  <div style={{ width: `${p * 100}%` }} />
                </div>
                <span className="pct">{fmtPct(p)}</span>
              </div>
            );
          })}
        </div>
      )}

      {s && !s.categorical && (
        <table className="summary">
          <tbody>
            <tr>
              <td>mean</td>
              <td>{fmt(s.mean)}</td>
            </tr>
            <tr>
              <td>sd</td>
              <td>{fmt(s.sd)}</td>
            </tr>
            <tr>
              <td>median</td>
              <td>{fmt(s.quantiles.p50)}</td>
            </tr>
            <tr>
              <td>80% interval</td>
              <td>
                {fmt(s.ci80[0])} to {fmt(s.ci80[1])}
              </td>
            </tr>
            <tr>
              <td>95% interval</td>
              <td>
                {fmt(s.ci95[0])} to {fmt(s.ci95[1])}
              </td>
            </tr>
            <tr>
              <td>p05 / p95</td>
              <td>
                {fmt(s.quantiles.p05)} / {fmt(s.quantiles.p95)}
              </td>
            </tr>
            <tr>
              <td>min / max</td>
              <td>
                {fmt(s.min)} / {fmt(s.max)}
              </td>
            </tr>
          </tbody>
        </table>
      )}

      <details>
        <summary>Edit definition</summary>
        {/* keyed on content so drag-edits refresh the JSON text */}
        <NodeEditor node={node} key={JSON.stringify(node)} />
      </details>
    </aside>
  );
}
