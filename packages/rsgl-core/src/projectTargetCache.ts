import { resolveRsglPath, rsglPathKey } from "./pathIdentity";
import type { ItemModelFormat } from "./itemModelSchema";
import { loadRsglProjectConfigForSource } from "./rsglConfig";
import { normalizeRsglProjectTarget } from "./compiler/targetConfig";

/**
 * Small source-keyed cache for project target lookups on completion/hover paths.
 * Filesystem watchers own invalidation, so absent and malformed configs are safe
 * to cache without polling or scanning the workspace on every language request.
 */
export class RsglProjectTargetCache {
  private readonly targetsBySource = new Map<string, ItemModelFormat | null>();

  public projectItemModelTargetFormatForSource(
    sourceFileName: string
  ): ItemModelFormat | undefined {
    const key = rsglPathKey(resolveRsglPath(sourceFileName));
    const cached = this.targetsBySource.get(key);
    if (cached !== undefined) {
      return cached ? [...cached] : undefined;
    }

    const target = this.loadTarget(sourceFileName);
    this.targetsBySource.set(key, target ?? null);
    return target ? [...target] : undefined;
  }

  public invalidateAll(): void {
    this.targetsBySource.clear();
  }

  private loadTarget(sourceFileName: string): ItemModelFormat | undefined {
    try {
      const target = loadRsglProjectConfigForSource(sourceFileName)?.config.target;
      if (!target) {
        return undefined;
      }
      const packFormat = normalizeRsglProjectTarget(target).packFormat;
      return [packFormat.major, packFormat.minor ?? 0];
    } catch {
      // Diagnostics load and report malformed configs separately. Language
      // features retain the target-neutral schema union until the config changes.
      return undefined;
    }
  }
}
