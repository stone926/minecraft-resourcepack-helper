import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  getDocumentResourceRootCandidates,
  normalizePathKey,
  type PackMetadata
} from "../../../packages/mc-assets/src";
import {
  ResourceCompletionService,
  type ResourceCompletionDirectoryEntry,
  type ResourceCompletionHost,
  type ResourceCompletionInventoryHost,
  type ResourceCompletionRootRequest
} from "../../services/resourceCompletionService";
import type { ResourceReference } from "../../utils/resourceReferences";

describe("resource completion service", () => {
  it("returns sorted domain candidates for compatible directories and files", async () => {
    const packRoot = path.resolve("virtual", "current-pack");
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(
      path.join(packRoot, "assets", "minecraft", "textures", "block"),
      [
        entry("stone.txt", "file"),
        entry("stone.png", "file"),
        entry("state", "directory"),
        entry("dirt.png", "file")
      ]
    );

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("block/st"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates, [
      {
        label: "state",
        kind: "directory",
        value: "block/state/",
        filterText: "block/state/",
        retriggerSuggest: true
      },
      {
        label: "stone",
        kind: "file",
        value: "block/stone",
        filterText: "block/stone",
        retriggerSuggest: false
      }
    ]);
  });

  it("returns namespace candidates without constructing VS Code completion items", async () => {
    const packRoot = path.resolve("virtual", "namespace-pack");
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(path.join(packRoot, "assets"), [
      entry("custom", "directory"),
      entry("Custom", "directory"),
      entry("current.txt", "file")
    ]);

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("cu"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates, [{
      label: "custom:",
      kind: "namespace",
      value: "custom:",
      filterText: "custom:",
      retriggerSuggest: true
    }]);
  });

  it("keeps CIT local-path completion in the shared domain service", async () => {
    const packRoot = path.resolve("virtual", "cit-pack");
    const documentFileName = path.join(
      packRoot,
      "assets",
      "custom",
      "citresewn",
      "items",
      "example.properties"
    );
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(path.dirname(documentFileName), [entry("icon.png", "file")]);

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName,
      reference: textureReference("ic", {
        source: "citresewn/items",
        resolveMode: "cit"
      }),
      configuration: {}
    });

    assert.deepStrictEqual(candidates, [{
      label: "icon",
      kind: "file",
      value: "icon",
      filterText: "icon",
      retriggerSuggest: false
    }]);
  });

  it("keeps relative shader completion on the current source directory", async () => {
    const packRoot = path.resolve("virtual", "relative-shader-pack");
    const documentFileName = path.join(
      packRoot,
      "assets",
      "custom",
      "shaders",
      "post",
      "nested",
      "effect.fsh"
    );
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(path.dirname(documentFileName), [
      entry("common.glsl", "file"),
      entry("quoted\"name.glsl", "file"),
      entry("line\nbreak.glsl", "file")
    ]);

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName,
      reference: shaderReference("co"),
      configuration: { resourcePackRoots: [path.resolve("virtual", "fallback-pack")] }
    });

    assert.deepStrictEqual(candidates.map(candidate => candidate.value), ["common.glsl"]);
    assert.strictEqual(host.resourceRootRequestCount, 0);
  });

  it("rejects relative shader traversal before reading outside the namespace", async () => {
    const packRoot = path.resolve("virtual", "relative-traversal-pack");
    const documentFileName = path.join(
      packRoot,
      "assets",
      "custom",
      "shaders",
      "post",
      "effect.fsh"
    );
    const host = new FakeResourceCompletionHost(packRoot);

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName,
      reference: shaderReference("../../../"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates, []);
    assert.deepStrictEqual(host.requestedDirectories, []);
    assert.strictEqual(host.resourceRootRequestCount, 0);
  });

  it("does not mutate cached root arrays when adding a CIT local directory", async () => {
    const packRoot = path.resolve("virtual", "cached-roots-pack");
    const documentFileName = path.join(packRoot, "assets", "custom", "citresewn", "items", "item.properties");
    const sharedRoots = [path.join(packRoot, "assets", "custom", "textures")];
    const host: ResourceCompletionHost = {
      getDirectoryEntries: async () => null,
      getResourceRootCandidates: () => sharedRoots
    };
    const service = new ResourceCompletionService(host);
    const request = {
      documentFileName,
      reference: textureReference("icon", { resolveMode: "cit" as const }),
      configuration: {}
    };

    await service.getCompletionCandidates(request);
    await service.getCompletionCandidates(request);

    assert.deepStrictEqual(sharedRoots, [path.join(packRoot, "assets", "custom", "textures")]);
  });

  it("filters last-known generated resources in the shared domain service", async () => {
    const packRoot = path.resolve("virtual", "generated-pack");
    const inventory: ResourceCompletionInventoryHost = {
      getKnownResources: async () => ({
        resources: [
          { target: { kind: "texture", id: "minecraft:block/stone" }, producer: { origin: "generated" } },
          { target: { kind: "texture", id: "custom:block/stone_custom" }, producer: { origin: "generated" } },
          { target: { kind: "model", id: "minecraft:block/stone" }, producer: { origin: "generated" } },
          { target: { kind: "texture", id: "minecraft:block/stone_physical" }, producer: { origin: "physical" } }
        ]
      })
    };

    const candidates = await new ResourceCompletionService(
      new FakeResourceCompletionHost(packRoot),
      inventory
    ).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("minecraft:block/st"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates, [{
      label: "stone",
      kind: "file",
      value: "minecraft:block/stone",
      filterText: "minecraft:block/stone",
      retriggerSuggest: false
    }]);
  });

  it("keeps physical candidates when generated inventory contains the same resource", async () => {
    const packRoot = path.resolve("virtual", "deduplicated-pack");
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(
      path.join(packRoot, "assets", "minecraft", "textures", "block"),
      [entry("stone.png", "file")]
    );
    const inventory: ResourceCompletionInventoryHost = {
      getKnownResources: async () => ({
        resources: [{
          target: { kind: "texture", id: "minecraft:block/stone" },
          producer: { origin: "generated" }
        }]
      })
    };

    const candidates = await new ResourceCompletionService(host, inventory).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("block/st"),
      configuration: {}
    });

    assert.strictEqual(
      candidates.filter(candidate => candidate.value === "block/stone").length,
      1
    );
  });

  it("filters physical entries that cannot form valid Minecraft resource ids", async () => {
    const packRoot = path.resolve("virtual", "invalid-name-pack");
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(
      path.join(packRoot, "assets", "minecraft", "textures", "block"),
      [
        entry("stone.png", "file"),
        entry("Bad Name.png", "file"),
        entry("quoted\"name.png", "file")
      ]
    );

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("block/"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates.map(candidate => candidate.value), ["block/stone"]);
  });

  it("keeps physical completion available when generated inventory rejects", async () => {
    const packRoot = path.resolve("virtual", "rejected-inventory-pack");
    const host = new FakeResourceCompletionHost(packRoot);
    host.setDirectoryEntries(
      path.join(packRoot, "assets", "minecraft", "textures", "block"),
      [entry("stone.png", "file")]
    );
    const inventory: ResourceCompletionInventoryHost = {
      getKnownResources: async () => {
        throw new Error("inventory unavailable");
      }
    };

    const candidates = await new ResourceCompletionService(host, inventory).getCompletionCandidates({
      documentFileName: modelDocument(packRoot),
      reference: textureReference("minecraft:block/st"),
      configuration: {}
    });

    assert.deepStrictEqual(candidates.map(candidate => candidate.value), ["minecraft:block/stone"]);
  });

  it("uses pack filters when deciding whether fallback-root entries are allowed", async () => {
    const currentPackRoot = path.resolve("virtual", "filtered-pack");
    const lowerPriorityPackRoot = path.resolve("virtual", "lower-priority-pack");
    const host = new FakeResourceCompletionHost(currentPackRoot);
    host.setPackMetadata(currentPackRoot, {
      overlays: [],
      filters: [{ namespace: "minecraft", path: "^textures/block/stone\\.png$" }]
    });
    host.setDirectoryEntries(
      path.join(lowerPriorityPackRoot, "assets", "minecraft", "textures", "block"),
      [entry("stone.png", "file")]
    );

    const candidates = await new ResourceCompletionService(host).getCompletionCandidates({
      documentFileName: modelDocument(currentPackRoot),
      reference: textureReference("block/sto"),
      configuration: { resourcePackRoots: [lowerPriorityPackRoot] }
    });

    assert.deepStrictEqual(candidates, []);
  });
});

class FakeResourceCompletionHost implements ResourceCompletionHost {
  private readonly entries = new Map<string, ResourceCompletionDirectoryEntry[]>();
  private readonly metadata = new Map<string, PackMetadata>();
  readonly requestedDirectories: string[] = [];
  resourceRootRequestCount = 0;

  constructor(private readonly packRoot: string) {}

  setDirectoryEntries(directory: string, entries: ResourceCompletionDirectoryEntry[]): void {
    this.entries.set(normalizePathKey(directory), entries);
  }

  setPackMetadata(packRoot: string, metadata: PackMetadata): void {
    this.metadata.set(normalizePathKey(packRoot), metadata);
  }

  async getDirectoryEntries(directory: string): Promise<readonly ResourceCompletionDirectoryEntry[] | null> {
    this.requestedDirectories.push(normalizePathKey(directory));
    return this.entries.get(normalizePathKey(directory)) ?? null;
  }

  getResourceRootCandidates(
    request: ResourceCompletionRootRequest,
    resourcePath: string,
    namespace: string
  ): string[] {
    this.resourceRootRequestCount++;
    return getDocumentResourceRootCandidates(
      request.sourceFileName,
      request.source,
      request.defaultAssetsPath,
      namespace,
      request.target,
      {
        pathExists: () => true,
        getPackRoot: () => this.packRoot,
        getPackMetadata: packRoot =>
          this.metadata.get(normalizePathKey(packRoot)) ?? { overlays: [], filters: [] },
        resourcePath,
        resourcePackRoots: request.resourcePackRoots
      }
    );
  }
}

function entry(name: string, kind: "directory" | "file"): ResourceCompletionDirectoryEntry {
  return {
    name,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file"
  };
}

function modelDocument(packRoot: string): string {
  return path.join(packRoot, "assets", "minecraft", "models", "block", "example.json");
}

function textureReference(
  value: string,
  overrides: Partial<ResourceReference> = {}
): ResourceReference {
  return {
    value,
    valueNode: {},
    target: "textures",
    source: "models/block",
    extension: "png",
    kind: "texture",
    ...overrides
  };
}

function shaderReference(value: string): ResourceReference {
  return {
    value,
    valueNode: {},
    target: "shaders/post/nested",
    source: "shaders/post/nested",
    extension: null,
    kind: "shader",
    resolveMode: "relative"
  };
}
