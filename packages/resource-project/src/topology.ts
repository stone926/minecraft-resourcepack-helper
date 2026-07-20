import {
  createLocalResourceLayerDescriptor,
  createResourceLayerDescriptor,
  ResourceLayerConfigurationError,
  sortResourceLayerDescriptors
} from "./layers";
import {
  createResourceProjectContextRevision,
  createResourceProjectId,
  createStableResourceProjectRevision
} from "./revision";
import type {
  ResourcePackProjectContextDto,
  ResourceProjectDiagnostic,
  ResourceProjectResolutionRequest,
  ResourceProjectResolutionResult,
  ResourceProjectTopologyHost,
  SerializedResourceUri
} from "./types";
import {
  compareResourceProjectUris,
  isResourceProjectUriWithin,
  joinResourceProjectUri,
  normalizeResourceProjectUri,
  resolveResourceProjectUri,
  resourceProjectUriIdentity,
  resourceProjectUriBasename,
  resourceProjectUriDepth,
  resourceProjectUriParent
} from "./uri";

const conventionalSourceRootNames = new Set(["rsgl", "src"]);

export async function resolveResourcePackProjectContext(
  request: ResourceProjectResolutionRequest,
  host: ResourceProjectTopologyHost
): Promise<ResourceProjectResolutionResult> {
  const diagnostics: ResourceProjectDiagnostic[] = [];
  let sourceUri: SerializedResourceUri;
  let workspaceFolderUris: SerializedResourceUri[];
  let configUri: SerializedResourceUri | undefined;
  try {
    sourceUri = normalizeResourceProjectUri(request.sourceUri);
    workspaceFolderUris = uniqueUris(request.workspaceFolderUris);
    configUri = request.configuration
      ? normalizeResourceProjectUri(request.configuration.configUri)
      : undefined;
  } catch (error) {
    return {
      diagnostics: [{
        code: "resourceProject.invalidUri",
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }

  let projectRootUri: SerializedResourceUri | undefined;
  if (configUri) {
    const parent = resourceProjectUriParent(configUri);
    if (!parent) {
      return {
        diagnostics: [{
          code: "resourceProject.invalidUri",
          severity: "error",
          message: `Project configuration URI has no parent: ${configUri}`,
          relatedUris: [configUri]
        }]
      };
    }
    projectRootUri = parent;
  }

  const configuredOutputUri = request.configuration?.outDir && projectRootUri
    ? resolveResourceProjectUri(projectRootUri, request.configuration.outDir)
    : undefined;
  if (configuredOutputUri && resourceProjectUriBasename(configuredOutputUri).toLowerCase() === "assets") {
    diagnostics.push({
      code: "resourceProject.outputMustBePackRoot",
      severity: "error",
      message: "RSGL outDir must identify the resource-pack root, not its assets directory.",
      relatedUris: [configuredOutputUri]
    });
    return { diagnostics };
  }

  const outputPackRootUri = configuredOutputUri
    ?? await discoverPackRoot(sourceUri, workspaceFolderUris, host, diagnostics);
  if (!outputPackRootUri) {
    return { diagnostics };
  }

  const effectiveProjectRootUri = projectRootUri ?? outputPackRootUri;
  const rsglSourceRootUri = request.configuration?.root && projectRootUri
    ? resolveResourceProjectUri(projectRootUri, request.configuration.root)
    : await inferRsglSourceRoot(sourceUri, effectiveProjectRootUri, host);
  if (request.configuration?.root && !isResourceProjectUriWithin(sourceUri, rsglSourceRootUri)) {
    diagnostics.push({
      code: "resourceProject.sourceOutsideConfiguredRoot",
      severity: "warning",
      message: "The source URI is outside the configured RSGL root.",
      relatedUris: [sourceUri, rsglSourceRootUri]
    });
  }
  const workspaceFolderUri = selectWorkspaceFolder(
    effectiveProjectRootUri,
    sourceUri,
    workspaceFolderUris
  ) ?? effectiveProjectRootUri;
  const localLayer = createLocalResourceLayerDescriptor(outputPackRootUri);

  let vanillaLayer;
  let externalLayers;
  try {
    const vanillaConfiguration = request.configuration?.vanillaLayer !== undefined
      ? request.configuration.vanillaLayer
      : request.sharedConfiguration?.vanillaLayer;
    if (vanillaConfiguration && vanillaConfiguration.role !== "vanilla") {
      throw new ResourceLayerConfigurationError("The vanilla layer must use role 'vanilla'.");
    }
    vanillaLayer = vanillaConfiguration
      ? createResourceLayerDescriptor(vanillaConfiguration, effectiveProjectRootUri)
      : undefined;
    const externalConfigurations = request.configuration?.externalLayers
      ?? request.sharedConfiguration?.externalLayers
      ?? [];
    if (externalConfigurations.some(configuration => configuration.role !== "custom")) {
      throw new ResourceLayerConfigurationError("External pack layers must use role 'custom'.");
    }
    externalLayers = sortResourceLayerDescriptors(externalConfigurations.map(configuration =>
      createResourceLayerDescriptor(configuration, effectiveProjectRootUri)
    ));
    assertUniqueLayerIds([localLayer, ...(vanillaLayer ? [vanillaLayer] : []), ...externalLayers]);
  } catch (error) {
    diagnostics.push({
      code: "resourceProject.invalidLayer",
      severity: "error",
      message: error instanceof ResourceLayerConfigurationError
        ? error.message
        : error instanceof Error ? error.message : String(error)
    });
    return { diagnostics };
  }

  const overlaySelection = [...(
    request.configuration?.overlaySelection
    ?? request.sharedConfiguration?.overlaySelection
    ?? []
  )];
  const configurationRevision = createStableResourceProjectRevision("configuration", {
    configUri: configUri ? resourceProjectUriIdentity(configUri) : undefined,
    rootUri: resourceProjectUriIdentity(rsglSourceRootUri),
    outputPackRootUri: resourceProjectUriIdentity(outputPackRootUri),
    targetPackFormat: request.configuration?.targetPackFormat,
    vanillaLayer: vanillaLayer ? layerRevisionValue(vanillaLayer) : undefined,
    externalLayers: externalLayers.map(layerRevisionValue),
    overlaySelection
  });
  const projectId = createResourceProjectId({
    projectRootUri: effectiveProjectRootUri,
    outputPackRootUri,
    rsglSourceRootUris: [rsglSourceRootUri]
  });
  const contextWithoutRevision: Omit<ResourcePackProjectContextDto, "contextRevision"> = {
    projectId,
    workspaceFolderUri,
    projectRootUri: effectiveProjectRootUri,
    packRootUri: outputPackRootUri,
    assetsRootUri: joinResourceProjectUri(outputPackRootUri, "assets"),
    rsglSourceRootUris: [rsglSourceRootUri],
    outputPackRootUri,
    outputAssetsRootUri: joinResourceProjectUri(outputPackRootUri, "assets"),
    targetPackFormat: request.configuration?.targetPackFormat,
    localLayer,
    vanillaLayer,
    externalLayers,
    overlaySelection,
    configurationRevision
  };
  return {
    context: {
      ...contextWithoutRevision,
      contextRevision: createResourceProjectContextRevision(contextWithoutRevision)
    },
    diagnostics
  };
}

async function discoverPackRoot(
  sourceUri: SerializedResourceUri,
  workspaceFolderUris: readonly SerializedResourceUri[],
  host: ResourceProjectTopologyHost,
  diagnostics: ResourceProjectDiagnostic[]
): Promise<SerializedResourceUri | null> {
  const nearest = await findNearestPackRoot(sourceUri, host);
  if (nearest) {
    return nearest;
  }

  const candidates: SerializedResourceUri[] = [];
  for (const workspaceFolderUri of workspaceFolderUris) {
    if (await isPackRoot(workspaceFolderUri, host)) {
      candidates.push(workspaceFolderUri);
    }
  }
  const uniqueCandidates = uniqueUris(candidates);
  if (uniqueCandidates.length === 1) {
    return uniqueCandidates[0];
  }
  if (uniqueCandidates.length > 1) {
    diagnostics.push({
      code: "resourceProject.ambiguousPackRoot",
      severity: "error",
      message: "Multiple workspace folders are valid resource-pack roots; configure outDir explicitly.",
      relatedUris: uniqueCandidates
    });
    return null;
  }
  diagnostics.push({
    code: "resourceProject.packRootNotFound",
    severity: "error",
    message: "No resource-pack root containing pack.mcmeta could be resolved.",
    relatedUris: [sourceUri]
  });
  return null;
}

async function findNearestPackRoot(
  sourceUri: SerializedResourceUri,
  host: ResourceProjectTopologyHost
): Promise<SerializedResourceUri | null> {
  let candidate = await host.stat(sourceUri) === "directory"
    ? sourceUri
    : resourceProjectUriParent(sourceUri);
  while (candidate) {
    if (await isPackRoot(candidate, host)) {
      return candidate;
    }
    candidate = resourceProjectUriParent(candidate);
  }
  return null;
}

async function isPackRoot(
  candidateUri: SerializedResourceUri,
  host: ResourceProjectTopologyHost
): Promise<boolean> {
  return await host.stat(joinResourceProjectUri(candidateUri, "pack.mcmeta")) === "file";
}

async function inferRsglSourceRoot(
  sourceUri: SerializedResourceUri,
  projectRootUri: SerializedResourceUri,
  host: ResourceProjectTopologyHost
): Promise<SerializedResourceUri> {
  const sourceType = await host.stat(sourceUri);
  const sourceBasename = resourceProjectUriBasename(sourceUri).toLowerCase();
  const sourceIsRsgl = sourceBasename.endsWith(".rsgl");
  let candidate: SerializedResourceUri | null = sourceType === "directory"
    ? sourceUri
    : resourceProjectUriParent(sourceUri);
  if (sourceIsRsgl || conventionalSourceRootNames.has(sourceBasename)) {
    while (candidate) {
      if (conventionalSourceRootNames.has(resourceProjectUriBasename(candidate).toLowerCase())) {
        return candidate;
      }
      if (resourceProjectUriIdentity(candidate) === resourceProjectUriIdentity(projectRootUri)) {
        break;
      }
      candidate = resourceProjectUriParent(candidate);
    }
  }

  const conventionalCandidates = [...conventionalSourceRootNames]
    .map(name => joinResourceProjectUri(projectRootUri, name));
  for (const conventionalCandidate of conventionalCandidates) {
    if (await host.stat(conventionalCandidate) === "directory") {
      return conventionalCandidate;
    }
  }
  if (sourceIsRsgl) {
    return resourceProjectUriParent(sourceUri) ?? sourceUri;
  }
  return conventionalCandidates[0];
}

function selectWorkspaceFolder(
  projectRootUri: SerializedResourceUri,
  sourceUri: SerializedResourceUri,
  workspaceFolderUris: readonly SerializedResourceUri[]
): SerializedResourceUri | null {
  const containing = workspaceFolderUris.filter(uri =>
    isResourceProjectUriWithin(projectRootUri, uri)
    || isResourceProjectUriWithin(sourceUri, uri)
  );
  return containing.sort((left, right) =>
    resourceProjectUriDepth(right) - resourceProjectUriDepth(left)
    || compareResourceProjectUris(left, right)
  )[0] ?? (workspaceFolderUris.length === 1 ? workspaceFolderUris[0] : null);
}

function uniqueUris(uris: readonly string[]): SerializedResourceUri[] {
  const unique = new Map<string, SerializedResourceUri>();
  for (const uri of uris) {
    const normalized = normalizeResourceProjectUri(uri);
    unique.set(resourceProjectUriIdentity(normalized), normalized);
  }
  return [...unique.values()].sort(compareResourceProjectUris);
}

function assertUniqueLayerIds(layers: readonly { layerId: string }[]): void {
  const seen = new Set<string>();
  for (const layer of layers) {
    if (seen.has(layer.layerId)) {
      throw new ResourceLayerConfigurationError(`Duplicate resource layer id '${layer.layerId}'.`);
    }
    seen.add(layer.layerId);
  }
}

function layerRevisionValue<T extends { rootUri: SerializedResourceUri }>(layer: T): T {
  return { ...layer, rootUri: resourceProjectUriIdentity(layer.rootUri) };
}
