export const rsglExtensionId = "stone926.rsgl";
export const rsglApiVersion = 1;

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
  minecraftVersion: "rsgl.minecraftVersion",
  defaultAssetsPath: "rsgl.defaultAssetsPath",
  resourcePackLoadOrder: "rsgl.resourcePackLoadOrder",
  emitSourceMap: "rsgl.emitSourceMap",
  validateGeneratedJson: "rsgl.validateGeneratedJson"
} as const;

export type RsglCommandId = typeof rsglCommands[keyof typeof rsglCommands];
