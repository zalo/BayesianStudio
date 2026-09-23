import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  useNodesState,
  type EdgeTypes,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useStudio } from "./store.js";
import { toFlow, type StudioFlowNode } from "./graph.js";
import { StudioNode } from "./components/StudioNode.js";
import { StudioEdge } from "./components/StudioEdge.js";
import { Inspector } from "./components/Inspector.js";
import { AddMenu } from "./components/AddMenu.js";
import { EXAMPLES } from "./examples.js";

const nodeTypes: NodeTypes = { studio: StudioNode };
const edgeTypes: EdgeTypes = { studio: StudioEdge };

type Theme = "dark" | "light";
const THEME_KEY = "bayes-theme";

/** Explicit theme choice, or null to follow the system. Persisted across visits. */
function useTheme(): [Theme, () => void] {
  const read = (): Theme | null => {
    const t = document.documentElement.dataset.theme;
    return t === "light" || t === "dark" ? t : null;
  };
  const system = (): Theme =>
    window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const [theme, setTheme] = useState<Theme>(() => read() ?? system());

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* private mode: the choice just doesn't persist */
    }
    setTheme(next);
  }, [theme]);

  // Follow the system while the user hasn't chosen.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (!read()) setTheme(system());
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return [theme, toggle];
}

function Wordmark() {
  return (
    <span className="wordmark" aria-label="Bayes Studio">
      <svg width="24" height="18" viewBox="0 0 24 18" aria-hidden="true">
        <rect className="mark-band" x="8" y="3" width="8" height="14" opacity="0.22" />
        <path
          className="mark-curve"
          d="M1 17C6.5 17 8.5 1 12 1s5.5 16 11 16"
          fill="none"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
      Bayes Studio
    </span>
  );
}

function TopBar() {
  const doc = useStudio((s) => s.doc);
  const status = useStudio((s) => s.status);
  const run = useStudio((s) => s.run);
  const exampleKey = useStudio((s) => s.exampleKey);
  const loadExample = useStudio((s) => s.loadExample);
  const [theme, toggleTheme] = useTheme();

  return (
    <header className="topbar">
      <Wordmark />
      <select
        className="example-select"
        value={exampleKey ?? "custom"}
        onChange={(e) => loadExample(e.target.value)}
        aria-label="Model"
      >
        {EXAMPLES.map((ex) => (
          <option key={ex.key} value={ex.key}>
            {ex.title}
          </option>
        ))}
        {exampleKey === null && <option value="custom">{doc.meta.title} (edited)</option>}
      </select>
      <span className="spacer" />
      <span className="run-meta">
        <span>
          seed <b>{doc.meta.seed ?? 42}</b>
        </span>
        <span>
          <b>{(doc.meta.samples ?? 10_000).toLocaleString()}</b> samples
        </span>
      </span>
      <span className={`run-status ${status.state}`} role="status">
        {status.state === "running" && "sampling…"}
        {status.state === "done" && `${status.ms.toFixed(0)} ms`}
        {status.state === "error" && status.error.slice(0, 80)}
      </span>
      <button className="run-btn" onClick={run}>
        Run
      </button>
      <button
        className="icon-btn"
        onClick={toggleTheme}
        aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
        title={theme === "dark" ? "Light theme" : "Dark theme"}
      >
        {theme === "dark" ? (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
          </svg>
        ) : (
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
          </svg>
        )}
      </button>
    </header>
  );
}

function Canvas() {
  const doc = useStudio((s) => s.doc);
  const results = useStudio((s) => s.results);
  const select = useStudio((s) => s.select);
  const moveNode = useStudio((s) => s.moveNode);

  const flow = useMemo(() => toFlow(doc, results), [doc, results]);
  const [nodes, setNodes, onNodesChange] = useNodesState<StudioFlowNode>(flow.nodes);

  // Rebuild node data when the doc or results change, preserving any
  // in-flight drag positions React Flow is tracking.
  useEffect(() => {
    setNodes((current) => {
      const currentById = new Map(current.map((n) => [n.id, n]));
      return flow.nodes.map((n) => {
        const existing = currentById.get(n.id);
        return existing ? { ...n, position: existing.position, selected: existing.selected } : n;
      });
    });
  }, [flow, setNodes]);

  const onNodeClick: NodeMouseHandler<StudioFlowNode> = useCallback(
    (_, node) => select(node.id),
    [select],
  );

  return (
    <div className="canvas-wrap">
      <ReactFlow
        nodes={nodes}
        edges={flow.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onPaneClick={() => select(null)}
        onNodeDragStop={(_, node) => moveNode(node.id, node.position.x, node.position.y)}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.25}
      >
        {/* Graph paper: a fine grid with a heavier rule every fifth line. */}
        <Background id="minor" className="grid-minor" variant={BackgroundVariant.Lines} gap={24} lineWidth={1} />
        <Background id="major" className="grid-major" variant={BackgroundVariant.Lines} gap={120} lineWidth={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <AddMenu />
    </div>
  );
}

export default function App() {
  // Remount the canvas when a different example loads so stale positions
  // don't leak between documents that share node ids (both Fermi models
  // have R_star, f_p, …).
  const exampleKey = useStudio((s) => s.exampleKey);
  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <Canvas key={exampleKey ?? "custom"} />
        <Inspector />
      </div>
    </div>
  );
}
