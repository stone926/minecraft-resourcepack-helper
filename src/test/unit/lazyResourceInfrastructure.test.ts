import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  GeneratedResourceProjectRefresher,
  ResourceUniverseNavigation,
  UnifiedResourceInventory
} from "../../services/resourceUniverseNavigation";
import type { ResourceUniverseChangeEvent } from "../../resourceUniverse";
import {
  LazyResourceInfrastructureOwner,
  type ResourceInfrastructureFactoryModule,
  type ResourceNavigationInfrastructure
} from "../../registration/registerLazyResourceInfrastructure";

describe("lazy resource infrastructure", () => {
  it("stages synchronous composition without loading and shares one query load", async () => {
    const target = new FakeNavigation();
    const resources = new FakeInfrastructure(target);
    let moduleLoads = 0;
    let creates = 0;
    let releaseModule: (() => void) | undefined;
    const moduleGate = new Promise<void>(resolve => {
      releaseModule = resolve;
    });
    const owner = new LazyResourceInfrastructureOwner<FakeInfrastructure>(async () => {
      moduleLoads++;
      await moduleGate;
      return {
        createResourceInfrastructure: () => {
          creates++;
          return resources;
        }
      };
    });
    const refresher: GeneratedResourceProjectRefresher = async () => undefined;
    let changes = 0;
    const changeSubscription = owner.navigation.onDidChangeResources(() => changes++);

    owner.navigation.setGeneratedProjectRefresher(refresher);
    owner.navigation.invalidateAllKnownProjects();
    assert.deepStrictEqual(owner.navigation.invalidateUri(uriPlaceholder()), []);
    assert.strictEqual(moduleLoads, 0);
    assert.strictEqual(target.invalidations, 0);

    const firstEnsure = owner.ensureResources();
    const secondEnsure = owner.ensureResources();
    const query = owner.navigation.getKnownResources(["blockstate"]);
    assert.strictEqual(moduleLoads, 1);
    assert.strictEqual(firstEnsure, secondEnsure);
    releaseModule?.();

    assert.strictEqual(await firstEnsure, resources);
    assert.strictEqual(await secondEnsure, resources);
    assert.deepStrictEqual(await query, FakeNavigation.blockstates);
    assert.strictEqual(creates, 1);
    assert.strictEqual(target.generatedProjectRefresher, refresher);
    assert.strictEqual(target.listenerCount, 1);
    target.emitChange();
    assert.strictEqual(changes, 1);

    owner.navigation.invalidateAllKnownProjects();
    owner.navigation.invalidateUri(uriPlaceholder());
    assert.strictEqual(target.invalidations, 2);
    changeSubscription.dispose();
    assert.strictEqual(target.listenerCount, 0);

    owner.dispose();
    owner.dispose();
    assert.strictEqual(resources.disposeCalls, 1);
  });

  it("does not bind a staged listener that was disposed before loading", async () => {
    const target = new FakeNavigation();
    const resources = new FakeInfrastructure(target);
    const owner = ownerFor(resources);
    const subscription = owner.navigation.onDidChangeResources(() => undefined);

    subscription.dispose();
    await owner.ensureResources();
    assert.strictEqual(target.listenerCount, 0);
    owner.dispose();
  });

  it("does not construct resources when disposed during module loading", async () => {
    let releaseModule: ((module: ResourceInfrastructureFactoryModule<FakeInfrastructure>) => void)
      | undefined;
    const pendingModule = new Promise<ResourceInfrastructureFactoryModule<FakeInfrastructure>>(
      resolve => {
        releaseModule = resolve;
      }
    );
    let creates = 0;
    const owner = new LazyResourceInfrastructureOwner<FakeInfrastructure>(() => pendingModule);
    const query = owner.navigation.getKnownResources(["blockstate"]);

    owner.dispose();
    releaseModule?.({
      createResourceInfrastructure: () => {
        creates++;
        return new FakeInfrastructure(new FakeNavigation());
      }
    });

    await assert.rejects(() => query, /disposed while loading/);
    assert.strictEqual(creates, 0);
    await assert.rejects(() => owner.ensureResources(), /has been disposed/);
  });

  it("retries a failed factory without duplicating a successful instance", async () => {
    const resources = new FakeInfrastructure(new FakeNavigation());
    let moduleLoads = 0;
    const owner = new LazyResourceInfrastructureOwner<FakeInfrastructure>(async () => {
      moduleLoads++;
      return moduleLoads === 1
        ? { createResourceInfrastructure: () => { throw new Error("create failed"); } }
        : { createResourceInfrastructure: () => resources };
    });

    await assert.rejects(() => owner.ensureResources(), /create failed/);
    assert.strictEqual(await owner.ensureResources(), resources);
    assert.strictEqual(await owner.ensureResources(), resources);
    assert.strictEqual(moduleLoads, 2);
    owner.dispose();
  });

  it("keeps the activation-facing module free of eager runtime imports", () => {
    const lazySource = readSource("registration", "registerLazyResourceInfrastructure.ts");
    const concreteSource = readSource("registration", "registerResourceInfrastructure.ts");

    assert.deepStrictEqual(lazySource.match(/^import (?!type\b)/gm) ?? [], []);
    assert.ok(lazySource.includes('import("./registerResourceInfrastructure.js")'));
    assert.ok(lazySource.includes("ensureResources(): Promise<ResourceInfrastructure>"));
    assert.ok(concreteSource.includes("export function createResourceInfrastructure()"));
    assert.strictEqual(concreteSource.includes("export function registerResourceInfrastructure("), false);
  });

  it("types visible consumers against the structural navigation contract", () => {
    for (const segments of [
      ["providers", "resourceDefinitionProvider.ts"],
      ["providers", "resourceReferenceProvider.ts"],
      ["registration", "registerLanguageProviders.ts"],
      ["registration", "registerResourceDiagnostics.ts"],
      ["registration", "registerResourceGraph.ts"],
      ["services", "resourceGraphService.ts"]
    ]) {
      const source = readSource(...segments);
      assert.ok(source.includes("ResourceUniverseNavigation"), segments.join("/"));
      assert.strictEqual(source.includes("ResourceUniverseNavigationFacade"), false);
    }
  });
});

class FakeInfrastructure implements ResourceNavigationInfrastructure {
  public disposeCalls = 0;

  public constructor(public readonly navigation: FakeNavigation) {}

  public dispose(): void {
    this.disposeCalls++;
  }
}

class FakeNavigation implements ResourceUniverseNavigation {
  public static readonly blockstates: UnifiedResourceInventory = {
    resources: [],
    coverage: "authoritative"
  };

  public generatedProjectRefresher?: GeneratedResourceProjectRefresher;
  public invalidations = 0;
  private readonly listeners = new Set<(event: ResourceUniverseChangeEvent) => void>();

  public get listenerCount(): number {
    return this.listeners.size;
  }

  public setGeneratedProjectRefresher(refresher: GeneratedResourceProjectRefresher): void {
    this.generatedProjectRefresher = refresher;
  }

  public onDidChangeResources(
    listener: (event: ResourceUniverseChangeEvent) => void
  ): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public readonly resolveReference: ResourceUniverseNavigation["resolveReference"] = async () => {
    throw new Error("not used");
  };

  public readonly resolveLogicalDefinition:
    ResourceUniverseNavigation["resolveLogicalDefinition"] = async () => {
      throw new Error("not used");
    };

  public readonly getLogicalIncomingReferenceLocations:
    ResourceUniverseNavigation["getLogicalIncomingReferenceLocations"] = async () => {
      throw new Error("not used");
    };

  public readonly getOutgoingReferences:
    ResourceUniverseNavigation["getOutgoingReferences"] = async () => {
      throw new Error("not used");
    };

  public readonly getIncomingReferences:
    ResourceUniverseNavigation["getIncomingReferences"] = async () => {
      throw new Error("not used");
    };

  public readonly ensureProjectForUri:
    ResourceUniverseNavigation["ensureProjectForUri"] = async () => {
      throw new Error("not used");
    };

  public readonly getDocumentProjection:
    ResourceUniverseNavigation["getDocumentProjection"] = async () => {
      throw new Error("not used");
    };

  public readonly getKnownResource:
    ResourceUniverseNavigation["getKnownResource"] = () => undefined;

  public readonly getKnownResources:
    ResourceUniverseNavigation["getKnownResources"] = async kinds =>
      kinds.includes("blockstate") ? FakeNavigation.blockstates : { resources: [], coverage: "authoritative" };

  public readonly getProducerOutgoingReferences:
    ResourceUniverseNavigation["getProducerOutgoingReferences"] = async () => {
      throw new Error("not used");
    };

  public readonly getProducerIncomingReferences:
    ResourceUniverseNavigation["getProducerIncomingReferences"] = async () => {
      throw new Error("not used");
    };

  public readonly resolveProducerNavigation:
    ResourceUniverseNavigation["resolveProducerNavigation"] = async () => {
      throw new Error("not used");
    };

  public readonly resolveUriNavigation:
    ResourceUniverseNavigation["resolveUriNavigation"] = async () => {
      throw new Error("not used");
    };

  public invalidateUri(): readonly string[] {
    this.invalidations++;
    return ["project"];
  }

  public invalidateAllKnownProjects(): void {
    this.invalidations++;
  }

  public emitChange(): void {
    const event: ResourceUniverseChangeEvent = {
      kind: "replacement",
      projectId: "project",
      providerIds: ["physical"]
    };
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function ownerFor(
  resources: FakeInfrastructure
): LazyResourceInfrastructureOwner<FakeInfrastructure> {
  return new LazyResourceInfrastructureOwner(async () => ({
    createResourceInfrastructure: () => resources
  }));
}

function uriPlaceholder(): Parameters<ResourceUniverseNavigation["invalidateUri"]>[0] {
  return {
    scheme: "file",
    toString: () => "file:///workspace/pack.mcmeta"
  } as Parameters<ResourceUniverseNavigation["invalidateUri"]>[0];
}

function readSource(...segments: string[]): string {
  return fs.readFileSync(path.join(process.cwd(), "src", ...segments), "utf8");
}
