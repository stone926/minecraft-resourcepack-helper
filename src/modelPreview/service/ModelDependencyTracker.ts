import * as path from "node:path";
import type { ModelPreviewDocument } from "../ir/PreviewDocument";
import { isResourceResolutionConfigurationKey } from "../../utils/resourceConfigurationKeys";
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

  /** Returns true when a file operation targets a dependency or one of its ancestors. */
  hasFileAtOrBelow(fileNameOrUri: string): boolean {
    const rootKey = dependencyKey(fileNameOrUri);
    for (const dependency of this.dependencyKeys) {
      const relative = path.relative(rootKey, dependency);
      if (
        relative === ""
        || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
      ) {
        return true;
      }
    }
    return false;
  }

  hasConfiguration(section: string): boolean {
    return isResourceResolutionConfigurationKey(section);
  }
}
