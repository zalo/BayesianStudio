import type { ValidationIssue } from "@bayes-studio/schema";
import type { InferenceResult } from "@bayes-studio/engine";
import type { RunStatus } from "./store.js";
import { fmtPct } from "./format.js";

/**
 * One finding about the map. `error` = the node produces no value;
 * `warning` = something worth acting on; `info` = a fact nobody needs to fix
 * (a node blocked only because something upstream is).
 */
export interface Diagnostic {
  severity: "error" | "warning" | "info";
  nodeId?: string;
  message: string;
}

const RANK: Record<Diagnostic["severity"], number> = { error: 0, warning: 1, info: 2 };

/** Merge validator warnings, engine blocks, and sample-quality warnings into one list. */
export function collectDiagnostics(
  issues: ValidationIssue[],
  results: InferenceResult | null,
  status: RunStatus,
): Diagnostic[] {
  const out: Diagnostic[] = [];
  if (status.state === "error") out.push({ severity: "error", message: status.error });

  if (results) {
    for (const [id, reason] of Object.entries(results.blocked)) {
      const upstream = reason.startsWith("Blocked by upstream");
      out.push({
        severity: upstream ? "info" : "error",
        nodeId: id,
        message: upstream ? reason : `Blocked — ${reason}`,
      });
    }
    for (const [id, r] of Object.entries(results.nodes)) {
      if (r.kind === "output") continue; // mirrors its target, which reports for both
      const nf = r.summary.nonFinite;
      if (nf > 0) {
        out.push({
          severity: "warning",
          nodeId: id,
          message: `${nf.toLocaleString()} of ${r.summary.n.toLocaleString()} samples (${fmtPct(nf / r.summary.n)}) were non-finite — division by zero, log of a non-positive value, or an out-of-range probability — and were excluded from the statistics`,
        });
      }
    }
  }

  for (const issue of issues) {
    const d: Diagnostic = { severity: issue.severity, message: issue.message };
    if (issue.nodeId !== undefined) d.nodeId = issue.nodeId;
    out.push(d);
  }

  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity]);
}
