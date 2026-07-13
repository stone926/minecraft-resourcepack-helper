import { isExternalResourceUnit, JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { isJsonObject } from "./jsonValues";
import { uniqueValues } from "../../../mc-assets/src";

export interface MergeResourceUnitsResult {
  units: ResourceUnit[];
  diagnostics: RsglCompileDiagnostic[];
}

export function mergeResourceUnits(units: ResourceUnit[]): MergeResourceUnitsResult {
  const diagnostics: RsglCompileDiagnostic[] = [];
  const groups = new Map<string, ResourceUnit[]>();

  for (const unit of units) {
    const group = groups.get(unit.outputPath);
    if (group) {
      group.push(unit);
    } else {
      groups.set(unit.outputPath, [unit]);
    }
  }

  const mergedUnits: ResourceUnit[] = [];
  for (const group of groups.values()) {
    const fileUnits = group.filter(unit => !isExternalResourceUnit(unit));
    if (fileUnits.length > 0 && fileUnits.length !== group.length) {
      if (fileUnits.length === 1) {
        mergedUnits.push(fileUnits[0]);
        continue;
      }
      const merged = tryMergeGroup(fileUnits, diagnostics);
      if (merged) {
        mergedUnits.push(merged);
      } else {
        mergedUnits.push(...fileUnits);
      }
      continue;
    }

    if (group.length === 1 || group.every(unit => isExternalResourceUnit(unit))) {
      mergedUnits.push(mergeExternalGroup(group));
      continue;
    }

    const merged = tryMergeGroup(group, diagnostics);
    if (merged) {
      mergedUnits.push(merged);
    } else {
      mergedUnits.push(...group);
    }
  }

  return { units: mergedUnits, diagnostics };
}

function mergeExternalGroup(units: ResourceUnit[]): ResourceUnit {
  if (units.length === 1) {
    return units[0];
  }
  return {
    ...units[0],
    sourceMap: {
      generatedFile: units[0].outputPath,
      mappings: units.flatMap(unit => unit.sourceMap.mappings)
    }
  };
}

function tryMergeGroup(
  units: ResourceUnit[],
  diagnostics: RsglCompileDiagnostic[]
): ResourceUnit | null {
  if (units.every(unit => unit.mergePolicy.kind === "mergeObject")) {
    return mergeObjectUnits(units, diagnostics);
  }
  if (units.every(unit => unit.mergePolicy.kind === "appendArray")) {
    return mergeArrayUnits(units);
  }
  return null;
}

function mergeObjectUnits(
  units: ResourceUnit[],
  diagnostics: RsglCompileDiagnostic[]
): ResourceUnit | null {
  if (!units.every(unit => isJsonObject(unit.content))) {
    return null;
  }

  const content: Record<string, JsonValue> = {};
  const seen = new Map<string, ResourceUnit>();
  for (const unit of units) {
    for (const [key, value] of Object.entries(unit.content as Record<string, JsonValue>)) {
      const existing = seen.get(key);
      if (existing && !isPackOverlayMerge(units[0].kind, key, content[key], value)) {
        diagnostics.push({
          code: "rsgl.mergeKeyConflict",
          message: `Merged RSGL resource key '${key}' is overwritten in ${unit.outputPath}.`,
          severity: "warning",
          range: unit.sourceMap.mappings[0]?.sourceRange ?? existing.sourceMap.mappings[0]?.sourceRange ?? { start: 0, end: 1 },
          fileName: unit.sourceMap.mappings[0]?.sourceFile ?? existing.sourceMap.mappings[0]?.sourceFile
        });
      }
      seen.set(key, unit);
      content[key] = mergeObjectField(units[0].kind, key, content[key], value);
    }
  }

  const validation = mergeUnitValidation(
    units,
    undefined,
    (unit, generatedPath) => observationBelongsToFinalObjectField(
      unit,
      generatedPath,
      seen,
      units[0].kind
    )
  );
  const merged: ResourceUnit = {
    ...units[0],
    content,
    sourceMap: {
      generatedFile: units[0].outputPath,
      mappings: units.flatMap(unit => unit.sourceMap.mappings)
    }
  };
  if (validation) {
    merged.validation = validation;
  } else {
    delete merged.validation;
  }
  return merged;
}

function isPackOverlayMerge(kind: ResourceUnit["kind"], key: string, existing: JsonValue | undefined, next: JsonValue): boolean {
  return kind === "pack" && key === "overlays" && isJsonObject(existing) && isJsonObject(next);
}

function mergeObjectField(kind: ResourceUnit["kind"], key: string, existing: JsonValue | undefined, next: JsonValue): JsonValue {
  if (kind === "pack" && key === "overlays" && isJsonObject(existing) && isJsonObject(next)) {
    return mergePackOverlays(existing, next);
  }
  return next;
}

function mergePackOverlays(existing: Record<string, JsonValue>, next: Record<string, JsonValue>): Record<string, JsonValue> {
  const existingEntries = Array.isArray(existing.entries) ? existing.entries : [];
  const nextEntries = Array.isArray(next.entries) ? next.entries : [];
  return {
    ...existing,
    ...next,
    entries: [...existingEntries, ...nextEntries]
  };
}

function mergeArrayUnits(units: ResourceUnit[]): ResourceUnit | null {
  if (!units.every(unit => Array.isArray(unit.content))) {
    return null;
  }

  let nextOffset = 0;
  const rootArrayOffsets = units.map(unit => {
    const offset = nextOffset;
    nextOffset += (unit.content as JsonValue[]).length;
    return offset;
  });
  const validation = mergeUnitValidation(units, rootArrayOffsets);
  return {
    ...units[0],
    content: units.flatMap(unit => unit.content as JsonValue[]),
    ...(validation ? { validation } : {}),
    sourceMap: {
      generatedFile: units[0].outputPath,
      mappings: units.flatMap((unit, index) => unit.sourceMap.mappings.map(mapping => ({
        ...mapping,
        generatedPath: rebaseRootArrayGeneratedPath(mapping.generatedPath, rootArrayOffsets[index])
      })))
    }
  };
}

function mergeUnitValidation(
  units: readonly ResourceUnit[],
  rootArrayOffsets?: readonly number[],
  includeObservation: (unit: ResourceUnit, generatedPath: string) => boolean = () => true
): ResourceUnit["validation"] | undefined {
  const externalTextureVariables = uniqueValues(units.flatMap(unit =>
    unit.validation?.externalTextureVariables ?? []
  ));
  const referenceOrigins = units.flatMap((unit, index) =>
    (unit.validation?.referenceOrigins ?? []).map(origin => ({
      ...origin,
      generatedPath: rebaseRootArrayGeneratedPath(
        origin.generatedPath,
        rootArrayOffsets?.[index] ?? 0
      )
    }))
  );
  const resourceValueObservations = units.flatMap((unit, index) =>
    (unit.validation?.resourceValueObservations ?? [])
      .filter(observation => includeObservation(unit, observation.generatedPath))
      .map(observation => ({
        ...observation,
        generatedPath: rebaseRootArrayGeneratedPath(
          observation.generatedPath,
          rootArrayOffsets?.[index] ?? 0
        )
      }))
  );
  if (
    externalTextureVariables.length === 0
    && referenceOrigins.length === 0
    && resourceValueObservations.length === 0
  ) {
    return undefined;
  }
  return {
    ...(externalTextureVariables.length > 0 ? { externalTextureVariables } : {}),
    ...(referenceOrigins.length > 0 ? { referenceOrigins } : {}),
    ...(resourceValueObservations.length > 0 ? { resourceValueObservations } : {})
  };
}

function observationBelongsToFinalObjectField(
  unit: ResourceUnit,
  generatedPath: string,
  finalFieldOwners: ReadonlyMap<string, ResourceUnit>,
  resourceKind: ResourceUnit["kind"]
): boolean {
  const field = rootObjectFieldAtGeneratedPath(generatedPath);
  if (field === undefined) {
    return true;
  }
  if (resourceKind === "pack" && field === "overlays") {
    return true;
  }
  return finalFieldOwners.get(field) === unit;
}

function rootObjectFieldAtGeneratedPath(generatedPath: string): string | undefined {
  if (!generatedPath.startsWith("/")) {
    return undefined;
  }
  const segment = generatedPath.slice(1).split("/", 1)[0];
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function rebaseRootArrayGeneratedPath(generatedPath: string, offset: number): string {
  if (offset === 0) {
    return generatedPath;
  }
  return generatedPath.replace(/^\/(\d+)(?=\/|$)/, (_match, index: string) =>
    `/${Number(index) + offset}`
  );
}
