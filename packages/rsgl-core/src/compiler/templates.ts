import { ExpansionFrame, ExternalResourceKind, ResourceUnit, RsglMapping } from "./ir";
import { parseResourceId, resourceOutputPath } from "./resourceIds";

export function createExternalResource(
  resourceKind: ExternalResourceKind,
  idValue: string,
  namespace: string,
  sourceFile: string,
  sourceRange: { start: number; end: number },
  expansionStack: ExpansionFrame[] = [],
  reason: RsglMapping["reason"] = "direct"
): ResourceUnit | null {
  const id = parseResourceId(idValue, namespace);
  if (!id) {
    return null;
  }
  const externalId = `${id.namespace}:${id.path}`;
  const outputPath = resourceOutputPath(resourceKind, id, resourceKind === "texture" ? "png" : "json");
  return {
    id,
    kind: resourceKind,
    outputPath,
    content: null,
    external: {
      kind: "external",
      resourceKind,
      id: externalId
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: {
      generatedFile: outputPath,
      mappings: [
        {
          generatedPath: "",
          sourceFile,
          sourceRange,
          reason,
          expansionStack
        }
      ]
    }
  };
}

export function normalizeResourceValue(value: string, namespace: string, defaultFolder: string): string {
  if (value.includes(":")) {
    return value;
  }
  return `${namespace}:${value.includes("/") ? value : `${defaultFolder}/${value}`}`;
}
