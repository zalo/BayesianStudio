import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import katex from "katex";
import type { AnyNode } from "@bayes-studio/schema";
import { humanize, varClass, type EditableSlot, type NodeDescription, type Segment } from "../explain.js";

/**
 * A node's equation, typeset with KaTeX, with its plain-English reading
 * beneath. Variables carry a colour class (`eqv v0`…) that the CSS palette
 * turns into ink; numbers are editable slots. Clicking a number opens a tiny
 * field over it; Enter (or blur) commits, Escape cancels.
 */

const KATEX_OPTIONS: katex.KatexOptions = {
  throwOnError: false,
  output: "html",
  strict: "ignore",
  // \htmlClass colours variables; \htmlData tags editable numbers. Nothing else is let through.
  trust: (ctx) => ctx.command === "\\htmlClass" || ctx.command === "\\htmlData",
};

/** Smallest fraction of the base size an equation shrinks to before it is clipped instead. */
const MIN_SCALE = 0.5;

export function renderLatex(latex: string): string {
  return katex.renderToString(latex, KATEX_OPTIONS);
}

/** The English reading: words interleaved with coloured variable names. */
export function Words({ segments }: { segments: Segment[] }) {
  return (
    <>
      {segments.map((seg, i) =>
        typeof seg === "string" ? (
          <span key={i}>{seg}</span>
        ) : (
          <span key={i} className={`eqv ${varClass(seg.index)}`}>
            {humanize(seg.var)}
          </span>
        ),
      )}
    </>
  );
}

interface EditState {
  slot: EditableSlot;
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  error: string | null;
}

interface EquationProps {
  desc: NodeDescription;
  /** Shrink the typeset line to the container's width instead of overflowing (node cards). */
  fit?: boolean;
  /** Receives the edited node when a number is committed; returns an error message or null. */
  onEdit?: (node: AnyNode) => string | null;
}

export function Equation({ desc, fit = false, onEdit }: EquationProps) {
  const html = useMemo(() => (desc.latex ? renderLatex(desc.latex) : ""), [desc.latex]);
  const boxRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const texRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [scale, setScale] = useState(1);
  const [edit, setEdit] = useState<EditState | null>(null);

  // Scale the typeset line down to fit. Both boxes live under the same canvas
  // zoom transform, so the ratio of their on-screen widths is zoom-free. The
  // KaTeX web fonts arrive after first paint and change the width, so the
  // typeset span is watched for size changes rather than measured once.
  const scaleRef = useRef(1);
  scaleRef.current = scale;
  useLayoutEffect(() => {
    if (!fit) return;
    const clip = clipRef.current;
    const tex = texRef.current;
    if (!clip || !tex) return;
    const measure = () => {
      const natural = tex.getBoundingClientRect().width / scaleRef.current;
      const avail = clip.getBoundingClientRect().width;
      if (natural === 0 || avail === 0) return;
      // A hair under the exact fit: nested em sizes round differently at each zoom level.
      const next = natural > avail ? Math.max(MIN_SCALE, (0.98 * avail) / natural) : 1;
      if (Math.abs(next - scaleRef.current) > 0.01) setScale(next);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(tex);
    return () => ro.disconnect();
  }, [html, fit]);

  useEffect(() => {
    if (edit) inputRef.current?.select();
  }, [edit?.slot]);

  if (!desc.latex) {
    if (!desc.error) return null;
    return (
      <div className="eq">
        <div className="eq-error">{desc.error}</div>
      </div>
    );
  }

  const beginEdit = (e: MouseEvent<HTMLDivElement>) => {
    if (!onEdit) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>(".eq-num");
    const box = boxRef.current;
    if (!target || !box) return;
    const index = Number(target.querySelector<HTMLElement>("[data-slot]")?.dataset.slot ?? target.dataset.slot);
    const slot = desc.slots[index];
    if (!slot) return;
    e.stopPropagation();
    const b = box.getBoundingClientRect();
    const r = target.getBoundingClientRect();
    const zoom = b.width / box.offsetWidth || 1;
    setEdit({
      slot,
      text: String(slot.value),
      left: (r.left - b.left) / zoom,
      top: (r.top - b.top) / zoom,
      width: r.width / zoom,
      height: r.height / zoom,
      error: null,
    });
  };

  const commit = () => {
    if (!edit || !onEdit) return;
    const text = edit.text.trim();
    if (text === String(edit.slot.value)) {
      setEdit(null);
      return;
    }
    if (text === "" || !Number.isFinite(Number(text))) {
      setEdit({ ...edit, error: "Enter a number" });
      return;
    }
    const err = onEdit(edit.slot.apply(text));
    if (err) setEdit({ ...edit, error: err });
    else setEdit(null);
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") setEdit(null);
    e.stopPropagation();
  };

  return (
    <div className={`eq${onEdit ? " editable" : ""}`} ref={boxRef} onClick={beginEdit}>
      <div className="eq-clip" ref={clipRef}>
        <span
          className="eq-tex"
          ref={texRef}
          style={{ fontSize: `${scale}em` }}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
      {desc.english.length > 0 && (
        <div className="eq-words">
          <Words segments={desc.english} />
        </div>
      )}
      {edit && (
        <>
          <input
            ref={inputRef}
            className={`eq-edit nodrag nopan${edit.error ? " invalid" : ""}`}
            style={{
              left: edit.left - 6,
              top: edit.top - 3,
              width: Math.max(56, edit.width + 28),
              height: edit.height + 6,
            }}
            value={edit.text}
            title={edit.slot.label}
            aria-label={`Edit ${edit.slot.label}`}
            inputMode="decimal"
            onChange={(e) => setEdit({ ...edit, text: e.target.value, error: null })}
            onKeyDown={onKey}
            onBlur={commit}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          />
          {edit.error && <div className="eq-error">{edit.error}</div>}
        </>
      )}
    </div>
  );
}
