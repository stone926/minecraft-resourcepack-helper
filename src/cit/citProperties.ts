import { getCitDocumentSource } from "./citPaths";
import { resolveCitResourceType, resolveCitType } from "./citKeyResolution";
import { getCitPropertiesEntries, type CitPropertiesDocument, type CitPropertyEntry } from "./citPropertiesParser";
import type { CitType } from "./citSpecTypes";
import type { ResourceReference } from "../utils/resourceReferences";

export function getCitPropertyReferences(document: CitPropertiesDocument): ResourceReference[] {
  const references: ResourceReference[] = [];
  const fileName = document.fileName;
  const source = getCitDocumentSource(fileName);
  const entries = getCitPropertiesEntries(document);
  const citType = resolveCitType(entries);

  for (const entry of entries) {
    const reference = getCitPropertyReference(entry, source, citType);
    if (reference) {
      references.push(reference);
    }
  }

  const autoDiscovery = getCitAutoDiscoveryReference(entries, fileName, source, citType);
  if (autoDiscovery) {
    references.push(autoDiscovery);
  }

  return references;
}

function getCitPropertyReference(
  entry: CitPropertyEntry,
  source: string,
  citType: CitType
): ResourceReference | null {
  const resourceType = resolveCitResourceType(entry.key, citType);
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

function getCitAutoDiscoveryReference(
  entries: CitPropertyEntry[],
  fileName: string,
  source: string,
  citType: CitType
): ResourceReference | null {
  if (citType !== "item" || entries.some(entry => resolveCitResourceType(entry.key, citType))) {
    return null;
  }

  const location = {
    start: { line: 1, column: 0 },
    end: { line: 1, column: 0 }
  };

  return {
    value: stripExtension(fileName),
    valueNode: {
      valueLoc: location
    },
    target: "models",
    source,
    extension: "json",
    kind: "model",
    resolveMode: "cit",
    origin: "citAutoDiscovery",
    synthetic: true
  };
}

function stripExtension(fileName: string): string {
  const normalized = fileName.replace(/[\\/]+/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex >= 0 ? basename.slice(0, extensionIndex) : basename;
}
