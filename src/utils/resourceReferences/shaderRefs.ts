import { parseAssetsPath } from "../../../packages/mc-assets/src";
import { AstLocation } from "../locationChecker";
import { TextOffsetMap } from "../textOffsets";
import { ResourceReference } from "./types";

export function getShaderReferences(
  text: string,
  source: string,
  fileName = ""
): ResourceReference[] {
  const references: ResourceReference[] = [];
  const textOffsets = new TextOffsetMap(text);
  const importPattern = /#\s*moj_import\s*(?:<([^>\r\n]*)>|"([^"\r\n]*)")/g;
  const sourceDirectory = getShaderSourceDirectory(fileName, source);

  for (const match of text.matchAll(importPattern)) {
    const value = match[1] ?? match[2];
    if (value === undefined || match.index === undefined) {
      continue;
    }

    const angle = match[1] !== undefined;
    const openingIndex = match[0].indexOf(angle ? "<" : "\"");
    const valueStart = match.index + openingIndex + 1;
    const valueEnd = valueStart + value.length;
    const valueLoc = getLocationForOffsets(textOffsets, valueStart, valueEnd);
    const hitLoc = toOneBasedColumnLocation(valueLoc);
    const relative = !angle;
    references.push({
      value,
      valueNode: {
        loc: hitLoc,
        valueLoc,
        hitLoc
      },
      target: relative ? sourceDirectory : "shaders/include",
      source: sourceDirectory,
      extension: null,
      kind: "shader",
      ...(relative ? { resolveMode: "relative" as const } : {})
    });
  }

  return references;
}

/** Assets-relative directory used by quoted imports and pack-root discovery. */
export function getShaderSourceDirectory(fileName: string, fallback: string): string {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length < 2) {
    return fallback;
  }
  return parsed.relativeSegments.slice(0, -1).join("/") || fallback;
}

function getLocationForOffsets(
  textOffsets: TextOffsetMap,
  startOffset: number,
  endOffset: number
): AstLocation {
  const start = textOffsets.positionAt(startOffset);
  const end = textOffsets.positionAt(endOffset);

  return {
    start: {
      line: start.line + 1,
      column: start.character
    },
    end: {
      line: end.line + 1,
      column: end.character
    }
  };
}

function toOneBasedColumnLocation(location: AstLocation): AstLocation {
  return {
    start: {
      line: location.start.line,
      column: location.start.column + 1
    },
    end: {
      line: location.end.line,
      column: location.end.column + 1
    }
  };
}
