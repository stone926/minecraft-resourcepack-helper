import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import { dependencyKey } from "../paths";

export class ModelDependencyTracker {
  private readonly dependencyKeys = new Set<string>();

  update(document: ModelPreviewDocument): void {
    this.dependencyKeys.clear();
    for (const dependency of document.dependencies) {
      if (dependency.kind !== "configuration") {
        this.dependencyKeys.add(dependencyKey(dependency.uri));
      }
    }
  }

  hasFile(fileNameOrUri: string): boolean {
    return this.dependencyKeys.has(dependencyKey(fileNameOrUri));
  }

  hasConfiguration(section: string): boolean {
    return section === "McResHelper.defaultMcAssetsPath" || section === "McResHelper.resourcePackLoadOrder";
  }
}
