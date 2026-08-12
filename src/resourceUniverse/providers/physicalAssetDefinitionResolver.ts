import {
  canonicalizeResourceGraphIdentity,
  minecraftResourceKindDescriptors,
  minecraftResourceOutputPath,
  tryParseMinecraftResourceId,
  type ResourceGraphLogicalKey
} from "../../../packages/mc-assets/src";
import {
  joinResourceProjectUri,
  type ResourceLayerDescriptor,
  type ResourcePackProjectContextDto,
  type SerializedResourceUri
} from "../../../packages/resource-project/src";
import { throwIfAborted } from "../../utils/abortError";
import type { ResourceResolutionScope } from "../core";

export type PhysicalAssetDefinitionLayerRoots =
  | {
      status: "ready";
      /** Effective root order inside this layer, for example overlays before its base assets root. */
      assetsRootUris: readonly SerializedResourceUri[];
    }
  | { status: "unsupported" | "unavailable" };

export type PhysicalAssetDefinitionTargetProbe = "file" | "missing" | "unavailable";

/** Async filesystem boundary for exact physical Definition resolution. */
export interface PhysicalAssetDefinitionResolverHost {
  getOrderedAssetsRootUris(
    context: ResourcePackProjectContextDto,
    layer: ResourceLayerDescriptor,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionLayerRoots>;
  probeTargetUri(
    uri: SerializedResourceUri,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionTargetProbe>;
  isOwnedOutput(projectId: string, outputPath: string): boolean;
}

export interface PhysicalAssetDefinitionRequest {
  context: ResourcePackProjectContextDto;
  target: ResourceGraphLogicalKey;
  scope: ResourceResolutionScope;
}

/** Provider-facing seam used by Definition without requiring a project scan. */
export interface PhysicalAssetDefinitionResolver {
  resolveExactDefinition(
    request: PhysicalAssetDefinitionRequest,
    signal?: AbortSignal
  ): Promise<PhysicalAssetDefinitionResolution>;
  /** Drops topology plans retained for projects affected by a filesystem mutation. */
  invalidateProjects?(projectIds: readonly string[]): void;
  /** Drops every retained topology plan, for example after configuration changes. */
  invalidateAll?(): void;
}

export interface ExactPhysicalAssetDefinition {
  uri: SerializedResourceUri;
  outputPath: string;
  assetsRootUri: SerializedResourceUri;
  layer: ResourceLayerDescriptor;
}

export type PhysicalAssetDefinitionFallbackReason =
  | "invalidTarget"
  | "unsupportedTargetKind"
  | "unsupportedLayer"
  | "unavailableLayer"
  | "unavailableTarget"
  | "ownedOutput";

export type PhysicalAssetDefinitionResolution =
  | {
      status: "resolved";
      target: ResourceGraphLogicalKey;
      definition: ExactPhysicalAssetDefinition;
    }
  | {
      status: "missing";
      target: ResourceGraphLogicalKey;
      outputPath: string;
    }
  | {
      status: "fallback";
      target: ResourceGraphLogicalKey;
      reason: PhysicalAssetDefinitionFallbackReason;
      outputPath?: string;
      layerId?: string;
      uri?: SerializedResourceUri;
    };

const descriptorByKind = new Map(
  minecraftResourceKindDescriptors.map(descriptor => [descriptor.kind, descriptor])
);

/**
 * Resolves one concrete physical target without enumerating a resource layer.
 * A fallback result is deliberately distinct from a certain miss: callers must
 * retain the full provider/index path whenever exact evidence is incomplete.
 */
export async function resolveExactPhysicalAssetDefinition(
  request: PhysicalAssetDefinitionRequest,
  host: PhysicalAssetDefinitionResolverHost,
  signal?: AbortSignal
): Promise<PhysicalAssetDefinitionResolution> {
  throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
  const identity = canonicalizeResourceGraphIdentity(request.target.kind, request.target.id);
  if (!identity) {
    return fallback(request.target, "invalidTarget");
  }

  const target = identity.primaryKey;
  const descriptor = descriptorByKind.get(target.kind);
  if (!descriptor || descriptor.isDirectory || descriptor.extension === null) {
    return fallback(target, "unsupportedTargetKind");
  }
  const resourceId = tryParseMinecraftResourceId(target.id);
  if (!resourceId) {
    return fallback(target, "invalidTarget");
  }

  const outputPath = minecraftResourceOutputPath(
    target.kind,
    resourceId,
    descriptor.extension
  );
  const candidateSegments = [
    resourceId.namespace,
    descriptor.directory,
    `${resourceId.path}.${descriptor.extension}`
  ];
  const probedUris = new Set<SerializedResourceUri>();

  for (const layer of layersForScope(request.context, request.scope)) {
    throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
    const roots = await host.getOrderedAssetsRootUris(request.context, layer, signal);
    throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
    if (roots.status !== "ready") {
      return fallback(
        target,
        roots.status === "unsupported" ? "unsupportedLayer" : "unavailableLayer",
        { outputPath, layerId: layer.layerId }
      );
    }

    for (const assetsRootUri of roots.assetsRootUris) {
      let candidateUri: SerializedResourceUri;
      try {
        candidateUri = joinResourceProjectUri(assetsRootUri, ...candidateSegments);
      } catch {
        return fallback(target, "unavailableLayer", {
          outputPath,
          layerId: layer.layerId
        });
      }
      if (probedUris.has(candidateUri)) {
        continue;
      }
      probedUris.add(candidateUri);

      throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
      const probe = await host.probeTargetUri(candidateUri, signal);
      throwIfAborted(signal, "Physical asset Definition resolution was cancelled.");
      if (probe === "unavailable") {
        return fallback(target, "unavailableTarget", {
          outputPath,
          layerId: layer.layerId,
          uri: candidateUri
        });
      }
      if (probe === "missing") {
        continue;
      }
      if (layer.role === "local" && host.isOwnedOutput(request.context.projectId, outputPath)) {
        return fallback(target, "ownedOutput", {
          outputPath,
          layerId: layer.layerId,
          uri: candidateUri
        });
      }
      return {
        status: "resolved",
        target,
        definition: {
          uri: candidateUri,
          outputPath,
          assetsRootUri,
          layer
        }
      };
    }
  }

  return { status: "missing", target, outputPath };
}

function layersForScope(
  context: ResourcePackProjectContextDto,
  scope: ResourceResolutionScope
): ResourceLayerDescriptor[] {
  if (scope === "local") {
    return [context.localLayer];
  }
  if (scope === "custom") {
    return [...context.externalLayers];
  }
  if (scope === "vanilla") {
    return context.vanillaLayer ? [context.vanillaLayer] : [];
  }
  return [
    context.localLayer,
    ...context.externalLayers,
    ...(context.vanillaLayer ? [context.vanillaLayer] : [])
  ];
}

function fallback(
  target: ResourceGraphLogicalKey,
  reason: PhysicalAssetDefinitionFallbackReason,
  details: Pick<
    Extract<PhysicalAssetDefinitionResolution, { status: "fallback" }>,
    "outputPath" | "layerId" | "uri"
  > = {}
): Extract<PhysicalAssetDefinitionResolution, { status: "fallback" }> {
  return { status: "fallback", target, reason, ...details };
}
