import * as assert from "node:assert";
import {
  joinResourceProjectUri,
  type ResourceLayerDescriptor
} from "../../../packages/resource-project/src";
import {
  ArchiveResourceStore,
  ArchiveResourceStoreError,
  ResourceNavigationService,
  ResourceUniverseIndex,
  ZipArchive,
  ZipArchiveError,
  createPhysicalAssetSnapshot,
  type ArchiveResourceSourceHost,
  type ArchiveResourceSourceStat
} from "../../resourceUniverse";
import { sharedConfigurationFromSettings } from "../../resourceProject";
import { createZipFixture } from "./helpers/zipFixture";

describe("read-only archive resources", () => {
  it("classifies configured ZIP packs and vanilla JARs at the shared project boundary", () => {
    const configuration = sharedConfigurationFromSettings(
      "file:///E:/VSCode/%E8%B5%84%E6%BA%90%E5%8C%85",
      "C:\\Users\\玩家\\Minecraft 26.2\\26.2.jar",
      ["extern packs/base.zip"]
    );

    assert.strictEqual(configuration.vanillaLayer?.source, "clientJar");
    assert.strictEqual(configuration.externalLayers?.[0].source, "zip");
  });

  it("indexes implicit directories and reads stored and deflated Unicode entries", () => {
    const modelText = JSON.stringify({ parent: "minecraft:block/cube_all" });
    const archive = ZipArchive.fromBytes(createZipFixture([
      { path: "pack.mcmeta", content: "{}", compression: "stored" },
      { path: "assets/demo/models/block/方 块.json", content: modelText },
      { path: "assets/demo/textures/block/stone.png", content: new Uint8Array([1, 2, 3]), compression: "stored" }
    ]));

    assert.deepStrictEqual(archive.readDirectory("assets/demo"), [
      { name: "models", type: "directory" },
      { name: "textures", type: "directory" }
    ]);
    assert.deepStrictEqual(archive.stat("assets/demo/models/block/方 块.json"), {
      type: "file",
      size: Buffer.byteLength(modelText),
      mtime: 0
    });
    assert.strictEqual(
      Buffer.from(archive.readFile("assets/demo/models/block/方 块.json")).toString("utf8"),
      modelText
    );
    assert.deepStrictEqual(
      [...archive.readFile("assets/demo/textures/block/stone.png")],
      [1, 2, 3]
    );
  });

  it("rejects archive traversal instead of exposing paths outside the virtual root", () => {
    assert.throws(
      () => ZipArchive.fromBytes(createZipFixture([{ path: "../escaped.json", content: "{}" }])),
      (error: unknown) => error instanceof ZipArchiveError && error.code === "invalidArchive"
    );
  });

  it("mounts a Windows path with spaces and non-ASCII names without extraction", async () => {
    const sourceUri = "file:///C:/Workspace%20%E8%B5%84%E6%BA%90/%E5%A4%96%E9%83%A8%20pack.zip";
    const host = new MemoryArchiveHost(sourceUri, createZipFixture([{
      path: "assets/demo/models/block/inside.json",
      content: "{\"parent\":\"demo:block/base\"}"
    }]));
    const store = new ArchiveResourceStore(host);
    const mount = await store.mountLayer(zipLayer(sourceUri), new AbortController().signal);
    const entryUri = joinResourceProjectUri(
      mount.rootUri,
      "assets",
      "demo",
      "models",
      "block",
      "inside.json"
    );

    assert.match(mount.rootUri, /^mcres-archive:\/\/archive-[a-z0-9-]+\/$/);
    assert.ok(!mount.rootUri.includes("Workspace"));
    assert.strictEqual(store.stat(entryUri).type, "file");
    assert.strictEqual(
      Buffer.from(await store.readFile(entryUri)).toString("utf8"),
      "{\"parent\":\"demo:block/base\"}"
    );
    store.dispose();
  });

  it("changes virtual authorities and rejects stale URIs after archive replacement", async () => {
    const sourceUri = "vscode-remote://ssh-remote+dev/work/extern/pack.zip";
    const host = new MemoryArchiveHost(sourceUri, createZipFixture([{
      path: "assets/demo/models/block/revision.json",
      content: "{\"revision\":1}"
    }]));
    const store = new ArchiveResourceStore(host);
    const descriptor = zipLayer(sourceUri);
    const first = await store.mountLayer(descriptor, new AbortController().signal);
    const firstEntry = joinResourceProjectUri(
      first.rootUri,
      "assets/demo/models/block/revision.json"
    );

    host.replace(createZipFixture([{
      path: "assets/demo/models/block/revision.json",
      content: "{\"revision\":2}"
    }]));
    const second = await store.mountLayer(descriptor, new AbortController().signal);
    const secondEntry = joinResourceProjectUri(
      second.rootUri,
      "assets/demo/models/block/revision.json"
    );

    assert.notStrictEqual(first.rootUri, second.rootUri);
    assert.throws(
      () => store.stat(firstEntry),
      (error: unknown) => error instanceof ArchiveResourceStoreError
        && error.code === "staleResourceUri"
    );
    assert.strictEqual(
      Buffer.from(await store.readFile(secondEntry)).toString("utf8"),
      "{\"revision\":2}"
    );
    store.dispose();
  });

  it("navigates a vanilla client JAR producer through its read-only logical URI", async () => {
    const sourceUri = "file:///C:/Minecraft/versions/26.2/26.2.jar";
    const host = new MemoryArchiveHost(sourceUri, createZipFixture([{
      path: "assets/minecraft/models/block/cube_all.json",
      content: "{}"
    }]));
    const store = new ArchiveResourceStore(host);
    const descriptor: ResourceLayerDescriptor = {
      layerId: "vanilla-client",
      role: "vanilla",
      source: "clientJar",
      rootUri: sourceUri,
      priority: 100,
      metadataRevision: "26.2"
    };
    const mount = await store.mountLayer(descriptor, new AbortController().signal);
    const logicalUri = joinResourceProjectUri(
      mount.rootUri,
      "assets/minecraft/models/block/cube_all.json"
    );
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 1,
      revision: mount.revision,
      documents: [{
        uri: logicalUri,
        fileName: "/assets/minecraft/models/block/cube_all.json",
        outputPath: "assets/minecraft/models/block/cube_all.json",
        revision: mount.revision,
        layerId: descriptor.layerId,
        layerRole: "vanilla",
        references: []
      }]
    });
    const index = new ResourceUniverseIndex();
    index.replaceSnapshot(snapshot);
    const result = new ResourceNavigationService(index).resolveDefinition(
      { kind: "model", id: "minecraft:block/cube_all" },
      {
        contextId: "project:vanilla",
        projectId: "project",
        scope: "vanilla",
        orderedLayerIds: [descriptor.layerId],
        applicableProviderIds: ["physical"]
      }
    );

    assert.strictEqual(result.status, "resolved");
    assert.strictEqual(result.status === "resolved" ? result.primary.uri : "", logicalUri);
    assert.strictEqual(result.status === "resolved" ? result.primary.editable : true, false);
    assert.strictEqual(result.status === "resolved" ? result.producer.layerRole : "", "vanilla");
    store.dispose();
  });
});

function zipLayer(sourceUri: string): ResourceLayerDescriptor {
  return {
    layerId: "custom-zip",
    role: "custom",
    source: "zip",
    rootUri: sourceUri,
    priority: 1,
    metadataRevision: "configured-r1"
  };
}

class MemoryArchiveHost implements ArchiveResourceSourceHost {
  private revision = 1;

  public constructor(
    private readonly sourceUri: string,
    private bytes: Uint8Array
  ) {}

  public async stat(uri: string): Promise<ArchiveResourceSourceStat | null> {
    return uri === this.sourceUri ? {
      type: "file",
      ctime: 1,
      mtime: this.revision,
      size: this.bytes.byteLength
    } : null;
  }

  public async readFile(uri: string): Promise<Uint8Array> {
    if (uri !== this.sourceUri) {
      throw new Error(`Unknown archive source: ${uri}`);
    }
    return this.bytes;
  }

  public replace(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.revision++;
  }
}
