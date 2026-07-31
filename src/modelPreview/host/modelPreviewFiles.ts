import { isCitPropertiesFileName } from "../../cit/citPaths";
import { isAssetsModelJsonFileName } from "../../resources/resourceSurfaceRegistry";

export function isModelPreviewFileName(fileName: string): boolean {
  return isAssetsModelJsonFileName(fileName) || isCitPropertiesFileName(fileName);
}

export function isPackMetadataFileName(fileName: string): boolean {
  return /(?:^|[\\/])pack\.mcmeta$/i.test(fileName);
}
