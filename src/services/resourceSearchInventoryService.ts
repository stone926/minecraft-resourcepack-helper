import * as vscode from "vscode";
import { uniqueLogicalKeys, type ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { ResourcePackProjectService } from "../resourceProject";
import { physicalProviderId, rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import type {
  ResourceNavigationResult,
  ResourceNavigationService
} from "../resourceUniverse/navigation/resourceNavigationService";
import {
  combineResourceFactsCoverage as combineCoverage,
  summarizeGeneratedInventoryFacts,
  summarizeLocalPhysicalInventoryFacts
} from "./resourceFactsCoverage";
import { createResourceResolutionContext } from "./resourceNavigationContext";
import type {
  UnifiedResourceCoverage,
  UnifiedResourceInventory,
  UnifiedResourceInventoryOptions,
  UnifiedResourceProducerTarget
} from "./resourceUniverseNavigation";
import type { ProjectRefreshCoordinator } from "./projectRefreshCoordinator";

type ResourceInventoryProjectStore = Pick<
  ResourcePackProjectService,
  "getCachedContexts" | "getCachedContext"
>;

/** Shared inventory aggregation used by search, completion, and graph surfaces. */
export class ResourceSearchInventoryService {
  public constructor(
    private readonly projects: ResourceInventoryProjectStore,
    private readonly universe: ResourceUniverseService,
    private readonly navigation: ResourceNavigationService,
    private readonly refreshCoordinator: ProjectRefreshCoordinator
  ) {}

  public async getKnownResources(
    kinds: readonly string[],
    options: UnifiedResourceInventoryOptions = {}
  ): Promise<UnifiedResourceInventory> {
    const scopedProjectIds = options.projectIds ? new Set(options.projectIds) : null;
    const contexts = this.projects.getCachedContexts()
      .filter(context => !scopedProjectIds || scopedProjectIds.has(context.projectId));
    const requestedKinds = new Set(kinds);
    const cachedProjectIds = new Set(contexts.map(context => context.projectId));
    const coverages: UnifiedResourceCoverage[] = scopedProjectIds
      ? [...scopedProjectIds]
          .filter(projectId => !cachedProjectIds.has(projectId))
          .map(() => "unavailable" as const)
      : [];
    const resources: UnifiedResourceProducerTarget[] = [];

    for (const context of contexts) {
      if (options.signal?.aborted) {
        break;
      }
      const ensured = await this.refreshCoordinator.ensureProjectForUri(
        vscode.Uri.parse(context.projectRootUri, true),
        {
          includeGenerated: true,
          signal: options.signal,
          causeId: options.causeId
        }
      );
      coverages.push(summarizeLocalPhysicalInventoryFacts(
        this.universe.getCoverage(physicalProviderId, context.projectId),
        context.outputPackRootUri
      ));
      if (ensured.rsglApplicability !== "none") {
        coverages.push(summarizeGeneratedInventoryFacts(
          this.universe.getCoverage(rsglGeneratedProviderId, context.projectId)
        ));
      }

      const targets = uniqueLogicalKeys(this.universe.getProjectProducers(context.projectId)
        .filter(producer => producer.layerRole === "local")
        .flatMap(producer => producer.logicalKeys)
        .filter(target => requestedKinds.has(target.kind)));
      for (const target of targets) {
        const navigation = this.navigation.resolveDefinition(
          target,
          createResourceResolutionContext(
            context,
            this.refreshCoordinator.applicableProviderIds(
              true,
              context.projectId,
              ensured.rsglApplicability
            )
          )
        );
        resources.push(...projectNavigationResources(target, navigation));
      }
    }
    return {
      resources: uniqueProducerTargets(resources),
      coverage: combineCoverage(coverages)
    };
  }

  public getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined {
    const producer = this.universe.getProducer(producerId);
    if (!producer) {
      return undefined;
    }
    const context = this.projects.getCachedContext(producer.projectId);
    if (!context) {
      return undefined;
    }
    const navigation = this.navigation.resolveDefinition(
      target,
      createResourceResolutionContext(
        context,
        this.refreshCoordinator.applicableProviderIds(true, producer.projectId)
      )
    );
    return projectNavigationResources(target, navigation)
      .find(resource => resource.producer.producerId === producerId);
  }
}

function projectNavigationResources(
  target: ResourceGraphLogicalKey,
  navigation: ResourceNavigationResult
): UnifiedResourceProducerTarget[] {
  const candidates = navigation.status === "resolved"
    ? [navigation.producer]
    : navigation.candidates;
  return candidates.map(producer => ({
    target,
    producer,
    candidates,
    resolutionStatus: navigation.status
  }));
}

function uniqueProducerTargets(
  resources: readonly UnifiedResourceProducerTarget[]
): UnifiedResourceProducerTarget[] {
  return [...new Map(resources.map(resource => [
    `${resource.target.kind}\0${resource.target.id}\0${resource.producer.producerId}`,
    resource
  ])).values()].sort((left, right) =>
    left.target.id.localeCompare(right.target.id, "en")
    || left.producer.producerId.localeCompare(right.producer.producerId, "en")
  );
}
