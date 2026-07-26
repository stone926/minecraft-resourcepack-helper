export const rsglFileGlob = "**/*.rsgl";
export const rsglLanguageId = "rsgl";
export const rsglFileExtension = ".rsgl";

/**
 * Structural `.rsgl` document predicate for lazily loaded RSGL surfaces.
 * The root activation bundle keeps its own copy in `rsglActivationSignals`
 * because the build contract forbids it from reaching this package.
 */
export function isRsglDocumentLike(document: {
  languageId?: string;
  fileName?: string;
  uriPath?: string;
}): boolean {
  if (document.languageId === rsglLanguageId) {
    return true;
  }
  return [document.fileName, document.uriPath]
    .some(value => value !== undefined && value.toLowerCase().endsWith(rsglFileExtension));
}

export * from "./resourceSnapshotProtocol";
export * from "./resourceNavigationProtocol";

/** Server-to-client notification carrying current exact and patterned watch dependencies. */
export const rsglDependencyPathsNotification = "rsgl/dependencyPaths";
/** Client-to-server notification for targeted dependency-directory events. */
export const rsglDependencyStructureChangedNotification = "rsgl/dependencyStructureChanged";
/** Client-to-server request to discard unwatched external-resource state. */
export const rsglRefreshWorkspaceNotification = "rsgl/refreshWorkspace";

export interface RsglDependencyWatchPattern {
  basePath: string;
  pattern: string;
}

export interface RsglDependencyPathsNotification {
  /** Complete exact dependency union used for structural invalidation. */
  paths: string[];
  /** Ownership-aware exact paths that require individual content watchers. */
  requiredExactWatchPaths: string[];
  patterns?: RsglDependencyWatchPattern[];
}

export interface RsglDependencyStructureChangedNotification {
  paths: string[];
}

export const rsglCommands = {
  build: "rsgl.build",
  previewBuild: "rsgl.previewBuild",
  buildDirectory: "rsgl.buildDirectory",
  previewDirectoryBuild: "rsgl.previewDirectoryBuild",
  buildWorkspace: "rsgl.buildWorkspace",
  previewWorkspaceBuild: "rsgl.previewWorkspaceBuild",
  refreshWorkspace: "rsgl.refreshWorkspace"
} as const;

export const rsglConfigKeys = {
  defaultAssetsPath: "McResHelper.defaultMcAssetsPath",
  resourcePackLoadOrder: "McResHelper.resourcePackLoadOrder",
  style: "McResHelper.rsgl.format.style",
  lineWidth: "McResHelper.rsgl.format.lineWidth",
  braceStyle: "McResHelper.rsgl.format.braceStyle"
} as const;

export type RsglCommandId = typeof rsglCommands[keyof typeof rsglCommands];
