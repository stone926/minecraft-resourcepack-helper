import * as path from "node:path";
import { normalizePathKey, uniqueValues } from "../../mc-assets/src";
import {
  isRsglResourceSnapshotInvalidationNotification,
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceSnapshotInvalidationNotification,
  type RsglResourceSnapshotRequest
} from "../../rsgl-shared/src";
import {
  fileNameFromSerializedResourceUri,
  isNativePathInsideOrEqual,
  rsglSourceUriFromFileName,
  type RsglResourceUriNativePathMapping
} from "./resourceSnapshotUris";

type RsglProjectContext = RsglResourceSnapshotRequest["projectContext"];

/** Registry of projects that have explicitly requested snapshots. */
export class RsglResourceSnapshotProjectRegistry {
  private readonly projects = new Map<string, RegisteredProject>();
  private nextInvalidation = 1;

  public register(
    context: RsglProjectContext,
    nativePathMappings: readonly RsglResourceUriNativePathMapping[] = []
  ): void {
    const existing = this.projects.get(context.projectId);
    this.projects.set(context.projectId, {
      context,
      sourceRoots: context.rsglSourceRootUris.flatMap(uri =>
        fileNameFromSerializedResourceUri(uri, nativePathMappings) ?? []
      ).map(fileName => path.resolve(fileName)),
      layerRoots: [
        context.outputPackRootUri,
        ...context.externalLayers.map(layer => layer.rootUri),
        ...(context.vanillaLayer ? [context.vanillaLayer.rootUri] : [])
      ].flatMap(uri => fileNameFromSerializedResourceUri(uri, nativePathMappings) ?? [])
        .map(fileName => path.resolve(fileName)),
      nativePathMappings: [...nativePathMappings],
      dependencyKeys: existing?.dependencyKeys ?? new Set(),
      lastKnownRevision: existing?.lastKnownRevision
    });
  }

  public recordDependencies(projectId: string, dependencies: readonly { path: string }[]): void {
    const project = this.projects.get(projectId);
    if (!project) {
      return;
    }
    for (const dependency of dependencies) {
      project.dependencyKeys.add(normalizePathKey(path.resolve(dependency.path)));
    }
  }

  public recordSnapshotRevision(projectId: string, revision: string): void {
    const project = this.projects.get(projectId);
    if (project) {
      project.lastKnownRevision = revision;
    }
  }

  public lastKnownRevision(projectId: string): string | undefined {
    return this.projects.get(projectId)?.lastKnownRevision;
  }

  public invalidate(
    reason: RsglResourceSnapshotInvalidationNotification["reason"],
    changedFileNames: readonly string[]
  ): RsglResourceSnapshotInvalidationNotification[] {
    const changed = uniqueNativePaths(changedFileNames);
    const notifications: RsglResourceSnapshotInvalidationNotification[] = [];
    for (const project of this.projects.values()) {
      if (!projectAffected(project, reason, changed)) {
        continue;
      }
      const affectedSourceUris = changed
        .filter(fileName => project.sourceRoots.some(root => isNativePathInsideOrEqual(fileName, root)))
        .filter(fileName => path.extname(fileName).toLowerCase() === ".rsgl")
        .map(fileName => rsglSourceUriFromFileName(fileName, project.nativePathMappings));
      const notification: RsglResourceSnapshotInvalidationNotification = {
        protocolVersion: rsglResourceSnapshotProtocolVersion,
        projectId: project.context.projectId,
        invalidationRevision: `rsgl-invalidation:${this.nextInvalidation++}`,
        reason,
        ...(affectedSourceUris.length > 0
          ? { affectedSourceUris: uniqueStrings(affectedSourceUris) }
          : {})
      };
      if (!isRsglResourceSnapshotInvalidationNotification(notification)) {
        throw new Error("Constructed an invalid RSGL resource snapshot invalidation.");
      }
      notifications.push(notification);
    }
    return notifications;
  }
}

interface RegisteredProject {
  context: RsglProjectContext;
  sourceRoots: string[];
  layerRoots: string[];
  nativePathMappings: readonly RsglResourceUriNativePathMapping[];
  dependencyKeys: Set<string>;
  lastKnownRevision?: string;
}

function projectAffected(
  project: RegisteredProject,
  reason: RsglResourceSnapshotInvalidationNotification["reason"],
  changedFileNames: readonly string[]
): boolean {
  if (reason === "configuration" || reason === "refresh" || changedFileNames.length === 0) {
    return true;
  }
  if (changedFileNames.some(fileName =>
    project.sourceRoots.some(root => isNativePathInsideOrEqual(fileName, root))
  )) {
    return true;
  }
  if (reason === "materialization") {
    return changedFileNames.some(fileName =>
      project.layerRoots.some(root => isNativePathInsideOrEqual(fileName, root))
    );
  }
  return project.dependencyKeys.size === 0
    || changedFileNames.some(fileName =>
      project.dependencyKeys.has(normalizePathKey(fileName))
      || project.layerRoots.some(root => isNativePathInsideOrEqual(fileName, root))
    );
}

function uniqueNativePaths(fileNames: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const fileName of fileNames) {
    const resolved = path.resolve(fileName);
    unique.set(normalizePathKey(resolved), resolved);
  }
  return [...unique.values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return uniqueValues(values).sort((left, right) => left.localeCompare(right, "en"));
}
