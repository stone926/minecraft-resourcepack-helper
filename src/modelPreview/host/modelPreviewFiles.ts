import { isCitPropertiesFileName } from "../../cit/citPaths";

export function isModelPreviewFileName(fileName: string): boolean {
  return /[\\/]assets[\\/][^\\/]+[\\/]models[\\/].+\.json$/i.test(fileName) ||
    isCitPropertiesFileName(fileName);
}
