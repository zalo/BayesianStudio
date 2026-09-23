import { memo, useEffect, type ReactNode } from "react";
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from "@xyflow/react";
import { fmt, fmtPct } from "../format.js";
import { FAMILY_LABEL, familyAccent, type StudioFlowNode } from "../graph.js";
import { humanize, varClass, varColour } from "../explain.js";
import { useStudio } from "../store.js";
import { Equation } from "./Equation.js";
import { Sparkline } from "./Sparkline.js";

/**
 * A node card reads top to bottom: what kind of thing this is, its name, the
 * equation that defines it, the inputs that equation uses (each with its own
 * port, so wires arrive next to the variable they feed), and the result.
 */
export const StudioNode = memo(function StudioNode({ id, data, selected }: NodeProps<StudioFlowNode>) {
  const { node, result, blocked, desc } = data;
  const accent = familyAccent(node.kind);
  const summary = result?.summary;
  const nonFiniteShare = summary && summary.nonFinite > 0 ? summary.nonFinite / summary.n : 0;
  const replaceNode = useStudio((s) => s.replaceNode);

  // Ports are rendered per input, so React Flow must re-measure them when
  // the input list changes (a formula gains a variable, a parent is added).
  const updateNodeInternals = useUpdateNodeInternals();
  const inputsKey = desc.inputs.map((i) => i.id).join("\u0000");
  useEffect(() => {
    updateNodeInternals(id);
  }, [id, inputsKey, updateNodeInternals]);

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

  // The wire out leaves from the row that holds the node's value.
  const outPort = data.hasDependents ? (
    <Handle type="source" position={Position.Right} className="out-port" />
  ) : null;

  let body: ReactNode;
  if (blocked) {
    body = (
      <div className="row blocked-msg" title={blocked}>
        ⊘ {blocked}
        {outPort}
      </div>
    );
  } else if (node.kind === "decision") {
    body = (
      <div className="row alts">
        {node.alternatives.map((alt) => (
          <span className="alt-chip" key={alt}>
            {alt}
          </span>
        ))}
        {outPort}
      </div>
    );
  } else if (node.kind === "output") {
    body = null;
  } else if (headline) {
    body = (
      <>
        <div className="row stat">
          <span className="value">{headline.value}</span>
          {result?.unit && <span className={`unit${result.unit === "%" ? " pct" : ""}`}>{result.unit}</span>}
          <span className="label">{headline.label}</span>
          {outPort}
        </div>
        {ci && <div className="ci">{ci}</div>}
        {summary && summary.sd !== 0 && <Sparkline summary={summary} accent={accent} />}
      </>
    );
  } else {
    body = (
      <div className="row pending">
        Waiting for a run
        {outPort}
      </div>
    );
  }

  return (
    <div
      className={`snode${selected ? " selected" : ""}${blocked ? " blocked" : ""}`}
      style={{ "--acc": accent } as React.CSSProperties}
    >
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

      <Equation desc={desc} fit onEdit={(next) => replaceNode(node.id, next)} />

      {desc.inputs.length > 0 && (
        <div className="inputs">
          {desc.inputs.map((input) => (
            <div
              className="in-row"
              key={input.id}
              style={{ "--pc": varColour(input.index) } as React.CSSProperties}
              title={input.title ? `${input.id}: ${input.title}` : input.id}
            >
              <Handle type="target" position={Position.Left} id={input.id} className="in-port" />
              <span className={`in-name eqv ${varClass(input.index)}`}>{humanize(input.id)}</span>
              {input.title && <span className="in-title">{input.title}</span>}
            </div>
          ))}
        </div>
      )}

      {body && <div className="body">{body}</div>}
      {/* Cards with nothing below the equation still need somewhere for the wire out to start. */}
      {!body && outPort && <div className="body slim">{outPort}</div>}
    </div>
  );
});
