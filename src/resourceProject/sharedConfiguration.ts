import type {
  ResourceProjectSharedConfigurationDto,
  SerializedResourceUri
} from "../../packages/resource-project/src";
import { resourceLayerConfigurationFromRoot } from "./projectConfiguration";

export function sharedConfigurationFromSettings(
  workspaceFolderUri: SerializedResourceUri,
  vanillaResourcePackPath: string | null | undefined,
  customResourcePackPaths: readonly string[]
): ResourceProjectSharedConfigurationDto {
  const vanillaLayer = vanillaResourcePackPath?.trim()
    ? resourceLayerConfigurationFromRoot("vanilla", vanillaResourcePackPath, workspaceFolderUri, 0)
    : undefined;
  const externalLayers = customResourcePackPaths
    .filter(root => root.trim().length > 0)
    .map((root, index) => resourceLayerConfigurationFromRoot(
      "custom",
      root.trim(),
      workspaceFolderUri,
      index
    ));
  return { vanillaLayer, externalLayers };
}
