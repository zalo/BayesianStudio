import { useState } from "react";
import type { AnyNode } from "@bayes-studio/schema";
import { useStudio } from "../store.js";

const ADDABLE: { kind: AnyNode["kind"]; label: string }[] = [
  { kind: "prior.dist", label: "Prior (distribution)" },
  { kind: "prior.sourced", label: "Sourced prior" },
  { kind: "prior.pooled", label: "Pooled prior" },
  { kind: "formula", label: "Formula" },
  { kind: "comparator", label: "Comparator (threshold)" },
  { kind: "logic", label: "Logic (and/or/not)" },
  { kind: "cond.mixture", label: "Mixture (value by case)" },
  { kind: "cond.cpt", label: "Probability table (CPT)" },
  { kind: "decision", label: "Decision" },
  { kind: "utility", label: "Utility" },
  { kind: "output", label: "Output (headline)" },
];

export function AddMenu() {
  const addNode = useStudio((s) => s.addNode);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="palette">
      <select
        value=""
        aria-label="Add node"
        onChange={(e) => {
          const kind = e.target.value as AnyNode["kind"];
          if (!kind) return;
          setError(addNode(kind));
        }}
      >
        <option value="" disabled>
          Add a node
        </option>
        {ADDABLE.map((a) => (
          <option key={a.kind} value={a.kind}>
            {a.label}
          </option>
        ))}
      </select>
      {error && (
        <div className="palette-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}
