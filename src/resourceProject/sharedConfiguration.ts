import type {
  ResourceProjectSharedConfigurationDto,
  SerializedResourceUri
} from "../../packages/resource-project/src";
import { resourceLayerConfigurationFromRoot } from "./projectConfiguration";

export function sharedConfigurationFromSettings(
  workspaceFolderUri: SerializedResourceUri,
  defaultAssetsPath: string | null | undefined,
  resourcePackLoadOrder: readonly string[]
): ResourceProjectSharedConfigurationDto {
  const vanillaLayer = defaultAssetsPath?.trim()
    ? resourceLayerConfigurationFromRoot("vanilla", defaultAssetsPath, workspaceFolderUri, 0)
    : undefined;
  const externalLayers = resourcePackLoadOrder
    .filter(root => root.trim().length > 0)
    .map((root, index) => resourceLayerConfigurationFromRoot(
      "custom",
      root.trim(),
      workspaceFolderUri,
      index
    ));
  return { vanillaLayer, externalLayers };
}
