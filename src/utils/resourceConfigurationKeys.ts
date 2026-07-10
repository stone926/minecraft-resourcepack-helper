export const resourceConfigurationKeys = {
  defaultAssetsPath: "McResHelper.defaultMcAssetsPath",
  resourcePackLoadOrder: "McResHelper.resourcePackLoadOrder",
  undefinedTextureVariableColor: "McResHelper.tipColorForUndefinedTextureVariables"
} as const;

export const resourceResolutionConfigurationKeys = [
  resourceConfigurationKeys.defaultAssetsPath,
  resourceConfigurationKeys.resourcePackLoadOrder
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
