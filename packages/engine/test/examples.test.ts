import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDoc } from "@bayes-studio/schema";
import { runInference } from "../src/index.js";

/**
 * Every bundled example must validate without warnings, run with no blocked
 * nodes, and produce finite samples everywhere. The studio loads these files
 * at startup, so a broken example is a broken app.
 */
const dir = join(import.meta.dirname, "../../../examples");
const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();

describe("bundled examples", () => {
  it("there are examples to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    describe(file, () => {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as unknown;

      it("validates with no issues at all", () => {
        const res = validateDoc(raw);
        expect(res.ok, res.issues.map((i) => i.message).join("\n")).toBe(true);
        expect(res.issues).toEqual([]);
      });

      it("runs with nothing blocked and no non-finite samples", () => {
        const r = runInference(raw, { samples: 4000 });
        expect(r.blocked).toEqual({});
        for (const [id, node] of Object.entries(r.nodes)) {
          expect(node.summary.nonFinite, `${id} produced non-finite samples`).toBe(0);
        }
      });

      it("every node has a stored layout position", () => {
        const doc = validateDoc(raw).doc!;
        for (const node of doc.nodes) {
          expect(doc.layout?.[node.id], `${node.id} has no layout entry`).toBeDefined();
        }
      });
    });
  }
});
