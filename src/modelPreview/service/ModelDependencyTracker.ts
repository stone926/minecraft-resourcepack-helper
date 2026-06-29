import { fileURLToPath } from "node:url";
import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import { fileNameKey } from "../resolve/ResourceDependencyResolver";

export class ModelDependencyTracker {
  private readonly dependencyKeys = new Set<string>();

  update(document: ModelPreviewDocument): void {
    this.dependencyKeys.clear();
    for (const dependency of document.dependencies) {
      if (dependency.kind !== "configuration") {
        this.dependencyKeys.add(toDependencyKey(dependency.uri));
      }
    }
  }

  hasFile(fileNameOrUri: string): boolean {
    return this.dependencyKeys.has(toDependencyKey(fileNameOrUri));
  }

  hasConfiguration(section: string): boolean {
    return section === "McResHelper.defaultMcAssetsPath" || section === "McResHelper.resourcePackLoadOrder";
  }
}

function toDependencyKey(value: string): string {
  if (value.startsWith("file://")) {
    try {
      return fileNameKey(fileURLToPath(value));
    } catch {
      return value.toLowerCase();
    }
  }

  return fileNameKey(value);
}
