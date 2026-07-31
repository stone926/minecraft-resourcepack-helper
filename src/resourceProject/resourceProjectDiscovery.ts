import {
  createResourceProjectContextRevision,
  createStableResourceProjectRevision,
  isResourceProjectUriWithin,
  joinResourceProjectUri,
  normalizeResourceProjectUri,
  resolveResourcePackProjectContext,
  resourceProjectUriDepth,
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type ResourcePackProjectContextDto,
  type ResourceProjectConfigurationDto,
  type ResourceProjectFileType,
  type ResourceProjectTopologyHost,
  type SerializedResourceUri
} from "../../packages/resource-project/src";
import { packMetadataFileName, rsglProjectConfigFileName } from "../../packages/resource-project/src";
import { parseResourceProjectConfiguration } from "./projectConfiguration";
import type {
  ResourcePackProjectDiscoveryOptions,
  ResourcePackProjectServiceDiagnostic,
  ResourcePackProjectServiceHost,
  ResourcePackProjectServiceResult,
  RsglProjectApplicability,
  ResourceProjectWorkspaceFolder
} from "./types";

const defaultMaxStatProbes = 96;
const projectConfigurationFileName = rsglProjectConfigFileName;

interface ProjectConfigurationDiscovery {
  configuration?: ResourceProjectConfigurationDto;
  contentRevision?: string;
  blockingError?: boolean;
  diagnostics: ResourcePackProjectServiceDiagnostic[];
}

/** Resolves one source without enumerating workspace contents. */
export async function discoverResourcePackProject(
  sourceUriValue: SerializedResourceUri,
  workspaceFolders: readonly ResourceProjectWorkspaceFolder[],
  host: Pick<ResourcePackProjectServiceHost, "stat" | "readTextFile">,
  options: ResourcePackProjectDiscoveryOptions = {}
): Promise<ResourcePackProjectServiceResult> {
  let sourceUri: SerializedResourceUri;
  try {
    sourceUri = normalizeResourceProjectUri(sourceUriValue);
  } catch (error) {
    return {
      diagnostics: [{
        code: "resourceProject.invalidUri",
        severity: "error",
        message: error instanceof Error ? error.message : String(error)
      }],
      rsglApplicability: "none",
      dependencyUris: []
    };
  }

  const dependencyUris = new Map<string, SerializedResourceUri>();
  const topologyHost = new BoundedTopologyHost(
    host,
    dependencyUris,
    normalizeProbeLimit(options.maxStatProbes)
  );
  const normalizedFolders = normalizeWorkspaceFolders(workspaceFolders);
  const owningFolder = selectOwningWorkspaceFolder(sourceUri, normalizedFolders);
  const scopedFolders = owningFolder ? [owningFolder] : normalizedFolders;
  const configurationDiscovery = await discoverNearestProjectConfiguration(
    sourceUri,
    owningFolder?.uri,
    topologyHost,
    host,
    dependencyUris
  );
  const diagnostics = [...configurationDiscovery.diagnostics];
  if (configurationDiscovery.blockingError) {
    return {
      diagnostics,
      rsglApplicability: "configured",
      dependencyUris: [...dependencyUris.values()]
    };
  }
  const resolution = await resolveResourcePackProjectContext({
    sourceUri,
    workspaceFolderUris: scopedFolders.map(folder => folder.uri),
    configuration: configurationDiscovery.configuration,
    sharedConfiguration: owningFolder?.sharedConfiguration
  }, topologyHost);
  diagnostics.push(...resolution.diagnostics);

  let context = resolution.context;
  let rsglApplicability: RsglProjectApplicability = configurationDiscovery.configuration
    ? "configured"
    : "none";
  if (context) {
    if (!configurationDiscovery.configuration) {
      rsglApplicability = await hasConventionalRsglSourceRoot(context, topologyHost)
        ? "conventional"
        : "none";
    }
    const packMetadataUri = joinResourceProjectUri(context.outputPackRootUri, packMetadataFileName);
    rememberDependency(dependencyUris, packMetadataUri);
    const packMetadata = await host.readTextFile(packMetadataUri);
    context = withHostRevisions(
      context,
      configurationDiscovery.contentRevision,
      packMetadata?.revision ?? "missing"
    );
  }

  if (topologyHost.limitExceeded) {
    diagnostics.push({
      code: "resourceProject.probeLimitExceeded",
      severity: "warning",
      message: `Resource project discovery stopped after ${topologyHost.maxProbes} targeted stat probes.`,
      relatedUris: [sourceUri]
    });
  }

  return {
    context,
    rsglApplicability,
    diagnostics,
    dependencyUris: [...dependencyUris.values()]
  };
}

async function hasConventionalRsglSourceRoot(
  context: ResourcePackProjectContextDto,
  host: ResourceProjectTopologyHost
): Promise<boolean> {
  for (const sourceRootUri of context.rsglSourceRootUris) {
    if (await host.stat(sourceRootUri) === "directory") {
      return true;
    }
  }
  return false;
}

function withHostRevisions(
  context: ResourcePackProjectContextDto,
  configFileRevision: string | undefined,
  packMetadataRevision: string
): ResourcePackProjectContextDto {
  const configurationRevision = createStableResourceProjectRevision("configuration", {
    canonicalRevision: context.configurationRevision,
    configFileRevision,
    packMetadataRevision
  });
  const localLayer = {
    ...context.localLayer,
    metadataRevision: createStableResourceProjectRevision("metadata", {
      canonicalRevision: context.localLayer.metadataRevision,
      packMetadataRevision
    })
  };
  const withoutContextRevision: Omit<ResourcePackProjectContextDto, "contextRevision"> = {
    ...context,
    localLayer,
    configurationRevision
  };
  return {
    ...withoutContextRevision,
    contextRevision: createResourceProjectContextRevision(withoutContextRevision)
  };
}

async function discoverNearestProjectConfiguration(
  sourceUri: SerializedResourceUri,
  stopUri: SerializedResourceUri | undefined,
  topologyHost: BoundedTopologyHost,
  host: Pick<ResourcePackProjectServiceHost, "readTextFile">,
  dependencyUris: Map<string, SerializedResourceUri>
): Promise<ProjectConfigurationDiscovery> {
  const diagnostics: ResourcePackProjectServiceDiagnostic[] = [];
  let directory = await topologyHost.stat(sourceUri) === "directory"
    ? sourceUri
    : resourceProjectUriParent(sourceUri);

  while (directory) {
    const candidate = joinResourceProjectUri(directory, projectConfigurationFileName);
    rememberDependency(dependencyUris, candidate);
    if (await topologyHost.stat(candidate) === "file") {
      const file = await host.readTextFile(candidate);
      if (!file) {
        diagnostics.push(invalidConfigurationDiagnostic(
          candidate,
          "The nearest rsgl.config.json could not be read."
        ));
        return { blockingError: true, diagnostics };
      }
      try {
        const configuration = parseResourceProjectConfiguration(candidate, file.text);
        return {
          configuration,
          contentRevision: createStableResourceProjectRevision("config-file", {
            revision: file.revision,
            text: file.text
          }),
          diagnostics
        };
      } catch (error) {
        diagnostics.push(invalidConfigurationDiagnostic(
          candidate,
          error instanceof Error ? error.message : String(error)
        ));
        return { blockingError: true, diagnostics };
      }
    }

    if (stopUri && resourceProjectUriIdentity(directory) === resourceProjectUriIdentity(stopUri)) {
      break;
    }
    directory = resourceProjectUriParent(directory);
  }
  return { diagnostics };
}

function invalidConfigurationDiagnostic(
  configUri: SerializedResourceUri,
  message: string
): ResourcePackProjectServiceDiagnostic {
  return {
    code: "resourceProject.invalidConfiguration",
    severity: "error",
    message,
    relatedUris: [configUri]
  };
}

class BoundedTopologyHost implements ResourceProjectTopologyHost {
  private readonly results = new Map<string, ResourceProjectFileType | null>();
  private probeCount = 0;
  public limitExceeded = false;

  public constructor(
    private readonly host: Pick<ResourcePackProjectServiceHost, "stat">,
    private readonly dependencies: Map<string, SerializedResourceUri>,
    public readonly maxProbes: number
  ) {}

  public async stat(uri: SerializedResourceUri): Promise<ResourceProjectFileType | null> {
    const normalized = normalizeResourceProjectUri(uri);
    const identity = resourceProjectUriIdentity(normalized);
    rememberDependency(this.dependencies, normalized);
    if (this.results.has(identity)) {
      return this.results.get(identity) ?? null;
    }
    if (this.probeCount >= this.maxProbes) {
      this.limitExceeded = true;
      this.results.set(identity, null);
      return null;
    }
    this.probeCount++;
    const result = await this.host.stat(normalized);
    this.results.set(identity, result);
    return result;
  }
}

function selectOwningWorkspaceFolder(
  sourceUri: SerializedResourceUri,
  workspaceFolders: readonly ResourceProjectWorkspaceFolder[]
): ResourceProjectWorkspaceFolder | undefined {
  return workspaceFolders
    .filter(folder => isResourceProjectUriWithin(sourceUri, folder.uri))
    .sort((left, right) => resourceProjectUriDepth(right.uri) - resourceProjectUriDepth(left.uri))[0];
}

function normalizeWorkspaceFolders(
  workspaceFolders: readonly ResourceProjectWorkspaceFolder[]
): ResourceProjectWorkspaceFolder[] {
  const result = new Map<string, ResourceProjectWorkspaceFolder>();
  for (const folder of workspaceFolders) {
    const uri = normalizeResourceProjectUri(folder.uri);
    result.set(resourceProjectUriIdentity(uri), { ...folder, uri });
  }
  return [...result.values()];
}

function rememberDependency(
  dependencies: Map<string, SerializedResourceUri>,
  uri: SerializedResourceUri
): void {
  const normalized = normalizeResourceProjectUri(uri);
  dependencies.set(resourceProjectUriIdentity(normalized), normalized);
}

function normalizeProbeLimit(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? defaultMaxStatProbes
    : Math.max(1, Math.floor(value));
}
