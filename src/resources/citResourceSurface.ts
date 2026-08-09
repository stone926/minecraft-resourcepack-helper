import * as path from "node:path";
import { parseAssetsPath } from "../../packages/mc-assets/src";

export const citresewnSourceDirectory = "citresewn";

export interface CitDocumentInfo {
  namespace: string;
  source: string;
}

export function isCitPropertiesFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null
    && path.extname(fileName).toLowerCase() === ".properties";
}

export function isCitModelFileName(fileName: string): boolean {
  return getCitDocumentInfo(fileName) !== null
    && path.extname(fileName).toLowerCase() === ".json";
}

export function getCitDocumentSource(fileName: string): string {
  return getCitDocumentInfo(fileName)?.source ?? citresewnSourceDirectory;
}

export function getCitDocumentNamespace(fileName: string): string {
  return getCitDocumentInfo(fileName)?.namespace ?? "minecraft";
}

export function getCitDocumentInfo(fileName: string): CitDocumentInfo | null {
  const parsed = parseAssetsPath(fileName);
  if (!parsed || parsed.relativeSegments.length < 2) {
    return null;
  }

  const relativeSegments = parsed.relativeSegments.slice(0, -1);
  if (relativeSegments[0]?.toLowerCase() !== citresewnSourceDirectory) {
    return null;
  }

  return {
    namespace: parsed.namespace,
    source: relativeSegments.join("/")
  };
}
