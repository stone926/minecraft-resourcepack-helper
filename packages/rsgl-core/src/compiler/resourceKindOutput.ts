import { getRsglResourceKindDescriptor, type RsglResourceKind } from "../resourceKinds";
import type { ResourceUnit } from "./ir";
import { resourceOutputPath } from "./resourceIds";

/** Applies the descriptor-owned output-path strategy to one compiled unit. */
export function applyResourceKindOutputPath(kind: RsglResourceKind, unit: ResourceUnit): ResourceUnit {
  const strategy = getRsglResourceKindDescriptor(kind)?.emit.pathStrategy;
  let outputPath: string;
  if (strategy === "resourceId") {
    if (!unit.id) {
      throw new Error(`RSGL resource kind '${kind}' requires an id for its output path.`);
    }
    outputPath = resourceOutputPath(kind, unit.id);
  } else if (strategy === "packMetadata") {
    outputPath = "pack.mcmeta";
  } else if (strategy === "soundsNamespace") {
    if (!unit.id) {
      throw new Error("RSGL sounds resources require a namespace for their output path.");
    }
    outputPath = `assets/${unit.id.namespace}/sounds.json`;
  } else if (strategy === "packRelativeOrResourceId" || strategy === "mcmetaTarget") {
    // These strategies first parse a user-supplied target. The handler supplies
    // that resolved target while the descriptor remains authoritative for which
    // strategy is legal for this resource kind.
    outputPath = unit.outputPath;
  } else {
    throw new Error(`Missing output-path strategy for RSGL resource kind '${kind}'.`);
  }

  if (outputPath === unit.outputPath) {
    return unit;
  }
  return {
    ...unit,
    outputPath,
    sourceMap: {
      ...unit.sourceMap,
      generatedFile: outputPath
    }
  };
}
