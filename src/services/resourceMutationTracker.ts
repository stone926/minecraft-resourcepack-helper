import { normalizePathKey } from "../../packages/mc-assets/src";
import { LruCache } from "./lruCache";

/**
 * Bounded mutation history used by async resource consumers. Evicted path
 * records leave a conservative barrier behind, so bounded storage can reduce
 * cache reuse but can never incorrectly declare an old snapshot current.
 */
export class ResourceMutationTracker {
  private generation = 0;
  private globalMutationGeneration = 0;
  private discardedPathMutationGeneration = 0;
  private readonly pathMutationGenerations: LruCache<string, number>;

  constructor(maxPathEntries = 8192) {
    this.pathMutationGenerations = new LruCache(
      Math.max(1, maxPathEntries),
      (_fileName, mutationGeneration) => {
        this.discardedPathMutationGeneration = Math.max(
          this.discardedPathMutationGeneration,
          mutationGeneration
        );
      }
    );
  }

  currentGeneration(): number {
    return this.generation;
  }

  recordPath(fileName: string): number {
    const generation = ++this.generation;
    this.pathMutationGenerations.set(normalizePathKey(fileName), generation);
    return generation;
  }

  recordGlobal(): number {
    const generation = ++this.generation;
    this.globalMutationGeneration = generation;
    this.pathMutationGenerations.clear();
    this.discardedPathMutationGeneration = 0;
    return generation;
  }

  hasAnyChangedSince(generation: number, fileNames: Iterable<string>): boolean {
    if (generation < 0 || generation > this.generation) {
      return true;
    }
    if (
      this.globalMutationGeneration > generation ||
      this.discardedPathMutationGeneration > generation
    ) {
      return true;
    }

    for (const fileName of fileNames) {
      if ((this.pathMutationGenerations.peek(normalizePathKey(fileName)) ?? 0) > generation) {
        return true;
      }
    }
    return false;
  }
}
