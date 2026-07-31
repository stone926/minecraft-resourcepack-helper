import { citresewnSourceDirectory } from "./citPaths";
import { parseAssetsPath } from "../../packages/mc-assets/src";

export function isCitGlobalPropertiesFileName(fileName: string): boolean {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length < 2) {
    return false;
  }

  const namespace = parsed.namespace.toLowerCase();
  const relativePath = parsed.relativeSegments.map(segment => segment.toLowerCase()).join("/");
  return namespace === "minecraft" && relativePath === `${citresewnSourceDirectory}/cit.properties`;
}
