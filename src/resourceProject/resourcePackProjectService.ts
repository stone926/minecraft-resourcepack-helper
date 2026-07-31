import {
  isResourceProjectUriWithin,
  normalizeResourceProjectUri,
  resourceProjectUriBasename,
  resourceProjectUriIdentity,
  resourceProjectUriParent,
  type ResourcePackProjectContextDto,
  type SerializedResourceUri
} from "../../packages/resource-project/src";
import { isResourceProjectAnchorFileName } from "../../packages/resource-project/src";
import { discoverResourcePackProject } from "./resourceProjectDiscovery";
import type {
  ResourcePackProjectDiscoveryOptions,
  ResourcePackProjectServiceHost,
  ResourcePackProjectServiceResult,
  RsglProjectApplicability
} from "./types";

interface CachedProjectResolution {
  generation: number;
  sourceUri: SerializedResourceUri;
  workspaceConfigurationSignature: string;
  dependencyIdentities: Set<string>;
  promise: Promise<ResourcePackProjectServiceResult>;
  context?: ResourcePackProjectContextDto;
}

/**
 * Project-scoped cache over pure canonical discovery. Cache invalidation is
 * dependency based; it never performs a workspace glob or background scan.
 */
export class ResourcePackProjectService {
  private readonly entries = new Map<string, CachedProjectResolution>();
  private readonly contextsByProjectId = new Map<string, ResourcePackProjectContextDto>();
  private readonly rsglApplicabilityByProjectId = new Map<string, RsglProjectApplicability>();
  private generation = 0;

  public constructor(
    private readonly host: ResourcePackProjectServiceHost,
    private readonly options: ResourcePackProjectDiscoveryOptions = {}
  ) {}

  public resolveProject(sourceUriValue: SerializedResourceUri): Promise<ResourcePackProjectServiceResult> {
    const sourceUri = normalizeResourceProjectUri(sourceUriValue);
    const key = resourceProjectUriIdentity(sourceUri);
    const workspaceFolders = this.host.getWorkspaceFolders();
    const workspaceConfigurationSignature = configurationSignature(workspaceFolders);
    const cached = this.entries.get(key);
    if (cached && cached.workspaceConfigurationSignature === workspaceConfigurationSignature) {
      return cached.promise;
    }
    if (cached?.context) {
      this.contextsByProjectId.delete(cached.context.projectId);
      this.rsglApplicabilityByProjectId.delete(cached.context.projectId);
    }

    const generation = ++this.generation;
    const entry: CachedProjectResolution = {
      generation,
      sourceUri,
      workspaceConfigurationSignature,
      dependencyIdentities: new Set(),
      promise: Promise.resolve({
        diagnostics: [],
        rsglApplicability: "none",
        dependencyUris: []
      })
    };
    const promise = discoverResourcePackProject(
      sourceUri,
      workspaceFolders,
      this.host,
      this.options
    ).then(result => {
      entry.dependencyIdentities = new Set(result.dependencyUris.map(resourceProjectUriIdentity));
      entry.context = result.context;
      if (this.entries.get(key)?.generation === generation && result.context) {
        this.contextsByProjectId.set(result.context.projectId, result.context);
        this.rsglApplicabilityByProjectId.set(
          result.context.projectId,
          result.rsglApplicability
        );
      }
      return result;
    }).catch(error => {
      if (this.entries.get(key)?.generation === generation) {
        this.entries.delete(key);
      }
      throw error;
    });
    entry.promise = promise;
    this.entries.set(key, entry);
    return promise;
  }

  public getCachedContext(projectId: string): ResourcePackProjectContextDto | undefined {
    return this.contextsByProjectId.get(projectId);
  }

  public getCachedContexts(): readonly ResourcePackProjectContextDto[] {
    return [...this.contextsByProjectId.values()];
  }

  /** Reads the last bounded applicability probe without starting discovery or RSGL runtime. */
  public getRsglApplicability(projectId: string): RsglProjectApplicability | undefined {
    return this.rsglApplicabilityByProjectId.get(projectId);
  }

  /** Finds already-known consumer projects affected by a local or configured-layer URI. */
  public findCachedContextsForUri(
    uriValue: SerializedResourceUri
  ): readonly ResourcePackProjectContextDto[] {
    const uri = normalizeResourceProjectUri(uriValue);
    return this.getCachedContexts().filter(context => [
      context.projectRootUri,
      context.outputPackRootUri,
      ...context.rsglSourceRootUris,
      ...context.externalLayers.map(layer => layer.rootUri),
      ...(context.vanillaLayer ? [context.vanillaLayer.rootUri] : [])
    ].some(rootUri => isResourceProjectUriWithin(uri, rootUri)));
  }

  /** Returns the project ids whose cached topology was invalidated. */
  public invalidateUri(uriValue: SerializedResourceUri): readonly string[] {
    const uri = normalizeResourceProjectUri(uriValue);
    const identity = resourceProjectUriIdentity(uri);
    const basename = resourceProjectUriBasename(uri).toLowerCase();
    const invalidatedProjectIds = new Set<string>();
    for (const [key, entry] of this.entries) {
      const parent = resourceProjectUriParent(uri);
      const newProjectMetadataCouldShadow = parent !== null
        && isResourceProjectAnchorFileName(basename)
        && isResourceProjectUriWithin(entry.sourceUri, parent);
      if (!entry.dependencyIdentities.has(identity) && !newProjectMetadataCouldShadow) {
        continue;
      }
      if (entry.context) {
        invalidatedProjectIds.add(entry.context.projectId);
        this.contextsByProjectId.delete(entry.context.projectId);
        this.rsglApplicabilityByProjectId.delete(entry.context.projectId);
      }
      this.entries.delete(key);
    }
    return [...invalidatedProjectIds];
  }

  public invalidateWorkspaceConfiguration(
    workspaceFolderUri?: SerializedResourceUri
  ): readonly string[] {
    if (!workspaceFolderUri) {
      return this.invalidateAll();
    }
    const normalized = normalizeResourceProjectUri(workspaceFolderUri);
    const invalidated = new Set<string>();
    for (const [key, entry] of this.entries) {
      if (entry.context?.workspaceFolderUri !== normalized) {
        continue;
      }
      invalidated.add(entry.context.projectId);
      this.contextsByProjectId.delete(entry.context.projectId);
      this.rsglApplicabilityByProjectId.delete(entry.context.projectId);
      this.entries.delete(key);
    }
    return [...invalidated];
  }

  public invalidateAll(): readonly string[] {
    const projectIds = [...this.contextsByProjectId.keys()];
    this.entries.clear();
    this.contextsByProjectId.clear();
    this.rsglApplicabilityByProjectId.clear();
    return projectIds;
  }

  public dispose(): void {
    this.invalidateAll();
  }
}

function configurationSignature(
  folders: ReturnType<ResourcePackProjectServiceHost["getWorkspaceFolders"]>
): string {
  return folders
    .map(folder => `${resourceProjectUriIdentity(folder.uri)}\0${folder.configurationRevision}`)
    .sort((left, right) => left.localeCompare(right, "en"))
    .join("\x01");
}
