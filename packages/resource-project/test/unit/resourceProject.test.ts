import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createResourceLayerDescriptor,
  joinResourceProjectUri,
  normalizeResourceProjectUri,
  resolveResourcePackProjectContext,
  type ResourceProjectFileType,
  type ResourceProjectTopologyHost,
  type SerializedResourceUri
} from "../../src";
import {
  nodePathToResourceProjectUri,
  NodeResourceProjectTopologyHost,
  resourceProjectUriToNodePath
} from "../../src/node";

describe("resource project topology", () => {
  it("associates pack/assets and nested rsgl sources with one canonical context", async () => {
    const packRoot = "file:///workspace/Mixed%20Pack";
    const sourceUri = `${packRoot}/rsgl/nested/%E6%A8%A1%E5%9E%8B/main.rsgl`;
    const host = memoryHost({
      [`${packRoot}/pack.mcmeta`]: "file",
      [sourceUri]: "file"
    });

    const result = await resolveResourcePackProjectContext({
      sourceUri,
      workspaceFolderUris: [packRoot]
    }, host);

    assert.deepStrictEqual(result.diagnostics, []);
    assert.ok(result.context);
    assert.strictEqual(result.context.packRootUri, packRoot);
    assert.strictEqual(result.context.assetsRootUri, `${packRoot}/assets`);
    assert.strictEqual(result.context.outputPackRootUri, packRoot);
    assert.deepStrictEqual(result.context.rsglSourceRootUris, [`${packRoot}/rsgl`]);
    assert.strictEqual(result.context.localLayer.rootUri, packRoot);
    assert.strictEqual(result.context.localLayer.role, "local");
  });

  it("uses a targeted conventional root for non-RSGL document anchors", async () => {
    const packRoot = "file:///workspace/pack";
    const sourceUri = `${packRoot}/assets/demo/models/block/example.json`;
    const result = await resolveResourcePackProjectContext({
      sourceUri,
      workspaceFolderUris: [packRoot]
    }, memoryHost({
      [`${packRoot}/pack.mcmeta`]: "file",
      [`${packRoot}/rsgl`]: "directory",
      [sourceUri]: "file"
    }));

    assert.ok(result.context);
    assert.deepStrictEqual(result.context.rsglSourceRootUris, [`${packRoot}/rsgl`]);
  });

  it("resolves configured source root and pack-root outDir when source lives outside the pack", async () => {
    const projectRoot = "file:///workspace/Tooling%20Project";
    const sourceUri = `${projectRoot}/%E6%BA%90%E7%A0%81/nested/main.rsgl`;
    const outputPackRoot = "file:///workspace/Target%20Pack";
    const request = {
      sourceUri,
      workspaceFolderUris: ["file:///workspace"],
      configuration: {
        configUri: `${projectRoot}/rsgl.config.json`,
        root: "源码",
        outDir: "../Target Pack",
        overlaySelection: ["high_contrast"]
      }
    } as const;

    const first = await resolveResourcePackProjectContext(request, memoryHost({ [sourceUri]: "file" }));
    const second = await resolveResourcePackProjectContext(request, memoryHost({ [sourceUri]: "file" }));

    assert.deepStrictEqual(first.diagnostics, []);
    assert.ok(first.context && second.context);
    assert.strictEqual(first.context.projectRootUri, projectRoot);
    assert.deepStrictEqual(first.context.rsglSourceRootUris, [`${projectRoot}/%E6%BA%90%E7%A0%81`]);
    assert.strictEqual(first.context.outputPackRootUri, outputPackRoot);
    assert.strictEqual(first.context.outputAssetsRootUri, `${outputPackRoot}/assets`);
    assert.strictEqual(first.context.projectId, second.context.projectId);
    assert.strictEqual(first.context.configurationRevision, second.context.configurationRevision);
    assert.strictEqual(first.context.contextRevision, second.context.contextRevision);

    const changed = await resolveResourcePackProjectContext({
      ...request,
      configuration: { ...request.configuration, overlaySelection: ["other"] }
    }, memoryHost({ [sourceUri]: "file" }));
    assert.ok(changed.context);
    assert.strictEqual(changed.context.projectId, first.context.projectId);
    assert.notStrictEqual(changed.context.configurationRevision, first.context.configurationRevision);
    assert.notStrictEqual(changed.context.contextRevision, first.context.contextRevision);
  });

  it("rejects assets as outDir before it can produce assets/assets", async () => {
    const result = await resolveResourcePackProjectContext({
      sourceUri: "file:///workspace/project/src/main.rsgl",
      workspaceFolderUris: ["file:///workspace"],
      configuration: {
        configUri: "file:///workspace/project/rsgl.config.json",
        root: "src",
        outDir: "../pack/assets"
      }
    }, memoryHost({}));

    assert.strictEqual(result.context, undefined);
    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "resourceProject.outputMustBePackRoot"
    ]);
  });

  it("creates stable directory, ZIP, client-jar, and asset-index layer descriptors", async () => {
    const result = await resolveResourcePackProjectContext({
      sourceUri: "file:///workspace/project/rsgl/main.rsgl",
      workspaceFolderUris: ["file:///workspace"],
      configuration: {
        configUri: "file:///workspace/project/rsgl.config.json",
        root: "rsgl",
        outDir: "pack",
        vanillaLayer: {
          role: "vanilla",
          source: "clientJar",
          root: "vanilla/client.jar",
          priority: 100
        },
        externalLayers: [
          { role: "custom", source: "zip", root: "layers/a.zip", priority: 20 },
          { role: "custom", source: "directory", root: "layers/b", priority: 10 }
        ]
      }
    }, memoryHost({}));

    assert.ok(result.context);
    assert.strictEqual(result.context.vanillaLayer?.source, "clientJar");
    assert.deepStrictEqual(
      result.context.externalLayers.map(layer => [layer.source, layer.priority]),
      [["directory", 10], ["zip", 20]]
    );
    assert.strictEqual(
      createResourceLayerDescriptor({
        role: "vanilla",
        source: "assetIndex",
        root: "file:///minecraft/assets/indexes/1.21.json"
      }, "file:///workspace").source,
      "assetIndex"
    );
    assert.throws(() => createResourceLayerDescriptor({
      role: "local",
      source: "zip",
      root: "local.zip"
    }, "file:///workspace"), /local resource layer must use a directory/);
  });

  it("treats a null project vanilla layer as an explicit shared-setting override", async () => {
    const result = await resolveResourcePackProjectContext({
      sourceUri: "file:///workspace/project/rsgl/main.rsgl",
      workspaceFolderUris: ["file:///workspace"],
      configuration: {
        configUri: "file:///workspace/project/rsgl.config.json",
        root: "rsgl",
        outDir: "pack",
        vanillaLayer: null
      },
      sharedConfiguration: {
        vanillaLayer: {
          role: "vanilla",
          source: "directory",
          root: "file:///settings/default-assets"
        }
      }
    }, memoryHost({}));

    assert.ok(result.context);
    assert.strictEqual(result.context.vanillaLayer, undefined);
  });

  it("reports multi-root ambiguity instead of choosing a pack arbitrarily", async () => {
    const packA = "file:///workspace/pack-a";
    const packB = "file:///workspace/pack-b";
    const result = await resolveResourcePackProjectContext({
      sourceUri: "file:///external/rsgl/main.rsgl",
      workspaceFolderUris: [packB, packA]
    }, memoryHost({
      [`${packA}/pack.mcmeta`]: "file",
      [`${packB}/pack.mcmeta`]: "file"
    }));

    assert.strictEqual(result.context, undefined);
    assert.deepStrictEqual(result.diagnostics.map(diagnostic => diagnostic.code), [
      "resourceProject.ambiguousPackRoot"
    ]);
    assert.deepStrictEqual(result.diagnostics[0].relatedUris, [packA, packB]);
  });

  it("normalizes Windows drive URIs while preserving encoded spaces and non-ASCII paths", async () => {
    const result = await resolveResourcePackProjectContext({
      sourceUri: "file:///c:/Work/My%20Pack/%E6%BA%90%E7%A0%81/main.rsgl",
      workspaceFolderUris: ["file:///c:/Work"],
      configuration: {
        configUri: "file:///c:/Work/My%20Pack/rsgl.config.json",
        root: "源码",
        outDir: "Target Pack"
      }
    }, memoryHost({}));

    assert.ok(result.context);
    assert.strictEqual(result.context.workspaceFolderUri, "file:///C:/Work");
    assert.strictEqual(result.context.projectRootUri, "file:///C:/Work/My%20Pack");
    assert.strictEqual(result.context.outputPackRootUri, "file:///C:/Work/My%20Pack/Target%20Pack");
    assert.deepStrictEqual(result.context.rsglSourceRootUris, [
      "file:///C:/Work/My%20Pack/%E6%BA%90%E7%A0%81"
    ]);

    const caseVariant = await resolveResourcePackProjectContext({
      sourceUri: "file:///C:/WORK/MY%20PACK/%E6%BA%90%E7%A0%81/main.rsgl",
      workspaceFolderUris: ["file:///C:/WORK"],
      configuration: {
        configUri: "file:///C:/WORK/MY%20PACK/rsgl.config.json",
        root: "源码",
        outDir: "TARGET PACK"
      }
    }, memoryHost({}));
    assert.ok(caseVariant.context);
    assert.strictEqual(caseVariant.context.projectId, result.context.projectId);
    assert.strictEqual(caseVariant.context.configurationRevision, result.context.configurationRevision);
    assert.strictEqual(caseVariant.context.contextRevision, result.context.contextRevision);
  });

  it("keeps remote hierarchical URIs intact without converting them to local paths", async () => {
    const packRoot = "vscode-remote://ssh-remote+builder/home/dev/Resource%20Pack";
    const sourceUri = `${packRoot}/rsgl/main.rsgl`;
    const result = await resolveResourcePackProjectContext({
      sourceUri,
      workspaceFolderUris: [packRoot]
    }, memoryHost({ [`${packRoot}/pack.mcmeta`]: "file" }));

    assert.ok(result.context);
    assert.strictEqual(result.context.packRootUri, packRoot);
    assert.strictEqual(result.context.assetsRootUri, `${packRoot}/assets`);
    assert.deepStrictEqual(result.context.rsglSourceRootUris, [`${packRoot}/rsgl`]);
  });

  it("keeps Node filesystem conversion isolated and round-trips Unicode paths", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resource-project-空 格-"));
    const packMcmeta = path.join(tempRoot, "pack.mcmeta");
    try {
      fs.writeFileSync(packMcmeta, "{}");
      const rootUri = nodePathToResourceProjectUri(tempRoot);
      assert.strictEqual(resourceProjectUriToNodePath(rootUri), path.resolve(tempRoot));
      assert.strictEqual(
        await new NodeResourceProjectTopologyHost().stat(joinResourceProjectUri(rootUri, "pack.mcmeta")),
        "file"
      );
      assert.strictEqual(normalizeResourceProjectUri(rootUri), rootUri);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

function memoryHost(entries: Readonly<Record<string, ResourceProjectFileType>>): ResourceProjectTopologyHost {
  const normalized = new Map(Object.entries(entries).map(([uri, type]) => [
    normalizeResourceProjectUri(uri),
    type
  ]));
  return {
    stat: async (uri: SerializedResourceUri) => normalized.get(normalizeResourceProjectUri(uri)) ?? null
  };
}
