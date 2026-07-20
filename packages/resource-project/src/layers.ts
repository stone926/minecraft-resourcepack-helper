import { createStableResourceProjectRevision } from "./revision";
import type {
  ResourceLayerConfigurationDto,
  ResourceLayerDescriptor,
  ResourceLayerRole,
  ResourceLayerSource,
  SerializedResourceUri
} from "./types";
import {
  normalizeResourceProjectUri,
  resolveResourceProjectUri,
  resourceProjectUriIdentity
} from "./uri";

export class ResourceLayerConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ResourceLayerConfigurationError";
  }
}

export function createResourceLayerDescriptor(
  configuration: ResourceLayerConfigurationDto,
  baseUri: SerializedResourceUri
): ResourceLayerDescriptor {
  assertLayerCombination(configuration.role, configuration.source);
  const rootUri = resolveResourceProjectUri(baseUri, configuration.root);
  const priority = normalizePriority(configuration.priority);
  const identity = {
    role: configuration.role,
    source: configuration.source,
    rootUri: resourceProjectUriIdentity(rootUri),
    priority
  };
  return {
    layerId: configuration.layerId?.trim()
      || createStableResourceProjectRevision("layer", identity),
    role: configuration.role,
    source: configuration.source,
    rootUri,
    priority,
    metadataRevision: configuration.metadataRevision?.trim()
      || createStableResourceProjectRevision("metadata", identity)
  };
}

export function createLocalResourceLayerDescriptor(
  outputPackRootUri: SerializedResourceUri
): ResourceLayerDescriptor {
  return createResourceLayerDescriptor({
    role: "local",
    source: "directory",
    root: normalizeResourceProjectUri(outputPackRootUri),
    priority: 0
  }, outputPackRootUri);
}

export function sortResourceLayerDescriptors(
  layers: readonly ResourceLayerDescriptor[]
): ResourceLayerDescriptor[] {
  return [...layers].sort((left, right) =>
    left.priority - right.priority
    || left.layerId.localeCompare(right.layerId, "en")
  );
}

function assertLayerCombination(role: ResourceLayerRole, source: ResourceLayerSource): void {
  if (role === "local" && source !== "directory") {
    throw new ResourceLayerConfigurationError("The local resource layer must use a directory source.");
  }
  if ((source === "clientJar" || source === "assetIndex") && role !== "vanilla") {
    throw new ResourceLayerConfigurationError(`${source} is only valid for a vanilla resource layer.`);
  }
}

function normalizePriority(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value)) {
    throw new ResourceLayerConfigurationError("Resource layer priority must be a safe integer.");
  }
  return value;
}
