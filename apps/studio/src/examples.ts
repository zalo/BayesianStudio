import { validateDoc, type BayesDoc } from "@bayes-studio/schema";
import drakeRaw from "../../../examples/drake.json";
import greatFilterRaw from "../../../examples/great-filter.json";
import pDoomRaw from "../../../examples/p-doom.json";
import aiBubbleRaw from "../../../examples/ai-bubble.json";

export interface ExampleEntry {
  key: string;
  title: string;
  doc: BayesDoc;
}

function parse(key: string, raw: unknown): ExampleEntry {
  const res = validateDoc(raw);
  if (!res.ok || !res.doc) {
    throw new Error(
      `Bundled example '${key}' failed validation:\n${res.issues.map((i) => i.message).join("\n")}`,
    );
  }
  return { key, title: res.doc.meta.title, doc: res.doc };
}

/**
 * Bundled models. The same JSON files are covered by
 * `packages/engine/test/examples.test.ts` (and Drake by the golden test), so
 * edits here change tests too.
 */
export const EXAMPLES: ExampleEntry[] = [
  parse("drake", drakeRaw),
  parse("great-filter", greatFilterRaw),
  parse("p-doom", pDoomRaw),
  parse("ai-bubble", aiBubbleRaw),
];

export const DEFAULT_EXAMPLE = "drake";
