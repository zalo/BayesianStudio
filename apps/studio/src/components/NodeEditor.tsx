import { useState } from "react";
import type { AnyNode, ValidationIssue } from "@bayes-studio/schema";
import { useStudio } from "../store.js";

/**
 * JSON editor for one node — the same shape AI agents author, so learning
 * the editor teaches the document format. Validate-on-apply; nothing lands
 * in the model until the whole document passes.
 */
export function NodeEditor({ node }: { node: AnyNode }) {
  const updateNode = useStudio((s) => s.updateNode);
  const deleteNode = useStudio((s) => s.deleteNode);
  const pristine = JSON.stringify(node, null, 2);
  const [text, setText] = useState(pristine);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const dirty = text !== pristine;

  return (
    <div className="node-editor">
      <textarea
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        rows={Math.min(22, text.split("\n").length + 1)}
      />
      {issues.map((issue, i) => (
        <div className="edit-error" key={i}>
          {issue.message}
        </div>
      ))}
      {deleteError && <div className="edit-error">{deleteError}</div>}
      <div className="edit-actions">
        <button
          className="apply-btn"
          disabled={!dirty}
          onClick={() => {
            const result = updateNode(node.id, text);
            setIssues(result ?? []);
          }}
        >
          Apply
        </button>
        <button className="ghost-btn" disabled={!dirty} onClick={() => { setText(pristine); setIssues([]); }}>
          Reset
        </button>
        <span style={{ flex: 1 }} />
        <button className="danger-btn" onClick={() => setDeleteError(deleteNode(node.id))}>
          Delete node
        </button>
      </div>
    </div>
  );
}
