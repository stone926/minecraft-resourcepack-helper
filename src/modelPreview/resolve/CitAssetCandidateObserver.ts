import {
  getCitAssetCandidates,
  type CitAssetResolutionType
} from "../../cit/citAssetResolver";
import type {
  ModelPreviewConfiguration,
  ModelPreviewFileSystem
} from "../model/ModelDocument";
import { collectPotentialPackMetadataFileNames } from "./PackMetadataDependencies";

export interface CitAssetCandidateObservationOptions {
  fileSystem: ModelPreviewFileSystem;
  configuration?: ModelPreviewConfiguration;
  observeDependency?(fileName: string): void;
}

/**
 * CIT candidate calculation and dependency observation are one operation:
 * nearest-pack discovery and every asset candidate can both change the winner.
 */
export function observeCitAssetCandidates(
  sourceFileName: string,
  value: string,
  resourceType: CitAssetResolutionType,
  options: CitAssetCandidateObservationOptions
): string[] {
  for (const candidate of collectPotentialPackMetadataFileNames(
    sourceFileName,
    options.configuration ?? {}
  )) {
    options.observeDependency?.(candidate);
  }

  const candidates = getCitAssetCandidates(sourceFileName, value, resourceType, {
    pathExists: candidate => options.fileSystem.fileExists(candidate),
    getPackRoot: options.fileSystem.getPackRoot
      ? fileName => options.fileSystem.getPackRoot?.(fileName) ?? null
      : undefined
  });
  for (const candidate of candidates) {
    options.observeDependency?.(candidate);
  }
  return candidates;
}
