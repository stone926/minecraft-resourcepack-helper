import { isExternalResourceUnit, JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";

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

  return {
    ...units[0],
    content,
    sourceMap: {
      generatedFile: units[0].outputPath,
      mappings: units.flatMap(unit => unit.sourceMap.mappings)
    }
  };
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

  return {
    ...units[0],
    content: units.flatMap(unit => unit.content as JsonValue[]),
    sourceMap: {
      generatedFile: units[0].outputPath,
      mappings: units.flatMap(unit => unit.sourceMap.mappings)
    }
  };
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
