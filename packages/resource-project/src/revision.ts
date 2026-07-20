import type { ResourcePackProjectContextDto, SerializedResourceUri } from "./types";
import { resourceProjectUriIdentity } from "./uri";

export function createStableResourceProjectRevision(prefix: string, value: unknown): string {
  return `${prefix}-${fnv1a64(stableSerialize(value))}`;
}

export function createResourceProjectId(input: {
  projectRootUri: SerializedResourceUri;
  outputPackRootUri: SerializedResourceUri;
  rsglSourceRootUris: readonly SerializedResourceUri[];
}): string {
  return createStableResourceProjectRevision("project", {
    projectRootUri: resourceProjectUriIdentity(input.projectRootUri),
    outputPackRootUri: resourceProjectUriIdentity(input.outputPackRootUri),
    rsglSourceRootUris: [...input.rsglSourceRootUris]
      .map(resourceProjectUriIdentity)
      .sort((left, right) => left.localeCompare(right, "en"))
  });
}

export function createResourceProjectContextRevision(
  context: Omit<ResourcePackProjectContextDto, "contextRevision">
): string {
  return createStableResourceProjectRevision("context", {
    ...context,
    workspaceFolderUri: resourceProjectUriIdentity(context.workspaceFolderUri),
    projectRootUri: resourceProjectUriIdentity(context.projectRootUri),
    packRootUri: resourceProjectUriIdentity(context.packRootUri),
    assetsRootUri: resourceProjectUriIdentity(context.assetsRootUri),
    rsglSourceRootUris: context.rsglSourceRootUris.map(resourceProjectUriIdentity),
    outputPackRootUri: resourceProjectUriIdentity(context.outputPackRootUri),
    outputAssetsRootUri: resourceProjectUriIdentity(context.outputAssetsRootUri),
    localLayer: layerRevisionIdentity(context.localLayer),
    vanillaLayer: context.vanillaLayer ? layerRevisionIdentity(context.vanillaLayer) : undefined,
    externalLayers: context.externalLayers.map(layerRevisionIdentity)
  });
}

function layerRevisionIdentity(layer: ResourcePackProjectContextDto["localLayer"]): unknown {
  return { ...layer, rootUri: resourceProjectUriIdentity(layer.rootUri) };
}

function stableSerialize(value: unknown): string {
  return JSON.stringify(normalizeStableValue(value));
}

function normalizeStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeStableValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right, "en"))) {
      if (record[key] !== undefined) {
        result[key] = normalizeStableValue(record[key]);
      }
    }
    return result;
  }
  return value;
}

function fnv1a64(value: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    for (const byte of utf8Bytes(codePoint)) {
      hash ^= BigInt(byte);
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
  }
  return hash.toString(16).padStart(16, "0");
}

function utf8Bytes(codePoint: number): number[] {
  if (codePoint <= 0x7f) {
    return [codePoint];
  }
  if (codePoint <= 0x7ff) {
    return [0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f)];
  }
  if (codePoint <= 0xffff) {
    return [
      0xe0 | (codePoint >> 12),
      0x80 | ((codePoint >> 6) & 0x3f),
      0x80 | (codePoint & 0x3f)
    ];
  }
  return [
    0xf0 | (codePoint >> 18),
    0x80 | ((codePoint >> 12) & 0x3f),
    0x80 | ((codePoint >> 6) & 0x3f),
    0x80 | (codePoint & 0x3f)
  ];
}
