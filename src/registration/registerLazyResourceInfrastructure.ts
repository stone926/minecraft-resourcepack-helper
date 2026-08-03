import type * as vscode from "vscode";
import type { ResourceGraphLogicalKey } from "../../packages/mc-assets/src";
import type { ResourceUniverseChangeEvent } from "../resourceUniverse";
import type {
  GeneratedResourceProjectRefresher,
  ResourceUniverseNavigation,
  UnifiedResourceProducerTarget
} from "../services/resourceUniverseNavigationFacade";
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

  // Async query forwarders. Each signature is taken directly from the
  // navigation contract, so `implements ResourceUniverseNavigation` fails to
  // compile when a contract method is missing here or drifts from it.
  public readonly resolveReference: ResourceUniverseNavigation["resolveReference"] = (...args) =>
    this.withNavigation(navigation => navigation.resolveReference(...args));
  public readonly resolveLogicalDefinition: ResourceUniverseNavigation["resolveLogicalDefinition"] = (...args) =>
    this.withNavigation(navigation => navigation.resolveLogicalDefinition(...args));
  public readonly getLogicalIncomingReferenceLocations: ResourceUniverseNavigation["getLogicalIncomingReferenceLocations"] = (...args) =>
    this.withNavigation(navigation => navigation.getLogicalIncomingReferenceLocations(...args));
  public readonly getOutgoingReferences: ResourceUniverseNavigation["getOutgoingReferences"] = (...args) =>
    this.withNavigation(navigation => navigation.getOutgoingReferences(...args));
  public readonly getIncomingReferences: ResourceUniverseNavigation["getIncomingReferences"] = (...args) =>
    this.withNavigation(navigation => navigation.getIncomingReferences(...args));
  public readonly ensureProjectForUri: ResourceUniverseNavigation["ensureProjectForUri"] = (...args) =>
    this.withNavigation(navigation => navigation.ensureProjectForUri(...args));
  public readonly getDocumentProjection: ResourceUniverseNavigation["getDocumentProjection"] = (...args) =>
    this.withNavigation(navigation => navigation.getDocumentProjection(...args));
  public readonly getKnownResources: ResourceUniverseNavigation["getKnownResources"] = (...args) =>
    this.withNavigation(navigation => navigation.getKnownResources(...args));
  public readonly getProducerOutgoingReferences: ResourceUniverseNavigation["getProducerOutgoingReferences"] = (...args) =>
    this.withNavigation(navigation => navigation.getProducerOutgoingReferences(...args));
  public readonly getProducerIncomingReferences: ResourceUniverseNavigation["getProducerIncomingReferences"] = (...args) =>
    this.withNavigation(navigation => navigation.getProducerIncomingReferences(...args));
  public readonly resolveProducerNavigation: ResourceUniverseNavigation["resolveProducerNavigation"] = (...args) =>
    this.withNavigation(navigation => navigation.resolveProducerNavigation(...args));
  public readonly resolveUriNavigation: ResourceUniverseNavigation["resolveUriNavigation"] = (...args) =>
    this.withNavigation(navigation => navigation.resolveUriNavigation(...args));

  public getKnownResource(
    producerId: string,
    target: ResourceGraphLogicalKey
  ): UnifiedResourceProducerTarget | undefined {
    return this.target?.getKnownResource(producerId, target);
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
  /** Inline single-flight: this activation-facing module must stay free of runtime imports (see utils/singleFlight). */
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
      if (this.loadPromise === attempt) {
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
    this.loadPromise = undefined;
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
