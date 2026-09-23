import type { Diagnostic } from "../diagnostics.js";
import { useStudio } from "../store.js";

/** Radiant-style diagnostics list: click a row to jump to the node it names. */
export function DiagnosticsList({ items, title }: { items: Diagnostic[]; title?: string }) {
  const select = useStudio((s) => s.select);
  if (items.length === 0) return null;
  return (
    <div className="diag-list">
      {title && (
        <div className="diag-title">
          {title} <span className="diag-count">{items.length}</span>
        </div>
      )}
      {items.map((d, i) => {
        const jump = d.nodeId;
        return (
          <div
            key={`${d.nodeId ?? ""}:${i}`}
            className={`diag ${d.severity}`}
            role={jump ? "button" : undefined}
            tabIndex={jump ? 0 : undefined}
            onClick={jump ? () => select(jump) : undefined}
            onKeyDown={jump ? (e) => { if (e.key === "Enter" || e.key === " ") select(jump); } : undefined}
          >
            <span className="dot" aria-label={d.severity} />
            <span className="msg">
              {d.nodeId && <span className="where">{d.nodeId}</span>}
              {d.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}
