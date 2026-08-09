import * as vscode from "vscode";
import type { ResourcePackProjectContextDto } from "../../packages/resource-project/src";
import type {
  ResourcePackProjectService,
  RsglProjectApplicability
} from "../resourceProject";
import { physicalProviderId, rsglGeneratedProviderId } from "../resourceUniverse/core/providerIds";
import type {
  ResourceProducer,
  ResourceProviderUnavailableReason
} from "../resourceUniverse/core/types";
import type { ResourceUniverseService } from "../resourceUniverse/core/resourceUniverseService";
import { isAbortError } from "../utils/abortError";
import { shouldRequestGeneratedSnapshot } from "./generatedResourceRefreshPolicy";
import { combineResourceFactsCoverage as combineCoverage } from "./resourceFactsCoverage";
import { visibleResourceCoverage } from "./resourceNavigationContext";
import type {
  EnsuredResourceProject,
  GeneratedResourceProjectRefresher,
  UnifiedResourceQueryOptions
} from "./resourceUniverseNavigation";

type ResourceProjectRefreshStore = Pick<
  ResourcePackProjectService,
  "resolveProject" | "getCachedContext" | "getRsglApplicability"
>;

export interface DiscoveredResourceProject {
  readonly context?: ResourcePackProjectContextDto;
  readonly rsglApplicability?: RsglProjectApplicability;
}

/** Owns project discovery, physical revision caching, and lazy generated refresh lifecycle. */
export class ProjectRefreshCoordinator {
  private readonly refreshedContextRevisions = new Map<string, string>();
  private generatedProjectRefresher?: GeneratedResourceProjectRefresher;

  public constructor(
    private readonly projects: ResourceProjectRefreshStore,
    private readonly universe: ResourceUniverseService
  ) {}

  public setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void {
    this.generatedProjectRefresher = refresher;
  }

  public async discoverProjectForUri(uri: vscode.Uri): Promise<DiscoveredResourceProject> {
    try {
      const result = await this.projects.resolveProject(uri.toString());
      return {
        context: result.context,
        rsglApplicability: result.rsglApplicability
      };
    } catch {
      return {};
    }
  }

  public async ensureProjectForUri(
    uri: vscode.Uri,
    options: UnifiedResourceQueryOptions = {}
  ): Promise<EnsuredResourceProject> {
    return this.refreshDiscoveredProject(await this.discoverProjectForUri(uri), options);
  }

  public async refreshDiscoveredProject(
    discovered: DiscoveredResourceProject,
    options: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject> {
    const context = discovered.context;
    if (!context) {
      return {
        coverage: "unavailable",
        rsglApplicability: discovered.rsglApplicability
      };
    }

    let coverage = this.universe.getCoverage(physicalProviderId, context.projectId);
    if (!this.isPhysicalIndexCurrent(context)
      || !coverage
      || coverage.status === "unavailable") {
      try {
        // The physical provider scans the whole project. Keep this canonical
        // scope aligned with coupled generated/physical refreshes.
        const refresh = await this.universe.refreshProviderProject(
          physicalProviderId,
          context.projectId,
          { projectId: context.projectId },
          options.signal,
          options.causeId
        );
        if (refresh.applied) {
          this.refreshedContextRevisions.set(context.projectId, context.contextRevision);
        }
      } catch (error) {
        if (!isAbortError(error) && !options.signal?.aborted) {
          this.invalidateProviderProject(
            physicalProviderId,
            context.projectId,
            "stale",
            options.causeId
          );
        }
      }
      coverage = this.universe.getCoverage(physicalProviderId, context.projectId);
    }

    const coverages = [visibleResourceCoverage(coverage)];
    if (options.includeGenerated && discovered.rsglApplicability !== "none") {
      coverages.push(await this.ensureGeneratedProject(
        context.projectId,
        options.signal,
        options.causeId
      ));
    }
    return {
      context,
      coverage: combineCoverage(coverages),
      rsglApplicability: discovered.rsglApplicability
    };
  }

  public isPhysicalIndexCurrent(context: ResourcePackProjectContextDto): boolean {
    return this.refreshedContextRevisions.get(context.projectId) === context.contextRevision;
  }

  public async ensureProducerProject(
    producer: ResourceProducer,
    options: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject> {
    const context = this.projects.getCachedContext(producer.projectId);
    const anchor = context?.projectRootUri
      ?? producer.sourceOrigins[0]?.uri
      ?? producer.physicalOrigins[0]?.uri;
    return anchor
      ? this.ensureProjectForUri(vscode.Uri.parse(anchor, true), options)
      : {
          context,
          coverage: "unavailable",
          rsglApplicability: this.projects.getRsglApplicability(producer.projectId)
        };
  }

  public applicableProviderIds(
    includeGenerated: boolean,
    projectId?: string,
    discoveredApplicability?: RsglProjectApplicability
  ): string[] {
    const applicability = discoveredApplicability
      ?? (projectId === undefined ? undefined : this.projects.getRsglApplicability(projectId));
    return [
      physicalProviderId,
      ...(includeGenerated && applicability !== "none" ? [rsglGeneratedProviderId] : [])
    ];
  }

  private async ensureGeneratedProject(
    projectId: string,
    signal?: AbortSignal,
    causeId?: symbol
  ): Promise<"authoritative" | "partial" | "unavailable"> {
    if (signal?.aborted) {
      return visibleResourceCoverage(this.universe.getCoverage(rsglGeneratedProviderId, projectId));
    }
    let requestedLazyRegistration = false;
    if (!this.universe.hasProvider(rsglGeneratedProviderId) && this.generatedProjectRefresher) {
      requestedLazyRegistration = true;
      try {
        await this.generatedProjectRefresher(projectId, signal, causeId);
      } catch (error) {
        if (!isAbortError(error) && !signal?.aborted) {
          this.invalidateProviderProject(
            rsglGeneratedProviderId,
            projectId,
            this.universe.hasProvider(rsglGeneratedProviderId)
              ? "lspFailed"
              : "runtimeLoadFailed",
            causeId
          );
        }
      }
    }
    if (!this.universe.hasProvider(rsglGeneratedProviderId)) {
      return "unavailable";
    }

    const current = this.universe.getCoverage(rsglGeneratedProviderId, projectId);
    if (shouldRequestGeneratedSnapshot(current)
      && !requestedLazyRegistration
      && this.generatedProjectRefresher) {
      try {
        await this.generatedProjectRefresher(projectId, signal, causeId);
      } catch (error) {
        if (!isAbortError(error) && !signal?.aborted) {
          this.invalidateProviderProject(rsglGeneratedProviderId, projectId, "lspFailed", causeId);
        }
      }
    }
    return visibleResourceCoverage(this.universe.getCoverage(rsglGeneratedProviderId, projectId));
  }

  private invalidateProviderProject(
    providerId: string,
    projectId: string,
    reason: ResourceProviderUnavailableReason,
    causeId: symbol | undefined
  ): void {
    if (causeId) {
      this.universe.invalidateProviderProject(providerId, projectId, reason, causeId);
    } else {
      this.universe.invalidateProviderProject(providerId, projectId, reason);
    }
  }
}
