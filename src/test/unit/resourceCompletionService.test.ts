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

  constructor(private readonly packRoot: string) {}

  setDirectoryEntries(directory: string, entries: ResourceCompletionDirectoryEntry[]): void {
    this.entries.set(normalizePathKey(directory), entries);
  }

  setPackMetadata(packRoot: string, metadata: PackMetadata): void {
    this.metadata.set(normalizePathKey(packRoot), metadata);
  }

  async getDirectoryEntries(directory: string): Promise<readonly ResourceCompletionDirectoryEntry[] | null> {
    return this.entries.get(normalizePathKey(directory)) ?? null;
  }

  getResourceRootCandidates(
    request: ResourceCompletionRootRequest,
    resourcePath: string,
    namespace: string
  ): string[] {
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
