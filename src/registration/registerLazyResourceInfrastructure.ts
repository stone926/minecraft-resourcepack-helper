import type * as vscode from "vscode";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { ResourceResolutionScope } from "../resourceUniverse/core/types";
import type {
  ResourceNavigationOptions,
  ResourceNavigationResult
} from "../resourceUniverse/navigation/resourceNavigationService";
import type { ResourceUniverseChangeEvent } from "../resourceUniverse";
import type {
  EnsuredResourceProject,
  GeneratedResourceProjectRefresher,
  ResourceUniverseDocument,
  ResourceUniverseNavigation,
  UnifiedBlockResourceSet,
  UnifiedDocumentProjection,
  UnifiedLogicalDefinitionResolution,
  UnifiedLogicalReferenceLocations,
  UnifiedReferenceResolution,
  UnifiedReferenceSet,
  UnifiedResourceProducerTarget,
  UnifiedResourceQueryOptions
} from "../services/resourceUniverseNavigationFacade";
import type { ResourceReference } from "../utils/resourceReferences";
import type { ResourceInfrastructure } from "./registerResourceInfrastructure";

export interface ResourceNavigationInfrastructure extends vscode.Disposable {
  readonly navigation: ResourceUniverseNavigation;
}

export interface ResourceInfrastructureFactoryModule<
  TResources extends ResourceNavigationInfrastructure
> {
  createResourceInfrastructure(): TResources;
}

export type ResourceInfrastructureModuleLoader<
  TResources extends ResourceNavigationInfrastructure
> = () => Promise<ResourceInfrastructureFactoryModule<TResources>>;

export interface LazyResourceInfrastructureRegistration extends vscode.Disposable {
  readonly navigation: ResourceUniverseNavigation;
  ensureResources(): Promise<ResourceInfrastructure>;
}

interface ResourceChangeBinding {
  readonly listener: (event: ResourceUniverseChangeEvent) => void;
  subscription?: vscode.Disposable;
}

/**
 * Explicit typed adapter over the concrete navigation facade. Async queries
 * trigger infrastructure creation; synchronous composition and invalidation
 * methods remain safe without loading the resource graph.
 */
export class LazyResourceUniverseNavigation implements ResourceUniverseNavigation {
  private readonly changeBindings = new Set<ResourceChangeBinding>();
  private target?: ResourceUniverseNavigation;
  private generatedProjectRefresher?: GeneratedResourceProjectRefresher;
  private disposed = false;

  public constructor(
    private readonly ensureInfrastructure: () => Promise<ResourceNavigationInfrastructure>
  ) {}

  public setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void {
    if (this.disposed) {
      return;
    }
    this.generatedProjectRefresher = refresher;
    this.target?.setGeneratedProjectRefresher(refresher);
  }

  public onDidChangeResources(
    listener: (event: ResourceUniverseChangeEvent) => void
  ): vscode.Disposable {
    if (this.disposed) {
      return { dispose: () => undefined };
    }
    const binding: ResourceChangeBinding = { listener };
    this.changeBindings.add(binding);
    try {
      if (this.target) {
        binding.subscription = this.target.onDidChangeResources(listener);
      }
    } catch (error) {
      this.changeBindings.delete(binding);
      throw error;
    }
    return {
      dispose: () => {
        this.changeBindings.delete(binding);
        binding.subscription?.dispose();
        binding.subscription = undefined;
      }
    };
  }

  public resolveReference(
    document: ResourceUniverseDocument,
    reference: ResourceReference,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceResolution> {
    return this.withNavigation(navigation => navigation.resolveReference(document, reference, options));
  }

  public resolveLogicalDefinition(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    scope: ResourceResolutionScope,
    options?: Omit<UnifiedResourceQueryOptions, "includeGenerated">
  ): Promise<UnifiedLogicalDefinitionResolution> {
    return this.withNavigation(navigation =>
      navigation.resolveLogicalDefinition(sourceUri, target, scope, options)
    );
  }

  public getLogicalIncomingReferenceLocations(
    sourceUri: vscode.Uri,
    target: ResourceGraphLogicalKey,
    options?: Omit<UnifiedResourceQueryOptions, "includeGenerated">
  ): Promise<UnifiedLogicalReferenceLocations> {
    return this.withNavigation(navigation =>
      navigation.getLogicalIncomingReferenceLocations(sourceUri, target, options)
    );
  }

  public getOutgoingReferences(
    document: ResourceUniverseDocument,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet> {
    return this.withNavigation(navigation => navigation.getOutgoingReferences(document, options));
  }

  public getIncomingReferences(
    uri: vscode.Uri,
    relationship?: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet> {
    return this.withNavigation(navigation =>
      navigation.getIncomingReferences(uri, relationship, options)
    );
  }

  public ensureProjectForUri(
    uri: vscode.Uri,
    options?: UnifiedResourceQueryOptions
  ): Promise<EnsuredResourceProject> {
    return this.withNavigation(navigation => navigation.ensureProjectForUri(uri, options));
  }

  public getDocumentProjection(
    document: ResourceUniverseDocument
  ): Promise<UnifiedDocumentProjection> {
    return this.withNavigation(navigation => navigation.getDocumentProjection(document));
  }

  public getKnownResources(
    kinds: readonly string[],
    options?: Parameters<ResourceUniverseNavigation["getKnownResources"]>[1]
  ): ReturnType<ResourceUniverseNavigation["getKnownResources"]> {
    return this.withNavigation(navigation => navigation.getKnownResources(kinds, options));
  }

  public getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined {
    return this.target?.getKnownResource(producerId, target);
  }

  public getKnownBlockstateResources(signal?: AbortSignal): Promise<UnifiedBlockResourceSet> {
    return this.withNavigation(navigation => navigation.getKnownBlockstateResources(signal));
  }

  public getProducerOutgoingReferences(
    producerId: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet> {
    return this.withNavigation(navigation =>
      navigation.getProducerOutgoingReferences(producerId, options)
    );
  }

  public getProducerIncomingReferences(
    producerId: string,
    relationship?: string,
    options?: UnifiedResourceQueryOptions
  ): Promise<UnifiedReferenceSet> {
    return this.withNavigation(navigation =>
      navigation.getProducerIncomingReferences(producerId, relationship, options)
    );
  }

  public resolveProducerNavigation(
    producerId: string,
    target: ResourceGraphLogicalKey,
    options?: ResourceNavigationOptions & UnifiedResourceQueryOptions
  ): Promise<ResourceNavigationResult | undefined> {
    return this.withNavigation(navigation =>
      navigation.resolveProducerNavigation(producerId, target, options)
    );
  }

  public resolveUriNavigation(
    uri: vscode.Uri,
    options?: ResourceNavigationOptions & UnifiedResourceQueryOptions
  ): Promise<ResourceNavigationResult | undefined> {
    return this.withNavigation(navigation => navigation.resolveUriNavigation(uri, options));
  }

  /** No loaded index means there is no cache to invalidate. */
  public invalidateUri(uri: vscode.Uri): readonly string[] {
    return this.target?.invalidateUri(uri) ?? [];
  }

  /** No loaded index means there are no known projects to invalidate. */
  public invalidateAllKnownProjects(): void {
    this.target?.invalidateAllKnownProjects();
  }

  public attach(target: ResourceUniverseNavigation): void {
    if (this.disposed) {
      throw new Error("Lazy resource navigation has been disposed.");
    }
    if (this.target === target) {
      return;
    }
    if (this.target) {
      throw new Error("Lazy resource navigation is already attached.");
    }

    const attachedBindings: ResourceChangeBinding[] = [];
    try {
      if (this.generatedProjectRefresher) {
        target.setGeneratedProjectRefresher(this.generatedProjectRefresher);
      }
      for (const binding of this.changeBindings) {
        binding.subscription = target.onDidChangeResources(binding.listener);
        attachedBindings.push(binding);
      }
      this.target = target;
    } catch (error) {
      for (const binding of attachedBindings.reverse()) {
        binding.subscription?.dispose();
        binding.subscription = undefined;
      }
      throw error;
    }
  }

  public detach(target: ResourceUniverseNavigation): void {
    if (this.target !== target) {
      return;
    }
    this.target = undefined;
    this.disposeSubscriptions();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.target = undefined;
    this.disposeSubscriptions();
    this.changeBindings.clear();
    this.generatedProjectRefresher = undefined;
  }

  private async withNavigation<T>(
    action: (navigation: ResourceUniverseNavigation) => Promise<T>
  ): Promise<T> {
    const infrastructure = await this.ensureInfrastructure();
    return action(infrastructure.navigation);
  }

  private disposeSubscriptions(): void {
    for (const binding of this.changeBindings) {
      binding.subscription?.dispose();
      binding.subscription = undefined;
    }
  }
}

/** Owns one retryable, single-flight concrete infrastructure load. */
export class LazyResourceInfrastructureOwner<
  TResources extends ResourceNavigationInfrastructure
> implements vscode.Disposable {
  public readonly navigation: ResourceUniverseNavigation;
  private readonly navigationAdapter: LazyResourceUniverseNavigation;
  private loadPromise?: Promise<TResources>;
  private loaded?: TResources;
  private disposed = false;

  public constructor(
    private readonly loadModule: ResourceInfrastructureModuleLoader<TResources>
  ) {
    this.navigationAdapter = new LazyResourceUniverseNavigation(() => this.ensureResources());
    this.navigation = this.navigationAdapter;
  }

  public ensureResources(): Promise<TResources> {
    if (this.disposed) {
      return Promise.reject(new Error("Lazy resource infrastructure has been disposed."));
    }
    if (this.loaded) {
      return Promise.resolve(this.loaded);
    }
    if (this.loadPromise) {
      return this.loadPromise;
    }
    const attempt = this.loadConcreteInfrastructure();
    this.loadPromise = attempt;
    void attempt.catch(() => {
      if (!this.disposed && this.loadPromise === attempt) {
        this.loadPromise = undefined;
      }
    });
    return attempt;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.navigationAdapter.dispose();
    const loaded = this.loaded;
    this.loaded = undefined;
    loaded?.dispose();
  }

  private async loadConcreteInfrastructure(): Promise<TResources> {
    const module = await this.loadModule();
    if (this.disposed) {
      throw new Error("Lazy resource infrastructure was disposed while loading.");
    }

    const resources = module.createResourceInfrastructure();
    if (this.disposed) {
      resources.dispose();
      throw new Error("Lazy resource infrastructure was disposed while initializing.");
    }
    try {
      this.navigationAdapter.attach(resources.navigation);
    } catch (error) {
      resources.dispose();
      throw error;
    }
    if (this.disposed) {
      this.navigationAdapter.detach(resources.navigation);
      resources.dispose();
      throw new Error("Lazy resource infrastructure was disposed while initializing.");
    }
    this.loaded = resources;
    return resources;
  }
}

export function registerLazyResourceInfrastructure(
  context: vscode.ExtensionContext
): LazyResourceInfrastructureRegistration {
  const owner = new LazyResourceInfrastructureOwner<ResourceInfrastructure>(
    loadResourceInfrastructureModule
  );
  context.subscriptions.push(owner);
  return owner;
}

async function loadResourceInfrastructureModule(): Promise<
  ResourceInfrastructureFactoryModule<ResourceInfrastructure>
> {
  return import("./registerResourceInfrastructure.js");
}
