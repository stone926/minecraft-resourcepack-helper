import { AstLocation } from "../locationChecker";
import { TextOffsetMap } from "../textOffsets";
import { ResourceReference } from "./types";

export function getShaderReferences(text: string, source: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const textOffsets = new TextOffsetMap(text);
  const importPattern = /#\s*moj_import\s*(?:<([^>\r\n]+)>|"([^"\r\n]+)")/g;

  for (const match of text.matchAll(importPattern)) {
    const value = match[1] ?? match[2];
    if (value === undefined || match.index === undefined) {
      continue;
    }

    const valueStart = match.index + match[0].indexOf(value);
    const valueEnd = valueStart + value.length;
    const valueLoc = getLocationForOffsets(textOffsets, valueStart, valueEnd);
    const target = match[1] !== undefined || value.includes(":") ? "shaders/include" : "shaders/core";
    references.push({
      value,
      valueNode: {
        loc: valueLoc,
        valueLoc
      },
      target,
      source,
      extension: null,
      kind: "shader"
    });
  }

  return references;
}

function getLocationForOffsets(textOffsets: TextOffsetMap, startOffset: number, endOffset: number): AstLocation {
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
