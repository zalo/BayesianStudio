import { memo } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { fmt, fmtPct } from "../format.js";
import { FAMILY_LABEL, familyAccent, type StudioFlowNode } from "../graph.js";
import { Sparkline } from "./Sparkline.js";

export const StudioNode = memo(function StudioNode({ data, selected }: NodeProps<StudioFlowNode>) {
  const { node, result, blocked } = data;
  const accent = familyAccent(node.kind);
  const summary = result?.summary;
  const nonFiniteShare = summary && summary.nonFinite > 0 ? summary.nonFinite / summary.n : 0;

  let headline: { value: string; label: string } | null = null;
  let ci: string | null = null;
  if (summary) {
    if (summary.probTrue !== undefined) {
      headline = { value: fmtPct(summary.probTrue), label: "P(true)" };
    } else if (summary.categorical) {
      const { labels, probs } = summary.categorical;
      const top = probs.indexOf(Math.max(...probs));
      headline = { value: fmtPct(probs[top]), label: labels[top] };
    } else if (summary.sd === 0) {
      headline = { value: fmt(summary.mean), label: "exact" };
    } else {
      headline = { value: fmt(summary.quantiles.p50), label: "median" };
      ci = `80% within ${fmt(summary.ci80[0])} to ${fmt(summary.ci80[1])}`;
    }
  }

  return (
    <div
      className={`snode${selected ? " selected" : ""}${blocked ? " blocked" : ""}`}
      style={{ "--acc": accent } as React.CSSProperties}
    >
      {data.hasInputs && <Handle type="target" position={Position.Left} />}
      <div className="head">
        <span className="kind">{FAMILY_LABEL[node.kind]}</span>
        {nonFiniteShare > 0 && (
          <span
            className="flag"
            title={`${summary!.nonFinite.toLocaleString()} non-finite samples excluded (division by zero, log of ≤ 0, …)`}
          >
            ⚠ {fmtPct(nonFiniteShare)} non-finite
          </span>
        )}
      </div>
      <div className="title">{node.title ?? node.id}</div>
      {blocked && (
        <div className="body">
          <div className="blocked-msg" title={blocked}>
            ⊘ {blocked}
          </div>
        </div>
      )}
      {!blocked && node.kind === "decision" && (
        <div className="body">
          <div className="alts">
            {node.alternatives.map((alt) => (
              <span className="alt-chip" key={alt}>
                {alt}
              </span>
            ))}
          </div>
        </div>
      )}
      {!blocked && node.kind !== "output" && node.kind !== "decision" && (
        <div className="body">
          {headline ? (
            <>
              <div className="stat">
                <span className="value">{headline.value}</span>
                {result?.unit && <span className="unit">{result.unit}</span>}
                <span className="label">{headline.label}</span>
              </div>
              {ci && <div className="ci">{ci}</div>}
              {summary && summary.sd !== 0 && <Sparkline summary={summary} accent={accent} />}
            </>
          ) : (
            <div className="pending">Waiting for a run</div>
          )}
        </div>
      )}
      {data.hasDependents && <Handle type="source" position={Position.Right} />}
    </div>
  );
});
