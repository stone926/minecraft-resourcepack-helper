import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import { fileNameKey } from "../resolve/ResourceDependencyResolver";
import { fileURLToPath } from "node:url";

interface CacheEntry {
  document: Promise<ModelPreviewDocument>;
  dependencyKeys: Set<string>;
}

export class ModelPreviewCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(fileName: string): Promise<ModelPreviewDocument> | null {
    return this.entries.get(fileNameKey(fileName))?.document ?? null;
  }

  set(fileName: string, document: Promise<ModelPreviewDocument>): void {
    const key = fileNameKey(fileName);
    this.entries.set(key, {
      document: document.then(preview => {
        const entry = this.entries.get(key);
        if (entry) {
          entry.dependencyKeys = new Set(preview.dependencies.map(dependency => dependencyKey(dependency.uri)));
        }
        return preview;
      }),
      dependencyKeys: new Set([fileNameKey(fileName)])
    });
  }

  invalidate(fileName: string): void {
    this.entries.delete(fileNameKey(fileName));
  }

  invalidateAll(): void {
    this.entries.clear();
  }

  invalidateDependents(changedFileNameOrUri: string): void {
    const changedKey = dependencyKey(changedFileNameOrUri);
    for (const [entryKey, entry] of this.entries) {
      if (entryKey === changedKey || entry.dependencyKeys.has(changedKey)) {
        this.entries.delete(entryKey);
      }
    }
  }
}

function dependencyKey(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return fileNameKey(fileURLToPath(value));
    } catch {
      return value.toLowerCase();
    }
  }

  return fileNameKey(value);
}
