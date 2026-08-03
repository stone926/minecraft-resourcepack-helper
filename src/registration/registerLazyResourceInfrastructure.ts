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

/**
 * Async query methods forwarded through infrastructure loading; sync and
 * special-semantics methods stay handwritten. Kept as a runtime list so the
 * forwarder's coverage is inspectable and type-checked in one place.
 */
export const asyncForwardedMethods = [
  "resolveReference",
  "resolveLogicalDefinition",
  "getLogicalIncomingReferenceLocations",
  "getOutgoingReferences",
  "getIncomingReferences",
  "ensureProjectForUri",
  "getDocumentProjection",
  "getKnownResources",
  "getProducerOutgoingReferences",
  "getProducerIncomingReferences",
  "resolveProducerNavigation",
  "resolveUriNavigation"
] as const;

type AsyncForwardedMethod = (typeof asyncForwardedMethods)[number];

type PromiseReturningKeys<T> = {
  [K in keyof T]: T[K] extends (...args: never[]) => Promise<unknown> ? K : never;
}[keyof T];

type AssertExact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * Compile-time guard: the forwarded list must cover *exactly* the async query
 * methods on the contract. Adding a Promise-returning method to the interface
 * without adding it here (or vice versa) turns the assignment target into
 * `never`, which fails the `= true` below — the build breaks instead of
 * silently forwarding or silently not forwarding.
 */
const asyncForwarderCoverage: AssertExact<
  AsyncForwardedMethod,
  PromiseReturningKeys<ResourceUniverseNavigation>
> extends true ? true : never = true;
void asyncForwarderCoverage;

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

  /**
   * Generic async forwarder. The generic is bound only to the *return type*:
   * at each field initializer `K` narrows to one literal method name, so the
   * field's signature is exactly the contract's. Inside, the call is bridged
   * through an `unknown` signature because TS cannot distribute `Parameters`
   * over an uninstantiated union method key; `AsyncForwarderCoverage` plus the
   * `implements` check below keep the list honest.
   */
  private readonly forwardAsync = <K extends AsyncForwardedMethod>(
    method: K
  ): ResourceUniverseNavigation[K] => {
    return ((...args: unknown[]) =>
      this.withNavigation(navigation =>
        (navigation[method] as unknown as (...callArgs: unknown[]) => Promise<unknown>)(...args)
      )) as unknown as ResourceUniverseNavigation[K];
  };

  public readonly resolveReference = this.forwardAsync("resolveReference");
  public readonly resolveLogicalDefinition = this.forwardAsync("resolveLogicalDefinition");
  public readonly getLogicalIncomingReferenceLocations = this.forwardAsync("getLogicalIncomingReferenceLocations");
  public readonly getOutgoingReferences = this.forwardAsync("getOutgoingReferences");
  public readonly getIncomingReferences = this.forwardAsync("getIncomingReferences");
  public readonly ensureProjectForUri = this.forwardAsync("ensureProjectForUri");
  public readonly getDocumentProjection = this.forwardAsync("getDocumentProjection");
  public readonly getKnownResources = this.forwardAsync("getKnownResources");
  public readonly getProducerOutgoingReferences = this.forwardAsync("getProducerOutgoingReferences");
  public readonly getProducerIncomingReferences = this.forwardAsync("getProducerIncomingReferences");
  public readonly resolveProducerNavigation = this.forwardAsync("resolveProducerNavigation");
  public readonly resolveUriNavigation = this.forwardAsync("resolveUriNavigation");

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
