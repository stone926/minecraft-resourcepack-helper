import { isCitModelFileName, isCitPropertiesFileName } from "../../cit/citPaths";
import { ResourceReferenceDocumentKind } from "./types";

export function getResourceReferenceDocumentKind(fileName: string): ResourceReferenceDocumentKind | null {
  for (const { kind, pattern, matches } of resourceReferenceDocumentPatterns) {
    if (pattern?.test(fileName) || matches?.(fileName)) {
      return kind;
    }
  }

  return null;
}

const resourceReferenceDocumentPatterns: Array<{
  kind: ResourceReferenceDocumentKind;
  pattern?: RegExp;
  matches?: (fileName: string) => boolean;
}> = [
  { kind: "blockstates", pattern: /[\\/]blockstates[\\/].+\.json$/i },
  { kind: "modelsBlock", pattern: /[\\/]models[\\/]block[\\/].+\.json$/i },
  { kind: "modelsItem", pattern: /[\\/]models[\\/]item[\\/].+\.json$/i },
  { kind: "models", pattern: /[\\/]models[\\/].+\.json$/i },
  { kind: "particles", pattern: /[\\/]particles[\\/].+\.json$/i },
  { kind: "items", pattern: /[\\/]items[\\/].+\.json$/i },
  { kind: "atlases", pattern: /[\\/]atlases[\\/].+\.json$/i },
  { kind: "equipment", pattern: /[\\/]equipment[\\/].+\.json$/i },
  { kind: "font", pattern: /[\\/]font[\\/].+\.json$/i },
  { kind: "waypointStyle", pattern: /[\\/]waypoint_style[\\/].+\.json$/i },
  { kind: "postEffect", pattern: /[\\/]post_effect[\\/].+\.json$/i },
  { kind: "sounds", pattern: /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i },
  { kind: "shaderCore", pattern: /[\\/]shaders[\\/]core[\\/].+\.(?:vsh|fsh)$/i },
  { kind: "shaderPost", pattern: /[\\/]shaders[\\/]post[\\/].+\.(?:vsh|fsh)$/i },
  { kind: "citModel", matches: isCitModelFileName },
  { kind: "citProperties", matches: isCitPropertiesFileName }
];
