import { getCitDocumentSource, getCitResourceType } from "./citPaths";
import { parseCitProperties, type CitPropertyEntry } from "./citPropertiesParser";
import type { ResourceReference } from "./resourceReferences";

export function getCitPropertyReferences(text: string, fileName: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const source = getCitDocumentSource(fileName);

  for (const entry of parseCitProperties(text)) {
    const reference = getCitPropertyReference(entry, source);
    if (reference) {
      references.push(reference);
    }
  }

  return references;
}

function getCitPropertyReference(entry: CitPropertyEntry, source: string): ResourceReference | null {
  const resourceType = getCitResourceType(entry.key);
  if (!resourceType) {
    return null;
  }

  return {
    value: entry.value,
    valueNode: {
      loc: entry.fullRange,
      valueLoc: entry.valueRange,
      hitLoc: {
        start: {
          line: entry.valueRange.start.line,
          column: entry.valueRange.start.column + 1
        },
        end: {
          line: entry.valueRange.end.line,
          column: Math.max(entry.valueRange.end.column + 1, entry.valueRange.start.column + 1)
        }
      }
    },
    target: resourceType,
    source,
    extension: resourceType === "textures" ? "png" : "json",
    kind: resourceType === "textures" ? "texture" : "model",
    resolveMode: "cit"
  };
}
