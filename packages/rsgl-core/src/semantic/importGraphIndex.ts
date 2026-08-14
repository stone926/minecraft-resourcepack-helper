import { rsglPathKey } from "../pathIdentity";
import type { RsglImportGraph } from "./types";

export type RsglImportGraphEdge = RsglImportGraph["edges"][number];

/** Constant-time import-edge lookup shared by semantic fixed-point passes. */
export class RsglImportGraphIndex {
  private readonly targetsBySource = new Map<
    string,
    Map<string, Map<string, RsglImportGraphEdge>>
  >();

  public constructor(importGraph: RsglImportGraph) {
    for (const edge of importGraph.edges) {
      const from = rsglPathKey(edge.from);
      let sources = this.targetsBySource.get(from);
      if (!sources) {
        sources = new Map();
        this.targetsBySource.set(from, sources);
      }
      let targets = sources.get(edge.source);
      if (!targets) {
        targets = new Map();
        sources.set(edge.source, targets);
      }
      const target = rsglPathKey(edge.to);
      if (!targets.has(target)) {
        targets.set(target, edge);
      }
    }
  }

  public resolve(
    fromFileName: string,
    source: string,
    resolvedFileName?: string
  ): RsglImportGraphEdge | undefined {
    const targets = this.targetsBySource.get(rsglPathKey(fromFileName))?.get(source);
    if (!targets) {
      return undefined;
    }
    if (resolvedFileName) {
      return targets.get(rsglPathKey(resolvedFileName));
    }
    return targets.values().next().value;
  }
}
