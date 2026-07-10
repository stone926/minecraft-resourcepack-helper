export const rsglExtensionId = "stone926.rsgl";
export const rsglFileGlob = "**/*.rsgl";

/** Server-to-client notification carrying the current compiled JSON inputs. */
export const rsglDependencyPathsNotification = "rsgl/dependencyPaths";

export interface RsglDependencyPathsNotification {
  paths: string[];
}

export const rsglCommands = {
  build: "rsgl.build",
  previewBuild: "rsgl.previewBuild",
  buildDirectory: "rsgl.buildDirectory",
  previewDirectoryBuild: "rsgl.previewDirectoryBuild",
  buildWorkspace: "rsgl.buildWorkspace",
  previewWorkspaceBuild: "rsgl.previewWorkspaceBuild"
} as const;

export const rsglConfigKeys = {
  outDir: "rsgl.outDir",
  defaultAssetsPath: "rsgl.defaultAssetsPath",
  resourcePackLoadOrder: "rsgl.resourcePackLoadOrder"
} as const;

export type RsglCommandId = typeof rsglCommands[keyof typeof rsglCommands];
