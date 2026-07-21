import type { ResourceProviderRegistration } from "../core/resourceContributionRegistry";
import type {
  ResourceUniverseRefreshResult,
  ResourceUniverseService
} from "../core/resourceUniverseService";
import type { ResourceCoverageScope } from "../core/types";
import {
  RsglGeneratedProvider,
  type RsglGeneratedMaterializationSnapshot
} from "./rsglGeneratedProvider";

/**
 * Small composition seam between the lazy RSGL adapter and ResourceUniverse.
 * It deliberately knows nothing about LanguageClient or VS Code APIs.
 */
export class RsglGeneratedProviderConnection {
  private readonly registration: ResourceProviderRegistration;
  private disposed = false;

  public constructor(
    private readonly universe: ResourceUniverseService,
    public readonly provider: RsglGeneratedProvider
  ) {
    this.registration = universe.registerProvider(provider);
  }

  public refreshProject(
    projectId: string,
    scope: ResourceCoverageScope = { projectId },
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult> {
    this.assertActive();
    return this.universe.refreshProviderProject(
      this.provider.providerId,
      projectId,
      scope,
      signal
    );
  }

  /** Marks only the affected RSGL provider/project stale; siblings remain intact. */
  public acceptInvalidation(value: unknown): boolean {
    this.assertActive();
    const projectId = this.provider.acceptInvalidation(value);
    if (!projectId) {
      return false;
    }
    this.universe.invalidateProviderProject(this.provider.providerId, projectId, "stale");
    return true;
  }

  /**
   * Applies one committed build transaction and reprojects a cached semantic
   * revision through notModified. This produces one Universe replacement.
   */
  public async replaceMaterializations(
    snapshot: RsglGeneratedMaterializationSnapshot,
    scope: ResourceCoverageScope = { projectId: snapshot.projectId },
    signal?: AbortSignal
  ): Promise<ResourceUniverseRefreshResult | undefined> {
    this.assertActive();
    if (!this.provider.replaceMaterializations(snapshot)) {
      return undefined;
    }
    try {
      return await this.refreshProject(snapshot.projectId, scope, signal);
    } catch (error) {
      this.universe.invalidateProviderProject(
        this.provider.providerId,
        snapshot.projectId,
        "stale"
      );
      throw error;
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.registration.dispose();
    this.provider.dispose();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("The RSGL generated provider connection has been disposed.");
    }
  }
}
