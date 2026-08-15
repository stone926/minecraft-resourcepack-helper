import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  normalizeResourceGraphFileSystemPath
} from "../../../packages/mc-assets/src";
import type {
  ResourceEdge,
  ResourceLayerRole,
  ResourceLocation,
  ProviderCoverage,
  ResourceProducer,
  ResourceProviderSnapshot,
  ResourceResolutionScope
} from "../core";

export interface PhysicalResourceReferenceFact {
  targetKind: string;
  value: string;
  target?: string;
  source?: string;
  extension?: string | null;
  scope?: ResourceResolutionScope;
  relationship?: string;
  sourceLocation?: ResourceLocation;
}

export interface PhysicalResourceDocumentFact {
  uri: string;
  fileName: string;
  revision: string;
  layerId: string;
  layerRole: ResourceLayerRole;
  outputPath?: string;
  blockedByLayerIds?: readonly string[];
  references: readonly PhysicalResourceReferenceFact[];
}

export interface PhysicalAssetSnapshotOptions {
  providerId?: string;
  projectId: string;
  generation: number;
  revision: string;
  documents: readonly PhysicalResourceDocumentFact[];
  /** Local manifest-owned outputs are contributed by the materialization provider instead. */
  ownedOutputPaths?: ReadonlySet<string>;
  coverage?: ProviderCoverage;
}

export function createPhysicalAssetSnapshot(
  options: PhysicalAssetSnapshotOptions
): ResourceProviderSnapshot {
  const providerId = options.providerId ?? "physical";
  const producers: ResourceProducer[] = [];
  const edges: ResourceEdge[] = [];
  const ownedOutputPaths = new Set(
    [...(options.ownedOutputPaths ?? [])]
      .map(outputPath => normalizeResourceGraphFileSystemPath(outputPath, { caseSensitive: false }))
      .filter((outputPath): outputPath is string => outputPath !== null)
  );

  for (const document of [...options.documents].sort(compareDocuments)) {
    const outputPath = document.outputPath ?? document.fileName;
    const outputPathIdentity = normalizeResourceGraphFileSystemPath(outputPath, { caseSensitive: false });
    if (
      document.layerRole === "local"
      && outputPathIdentity
      && ownedOutputPaths.has(outputPathIdentity)
    ) {
      continue;
    }
    const identity = canonicalizeResourceGraphOutputPath(outputPath, {
      fileSystemCaseSensitive: false
    });
    const producerId = physicalProducerId(providerId, document.layerId, document.uri);
    const producer: ResourceProducer = {
      producerId,
      providerId,
      projectId: options.projectId,
      layerId: document.layerId,
      layerRole: document.layerRole,
      origin: "physical",
      logicalKeys: identity && identity.primaryKey.kind !== "textureDirectory" ? [identity.primaryKey] : [],
      aliasKeys: identity?.aliasKeys ?? [],
      aggregateMemberships: identity?.primaryKey.kind === "textureDirectory"
        ? [identity.primaryKey, ...identity.aggregateMemberships]
        : identity?.aggregateMemberships ?? [],
      sourceOrigins: [],
      physicalOrigins: [{
        uri: document.uri,
        origin: "physical",
        editable: document.layerRole !== "vanilla" && isEditablePhysicalUri(document.uri)
      }],
      materializationState: "handwritten",
      outputPath: normalizeResourceGraphFileSystemPath(outputPath) ?? outputPath,
      ...(document.blockedByLayerIds?.length
        ? { blockedByLayerIds: [...document.blockedByLayerIds] }
        : {}),
      revision: document.revision
    };
    producers.push(producer);

    document.references.forEach((reference, index) => {
      if (!reference.value || reference.value.startsWith("#")) {
        return;
      }
      const target = canonicalizeResourceGraphIdentity(reference.targetKind, reference.value, {
        extension: reference.extension
      })?.primaryKey;
      if (!target) {
        return;
      }
      edges.push({
        edgeId: physicalEdgeId(producerId, index, target.kind, target.id),
        providerId,
        projectId: options.projectId,
        sourceProducerId: producerId,
        target,
        resolutionScope: reference.scope ?? "effective",
        resolutionContextId: `${options.projectId}:${reference.scope ?? "effective"}`,
        sourceLocation: reference.sourceLocation,
        relationship: reference.relationship,
        origin: "direct",
        sourceReference: reference.target && reference.source ? {
          value: reference.value,
          target: reference.target,
          source: reference.source,
          extension: reference.extension ?? null,
          kind: reference.targetKind
        } : undefined
      });
    });
  }

  return {
    providerId,
    projectId: options.projectId,
    generation: options.generation,
    revision: options.revision,
    coverage: options.coverage ?? {
      status: "authoritative",
      revision: options.revision,
      coveredScope: { projectId: options.projectId }
    },
    producers,
    edges
  };
}

function physicalProducerId(providerId: string, layerId: string, uri: string): string {
  return `${providerId}:${layerId}:${uri}`;
}

function physicalEdgeId(producerId: string, index: number, kind: string, id: string): string {
  return `${producerId}:edge:${index}:${kind}:${id}`;
}

function isEditablePhysicalUri(uri: string): boolean {
  return uri.startsWith("file:") || uri.startsWith("vscode-remote:");
}

function compareDocuments(left: PhysicalResourceDocumentFact, right: PhysicalResourceDocumentFact): number {
  return left.uri.localeCompare(right.uri, "en");
}
