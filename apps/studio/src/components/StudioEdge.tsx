import { BaseEdge, getBezierPath, type EdgeProps } from "@xyflow/react";
import type { StudioFlowEdge } from "../graph.js";

/**
 * An edge leaves in the colour of its source's family and arrives in the
 * colour the target gives that variable, so following a wire from a card's
 * readout lands you on the matching term of the next equation.
 */
export function StudioEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<StudioFlowEdge>) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const gradientId = `edge-grad-${id}`;
  return (
    <>
      <defs>
        <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={sourceX} y1={sourceY} x2={targetX} y2={targetY}>
          <stop offset="0" style={{ stopColor: data?.fromColour ?? "var(--ink-3)" }} />
          <stop offset="1" style={{ stopColor: data?.toColour ?? "var(--ink-3)" }} />
        </linearGradient>
      </defs>
      <BaseEdge id={id} path={path} style={{ stroke: `url(#${gradientId})` }} />
    </>
  );
}
