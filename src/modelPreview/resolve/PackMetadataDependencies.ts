import * as path from "node:path";
import {
  ancestorPackMetadataCandidates,
  normalizePathKey
} from "../../../packages/mc-assets/src";
import type {
  ModelPreviewConfiguration,
  ModelPreviewFileSystem,
  ResolvedDependency
} from "../model/ModelDocument";
import { setDependencyWithActualPriority } from "../model/DependencyPriority";

/**
 * Pack discovery is itself a resource dependency. Keep both the current
 * pack.mcmeta and every closer candidate so create/delete events can change
 * the nearest pack root without leaving an open preview stale.
 */
export function collectPackMetadataDependencies(
  resourceDependencies: Iterable<ResolvedDependency>,
  configuration: ModelPreviewConfiguration,
  fileSystem: ModelPreviewFileSystem
): ResolvedDependency[] {
  const dependencies = new Map<string, ResolvedDependency>();

  for (const resourceDependency of resourceDependencies) {
    const fileName = resourceDependency.fileName;
    const packRoot = fileSystem.getPackRoot?.(fileName) ?? null;
    for (const candidate of ancestorPackMetadataCandidates(fileName, packRoot)) {
      addDependency(
        dependencies,
        candidate,
        resourceDependency.watchOnly === true || !fileSystem.fileExists(candidate)
      );
    }
  }

  for (const configuredRoot of configuration.resourcePackRoots ?? []) {
    if (configuredRoot.trim()) {
      const candidate = path.join(path.normalize(configuredRoot), "pack.mcmeta");
      addDependency(dependencies, candidate, !fileSystem.fileExists(candidate));
    }
  }

  return [...dependencies.values()];
}

/**
 * Conservative metadata candidates to observe before pack-root discovery.
 * Unlike final preview dependencies this intentionally walks to the filesystem
 * root, because the current pack root has not been resolved yet.
 */
export function collectPotentialPackMetadataFileNames(
  sourceFileName: string,
  configuration: ModelPreviewConfiguration
): string[] {
  const candidates = ancestorPackMetadataCandidates(sourceFileName, null);
  for (const configuredRoot of configuration.resourcePackRoots ?? []) {
    if (configuredRoot.trim()) {
      candidates.push(path.join(path.normalize(configuredRoot), "pack.mcmeta"));
    }
  }
  return [...new Map(candidates.map(candidate => [normalizePathKey(candidate), candidate])).values()];
}

function addDependency(
  dependencies: Map<string, ResolvedDependency>,
  fileName: string,
  watchOnly: boolean
): void {
  setDependencyWithActualPriority(
    dependencies,
    normalizePathKey(fileName),
    {
      fileName,
      kind: "packMetadata",
      ...(watchOnly ? { watchOnly: true } : {})
    }
  );
}
