import { normalizePathKey } from "../../packages/mc-assets/src";

export const maxModelParentDepth = 10;

export type ModelParentAdvanceResult =
  | { kind: "next"; fileName: string }
  | { kind: "cycle"; fileName: string }
  | { kind: "depth"; fileName: string; maxDepth: number };

/** Shared cycle/depth state for synchronous diagnostics and async preview traversal. */
export class ModelParentTraversal {
  private readonly visited = new Set<string>();
  private depth = 0;

  constructor(entryFileName: string, private readonly maxDepth = maxModelParentDepth) {
    this.visited.add(normalizePathKey(entryFileName));
  }

  advance(parentFileName: string): ModelParentAdvanceResult {
    const key = normalizePathKey(parentFileName);
    if (this.visited.has(key)) {
      return { kind: "cycle", fileName: parentFileName };
    }
    if (this.depth >= this.maxDepth) {
      return { kind: "depth", fileName: parentFileName, maxDepth: this.maxDepth };
    }

    this.depth++;
    this.visited.add(key);
    return { kind: "next", fileName: parentFileName };
  }
}
