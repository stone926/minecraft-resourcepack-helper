import { physicalProviderId } from "../resourceUniverse/core/providerIds";
import { uniqueValues } from "../../packages/mc-assets/src";
import type { SerializedResourceUri } from "../../packages/resource-project/src";
import type { ResourcePackProjectService } from "../resourceProject";
import type { ResourceUniverseService } from "../resourceUniverse";

/** Routes one concrete URI mutation only to already-known consumer projects. */
export class ResourceProjectUniverseInvalidator {
  public constructor(
    private readonly projects: Pick<
      ResourcePackProjectService,
      "findCachedContextsForUri" | "getCachedContexts"
    >,
    private readonly universe: ResourceUniverseService
  ) {}

  public invalidatePhysicalUri(uri: SerializedResourceUri): readonly string[] {
    const projectIds = this.projects.findCachedContextsForUri(uri)
      .map(context => context.projectId);
    const uniqueProjectIds = uniqueValues(projectIds);
    for (const projectId of uniqueProjectIds) {
      this.universe.invalidateProviderProject(physicalProviderId, projectId, "stale");
    }
    return uniqueProjectIds;
  }

  public invalidateAllKnownProjects(): readonly string[] {
    const projectIds = this.projects.getCachedContexts().map(context => context.projectId);
    for (const projectId of projectIds) {
      this.universe.invalidateProviderProject(physicalProviderId, projectId, "stale");
    }
    return projectIds;
  }
}
