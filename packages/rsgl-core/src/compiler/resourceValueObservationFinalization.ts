import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import type { ResourceUnit, RsglValidationReferenceOrigin } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";

/**
 * Keeps observations that still describe emitted values and rebases them
 * through compact sugar or scalar model normalization to their final sinks.
 */
export function finalizeResourceValueObservations(
  unit: ResourceUnit,
  observations: readonly RsglResourceValueObservation[],
  detachedOrigins: readonly RsglValidationReferenceOrigin[]
): RsglResourceValueObservation[] {
  return observations.flatMap(observation => {
    const generatedPaths = finalResourceValueObservationPaths(
      unit.content,
      observation.generatedPath,
      unit.kind
    );
    return generatedPaths.flatMap(generatedPath => {
      const finalObservation = generatedPath === observation.generatedPath
        ? observation
        : { ...observation, generatedPath };
      const provenance = latestObservationProvenance(
        unit,
        detachedOrigins,
        generatedPath
      );
      if (!provenance) {
        return [finalObservation];
      }
      if (observation.sourceFile && provenance.sourceFile !== observation.sourceFile) {
        return [];
      }
      return provenance.sourceRange.start <= observation.range.start
        && provenance.sourceRange.end >= observation.range.end
        ? [finalObservation]
        : [];
    });
  });
}

function finalResourceValueObservationPaths(
  content: ResourceUnit["content"],
  generatedPath: string,
  resourceKind: ResourceUnit["kind"]
): string[] {
  const value = jsonValueAtGeneratedPath(content, generatedPath);
  if (typeof value === "string") {
    return [generatedPath];
  }
  if (
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).model === "string"
  ) {
    return [appendGeneratedPath(generatedPath, "model")];
  }
  if (resourceKind === "equipment" && generatedPath === "/texture") {
    return compactEquipmentTexturePaths(content);
  }
  return [];
}

function compactEquipmentTexturePaths(content: ResourceUnit["content"]): string[] {
  if (!content || typeof content !== "object" || Array.isArray(content)) {
    return [];
  }
  const layers = (content as Record<string, unknown>).layers;
  if (!layers || typeof layers !== "object" || Array.isArray(layers)) {
    return [];
  }
  const paths: string[] = [];
  for (const [layer, entries] of Object.entries(layers)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    entries.forEach((entry, index) => {
      if (
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && typeof (entry as Record<string, unknown>).texture === "string"
      ) {
        paths.push(appendGeneratedPath(
          appendGeneratedPath(appendGeneratedPath("/layers", layer), String(index)),
          "texture"
        ));
      }
    });
  }
  return paths;
}

function latestObservationProvenance(
  unit: ResourceUnit,
  detachedOrigins: readonly RsglValidationReferenceOrigin[],
  generatedPath: string
): { sourceFile: string; sourceRange: { start: number; end: number } } | undefined {
  for (let index = detachedOrigins.length - 1; index >= 0; index--) {
    const origin = detachedOrigins[index];
    if (origin.generatedPath === generatedPath) {
      return origin;
    }
  }
  for (let index = unit.sourceMap.mappings.length - 1; index >= 0; index--) {
    const mapping = unit.sourceMap.mappings[index];
    if (mapping.generatedPath === generatedPath) {
      return mapping;
    }
  }
  return undefined;
}

function jsonValueAtGeneratedPath(
  content: ResourceUnit["content"],
  generatedPath: string
): unknown {
  if (generatedPath === "") {
    return content;
  }
  if (
    content
    && typeof content === "object"
    && !Array.isArray(content)
    && (
      (content.kind === "text" && "text" in content)
      || (content.kind === "copy" && "sourcePath" in content)
    )
  ) {
    return undefined;
  }
  let value: unknown = content;
  for (const rawSegment of generatedPath.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^\d+$/.test(segment)) {
        return undefined;
      }
      value = value[Number(segment)];
      continue;
    }
    if (!value || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}
