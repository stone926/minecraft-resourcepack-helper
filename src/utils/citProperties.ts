import { getCitDocumentSource, getCitResourceType } from "./citPaths";
import { parseCitProperties, type CitPropertyEntry } from "./citPropertiesParser";
import type { ResourceReference } from "./resourceReferences";

export function getCitPropertyReferences(text: string, fileName: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const source = getCitDocumentSource(fileName);
  const entries = parseCitProperties(text);

  for (const entry of entries) {
    const reference = getCitPropertyReference(entry, source);
    if (reference) {
      references.push(reference);
    }
  }

  const autoDiscovery = getCitAutoDiscoveryReference(entries, fileName, source);
  if (autoDiscovery) {
    references.push(autoDiscovery);
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

function getCitAutoDiscoveryReference(
  entries: CitPropertyEntry[],
  fileName: string,
  source: string
): ResourceReference | null {
  if (getCitType(entries) !== "item" || entries.some(entry => getCitResourceType(entry.key))) {
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

function getCitType(entries: CitPropertyEntry[]): "item" | "armor" | "elytra" | "enchantment" {
  const value = entries.find(entry => entry.key === "type")?.value.trim();
  return value === "armor" || value === "elytra" || value === "enchantment" ? value : "item";
}

function stripExtension(fileName: string): string {
  const normalized = fileName.replace(/[\\/]+/g, "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  const extensionIndex = basename.lastIndexOf(".");
  return extensionIndex >= 0 ? basename.slice(0, extensionIndex) : basename;
}
