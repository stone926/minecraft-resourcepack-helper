export const resourceConfigurationKeys = {
  vanillaResourcePackPath: "McResHelper.vanillaResourcePackPath",
  customResourcePackPaths: "McResHelper.customResourcePackPaths",
  legacyDefaultMcAssetsPath: "McResHelper.defaultMcAssetsPath",
  legacyResourcePackLoadOrder: "McResHelper.resourcePackLoadOrder",
  undefinedTextureVariableColor: "McResHelper.tipColorForUndefinedTextureVariables"
} as const;

export const resourceResolutionConfigurationKeys = [
  resourceConfigurationKeys.vanillaResourcePackPath,
  resourceConfigurationKeys.customResourcePackPaths,
  resourceConfigurationKeys.legacyDefaultMcAssetsPath,
  resourceConfigurationKeys.legacyResourcePackLoadOrder
] as const;

export interface ConfigurationChangeEventLike {
  affectsConfiguration(section: string): boolean;
}

export function affectsResourceResolutionConfiguration(
  event: ConfigurationChangeEventLike
): boolean {
  return resourceResolutionConfigurationKeys.some(section => event.affectsConfiguration(section));
}

export function isResourceResolutionConfigurationKey(section: string): boolean {
  return resourceResolutionConfigurationKeys.some(candidate => candidate === section);
}
