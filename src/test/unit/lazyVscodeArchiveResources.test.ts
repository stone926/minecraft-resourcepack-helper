import * as assert from "node:assert";
import type { ResourceLayerDescriptor } from "../../../packages/resource-project/src";
import { LazyVscodeArchiveResources } from "../../resourceUniverse/virtualFs/lazyVscodeArchiveResources";

describe("lazy VS Code archive resources", () => {
  it("loads and registers one archive backend only on the first concurrent mount", async () => {
    const events: string[] = [];
    let moduleLoads = 0;
    let registrations = 0;
    const api = {
      workspace: {
        registerFileSystemProvider: () => {
          registrations++;
          return { dispose: () => events.push("registration") };
        }
      }
    };
    class Store {
      public async mountLayer(descriptor: ResourceLayerDescriptor): Promise<unknown> {
        return { layerId: descriptor.layerId, rootUri: `mcres-archive://${descriptor.layerId}` };
      }
      public dispose(): void { events.push("store"); }
    }
    class FileSystem {
      public dispose(): void { events.push("filesystem"); }
    }
    class Watcher {
      public dispose(): void { events.push("watcher"); }
    }
    const resources = new LazyVscodeArchiveResources(
      api as never,
      () => undefined,
      async () => {
        moduleLoads++;
        return [{
          // eslint-disable-next-line @typescript-eslint/naming-convention
          ArchiveResourceStore: Store,
          readOnlyArchiveResourceScheme: "mcres-archive"
        }, {
          // eslint-disable-next-line @typescript-eslint/naming-convention
          VscodeArchiveResourceSourceHost: class {},
          // eslint-disable-next-line @typescript-eslint/naming-convention
          VscodeReadOnlyArchiveFileSystemProvider: FileSystem,
          // eslint-disable-next-line @typescript-eslint/naming-convention
          VscodeArchiveResourceSourceWatcher: Watcher
        }] as never;
      }
    );

    assert.strictEqual(moduleLoads, 0);
    const descriptor = archiveLayer();
    const signal = new AbortController().signal;
    const [first, second] = await Promise.all([
      resources.mountLayer(descriptor, signal),
      resources.mountLayer(descriptor, signal)
    ]);
    assert.deepStrictEqual(first, second);
    assert.strictEqual(moduleLoads, 1);
    assert.strictEqual(registrations, 1);

    resources.dispose();
    resources.dispose();
    assert.deepStrictEqual(events, ["watcher", "registration", "filesystem", "store"]);
    await assert.rejects(() => resources.mountLayer(descriptor, signal), /disposed/);
  });

  for (const failureStage of ["registration", "watcher"] as const) {
    it(`rolls back a ${failureStage} failure before retrying`, async () => {
      const events: string[] = [];
      let generation = 0;
      let activeGeneration = 0;
      const api = {
        workspace: {
          registerFileSystemProvider: () => {
            const current = activeGeneration;
            if (failureStage === "registration" && current === 1) {
              throw new Error("registration failed");
            }
            return { dispose: () => events.push(`registration-${current}`) };
          }
        }
      };
      class Store {
        private readonly generation = ++generation;
        public constructor() { activeGeneration = this.generation; }
        public async mountLayer(): Promise<unknown> { return { generation: this.generation }; }
        public dispose(): void { events.push(`store-${this.generation}`); }
      }
      class FileSystem {
        private readonly generation = activeGeneration;
        public dispose(): void { events.push(`filesystem-${this.generation}`); }
      }
      class Watcher {
        private readonly generation = activeGeneration;
        public constructor() {
          if (failureStage === "watcher" && this.generation === 1) {
            throw new Error("watcher failed");
          }
        }
        public dispose(): void { events.push(`watcher-${this.generation}`); }
      }
      let moduleLoads = 0;
      const resources = new LazyVscodeArchiveResources(
        api as never,
        () => undefined,
        async () => {
          moduleLoads++;
          return archiveModules(Store, FileSystem, Watcher);
        }
      );
      const signal = new AbortController().signal;

      await assert.rejects(
        () => resources.mountLayer(archiveLayer(), signal),
        new RegExp(`${failureStage} failed`)
      );
      assert.deepStrictEqual(events, failureStage === "registration"
        ? ["filesystem-1", "store-1"]
        : ["registration-1", "filesystem-1", "store-1"]);

      assert.deepStrictEqual(
        await resources.mountLayer(archiveLayer(), signal),
        { generation: 2 }
      );
      assert.strictEqual(moduleLoads, 2);
      resources.dispose();
      assert.deepStrictEqual(events.slice(-4), [
        "watcher-2",
        "registration-2",
        "filesystem-2",
        "store-2"
      ]);
    });
  }

  it("does not construct resources when disposed while module loading is pending", async () => {
    let releaseLoad: (() => void) | undefined;
    let constructions = 0;
    let registrations = 0;
    class Resource {
      public constructor() { constructions++; }
      public dispose(): void {}
    }
    const modules = new Promise<never>(resolve => {
      releaseLoad = () => resolve(archiveModules(Resource, Resource, Resource));
    });
    const resources = new LazyVscodeArchiveResources(
      {
        workspace: {
          registerFileSystemProvider: () => {
            registrations++;
            return { dispose() {} };
          }
        }
      } as never,
      () => undefined,
      async () => modules
    );

    const mount = resources.mountLayer(archiveLayer(), new AbortController().signal);
    resources.dispose();
    releaseLoad?.();
    await assert.rejects(() => mount, /disposed while loading/);
    assert.strictEqual(constructions, 0);
    assert.strictEqual(registrations, 0);
  });
});

function archiveModules(
  store: new (...args: never[]) => unknown,
  fileSystem: new (...args: never[]) => unknown,
  watcher: new (...args: never[]) => unknown
): never {
  return [{
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ArchiveResourceStore: store,
    readOnlyArchiveResourceScheme: "mcres-archive"
  }, {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    VscodeArchiveResourceSourceHost: class {},
    // eslint-disable-next-line @typescript-eslint/naming-convention
    VscodeReadOnlyArchiveFileSystemProvider: fileSystem,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    VscodeArchiveResourceSourceWatcher: watcher
  }] as never;
}

function archiveLayer(): ResourceLayerDescriptor {
  return {
    layerId: "zip-layer",
    role: "custom",
    source: "zip",
    rootUri: "file:///workspace/layer.zip",
    priority: 1,
    metadataRevision: "zip-r1"
  };
}
