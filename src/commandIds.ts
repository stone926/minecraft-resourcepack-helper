/**
 * Single source for `McResHelper.*` command ids. `contributedCommands` must
 * mirror `package.json` `contributes.commands` exactly; `internalCommands`
 * are registered for wiring only and stay out of the manifest. The
 * extension-surface test enforces both sets against the manifest.
 */
export const contributedCommands = {
  openDefaultMcAssetsPath: "McResHelper.openDefaultMcAssetsPath",
  createNewResourcePack: "McResHelper.createNewResourcePack",
  createNewResourcePackRoot: "McResHelper.createNewResourcePackRoot",
  refreshResourceGraph: "McResHelper.refreshResourceGraph",
  searchResourceGraph: "McResHelper.searchResourceGraph",
  followActiveResource: "McResHelper.followActiveResource",
  refreshResources: "McResHelper.refreshResources",
  openGeneratedResource: "McResHelper.openGeneratedResource",
  openMaterializedResource: "McResHelper.openMaterializedResource",
  showResourceConflictOwners: "McResHelper.showResourceConflictOwners",
  configureVanillaSource: "McResHelper.configureVanillaSource",
  openModelPreview: "McResHelper.openModelPreview",
  exportModelPreviewImage: "McResHelper.exportModelPreviewImage",
  openResourceGraphModelPreview: "McResHelper.openResourceGraphModelPreview",
  openUnsupportedModelPreviewResource: "McResHelper.openUnsupportedModelPreviewResource",
  createCitTemplate: "McResHelper.createCitTemplate",
  generateCitForCurrentItem: "McResHelper.generateCitForCurrentItem"
} as const;

export const internalCommands = {
  navigateResourceGraphNode: "McResHelper.navigateResourceGraphNode",
  showWorkspaceResourceCacheStats: "McResHelper.showWorkspaceResourceCacheStats",
  captureModelPreviewImage: "McResHelper.captureModelPreviewImage",
  triggerResourceCompletion: "McResHelper.triggerResourceCompletion",
  createMissingCitResource: "McResHelper.createMissingCitResource"
} as const;

export type McResHelperCommandId =
  | (typeof contributedCommands)[keyof typeof contributedCommands]
  | (typeof internalCommands)[keyof typeof internalCommands];
