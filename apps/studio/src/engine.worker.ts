/// <reference lib="webworker" />
import { runInference } from "@bayes-studio/engine";

export interface RunRequest {
  id: number;
  doc: unknown;
  samples?: number;
  seed?: number;
}

export type RunResponse =
  | { id: number; ok: true; result: ReturnType<typeof runInference>; ms: number }
  | { id: number; ok: false; error: string };

self.onmessage = (e: MessageEvent<RunRequest>) => {
  const { id, doc, samples, seed } = e.data;
  const t0 = performance.now();
  try {
    const opts: { samples?: number; seed?: number } = {};
    if (samples !== undefined) opts.samples = samples;
    if (seed !== undefined) opts.seed = seed;
    const result = runInference(doc, opts);
    const response: RunResponse = { id, ok: true, result, ms: performance.now() - t0 };
    self.postMessage(response);
  } catch (err) {
    const response: RunResponse = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
    self.postMessage(response);
  }
};
