import type { ExternResourceSource } from "../externDeclarations";
import { ExternalResourceKind, ResourceUnit } from "./ir";
import { getExternResourceTargetKind } from "../resourceKinds";
import { parseResourceId, resourceTargetOutputPath } from "./resourceIds";

export function createExternalResource(
  resourceKind: ExternalResourceKind,
  idValue: string,
  source: ExternResourceSource,
  skipExistenceCheck: boolean,
  sourceFile: string,
  sourceRange: { start: number; end: number }
): ResourceUnit | null {
  const id = parseResourceId(idValue, "minecraft");
  if (!id) {
    return null;
  }
  const externalId = `${id.namespace}:${id.path}`;
  const outputPath = resourceTargetOutputPath(getExternResourceTargetKind(resourceKind), id);
  return {
    id,
    kind: resourceKind,
    outputPath,
    content: null,
    external: {
      kind: "external",
      resourceKind,
      id: externalId,
      source,
      skipExistenceCheck
    },
    mergePolicy: { kind: "errorOnConflict" },
    sourceMap: {
      generatedFile: outputPath,
      mappings: [
        {
          generatedPath: "",
          sourceFile,
          sourceRange,
          reason: "direct",
          expansionStack: []
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
