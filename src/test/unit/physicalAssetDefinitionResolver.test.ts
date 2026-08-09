import * as assert from "node:assert/strict";
import type {
  ResourceLayerDescriptor,
  ResourcePackProjectContextDto
} from "../../../packages/resource-project/src";
import {
  resolveExactPhysicalAssetDefinition,
  type PhysicalAssetDefinitionLayerRoots,
  type PhysicalAssetDefinitionResolverHost,
  type PhysicalAssetDefinitionTargetProbe
} from "../../resourceUniverse/providers/physicalAssetDefinitionResolver";

describe("exact physical asset Definition resolver", () => {
  it("resolves local, custom, vanilla, and effective scopes through exact candidates", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context, {
      files: [
        "file:///pack/assets/demo/models/block/local.json",
        "file:///custom-high/assets/demo/models/block/custom.json",
        "file:///vanilla/assets/demo/models/block/vanilla.json",
        "file:///custom-high/assets/demo/models/block/effective.json"
      ]
    });

    const local = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/local" },
      scope: "local"
    }, host);
    assert.strictEqual(local.status, "resolved");
    assert.strictEqual(local.status === "resolved" && local.definition.layer.layerId, "local");

    const custom = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/custom" },
      scope: "custom"
    }, host);
    assert.strictEqual(custom.status, "resolved");
    assert.strictEqual(custom.status === "resolved" && custom.definition.layer.layerId, "custom-high");

    const vanilla = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/vanilla" },
      scope: "vanilla"
    }, host);
    assert.strictEqual(vanilla.status, "resolved");
    assert.strictEqual(vanilla.status === "resolved" && vanilla.definition.layer.layerId, "vanilla");

    host.probes.length = 0;
    const effective = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/effective" },
      scope: "effective"
    }, host);
    assert.strictEqual(effective.status, "resolved");
    assert.strictEqual(effective.status === "resolved" && effective.definition.layer.layerId, "custom-high");
    assert.deepStrictEqual(host.probes, [
      "file:///pack/assets/demo/models/block/effective.json",
      "file:///custom-high/assets/demo/models/block/effective.json"
    ]);
  });

  it("uses context layer priority and per-layer assets-root order", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context, {
      roots: new Map([
        ["local", ["file:///pack/overlay/assets", "file:///pack/assets"]]
      ]),
      files: [
        "file:///pack/overlay/assets/demo/textures/block/priority.png",
        "file:///custom-low/assets/demo/textures/block/priority.png"
      ]
    });

    const result = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "texture", id: "demo:block/priority.png" },
      scope: "effective"
    }, host);

    assert.strictEqual(result.status, "resolved");
    if (result.status !== "resolved") {
      return;
    }
    assert.strictEqual(result.definition.layer.layerId, "local");
    assert.strictEqual(
      result.definition.uri,
      "file:///pack/overlay/assets/demo/textures/block/priority.png"
    );
    assert.deepStrictEqual(host.probes, [
      result.definition.uri,
      "file:///pack/assets/demo/textures/block/priority.png"
    ]);
  });

  it("falls back when active roots in one layer contain conflicting definitions", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context, {
      roots: new Map([
        ["local", ["file:///pack/overlay/assets", "file:///pack/assets"]]
      ]),
      files: [
        "file:///pack/overlay/assets/demo/models/block/conflict.json",
        "file:///pack/assets/demo/models/block/conflict.json"
      ]
    });

    const result = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/conflict" },
      scope: "local"
    }, host);

    assert.strictEqual(result.status, "fallback");
    assert.strictEqual(result.status === "fallback" && result.reason, "multipleCandidates");
  });

  it("returns a certain miss only after every applicable exact candidate is missing", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context);

    const result = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/missing" },
      scope: "effective"
    }, host);

    assert.deepStrictEqual(result, {
      status: "missing",
      target: { kind: "model", id: "demo:block/missing" },
      outputPath: "assets/demo/models/block/missing.json"
    });
    assert.deepStrictEqual(host.probes, [
      "file:///pack/assets/demo/models/block/missing.json",
      "file:///custom-high/assets/demo/models/block/missing.json",
      "file:///custom-low/assets/demo/models/block/missing.json",
      "file:///vanilla/assets/demo/models/block/missing.json"
    ]);
  });

  it("falls back before lower-priority layers when layer or target evidence is unavailable", async () => {
    const context = projectContext();
    const unsupported = new FakeDefinitionHost(context, {
      layerStatuses: new Map([["custom-high", "unsupported"]]),
      files: ["file:///custom-low/assets/demo/models/block/lower.json"]
    });
    const unsupportedResult = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/lower" },
      scope: "custom"
    }, unsupported);
    assert.deepStrictEqual(unsupportedResult, {
      status: "fallback",
      target: { kind: "model", id: "demo:block/lower" },
      reason: "unsupportedLayer",
      outputPath: "assets/demo/models/block/lower.json",
      layerId: "custom-high"
    });
    assert.deepStrictEqual(unsupported.probes, []);

    const unavailable = new FakeDefinitionHost(context, {
      probes: new Map([[
        "file:///pack/assets/demo/models/block/unavailable.json",
        "unavailable"
      ]])
    });
    const unavailableResult = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/unavailable" },
      scope: "effective"
    }, unavailable);
    assert.strictEqual(unavailableResult.status, "fallback");
    assert.strictEqual(
      unavailableResult.status === "fallback" && unavailableResult.reason,
      "unavailableTarget"
    );
    assert.deepStrictEqual(unavailable.probes, [
      "file:///pack/assets/demo/models/block/unavailable.json"
    ]);
  });

  it("falls back for an owned local output instead of exposing its materialized file", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context, {
      files: [
        "file:///pack/assets/demo/models/block/owned.json",
        "file:///custom-high/assets/demo/models/block/owned.json"
      ],
      ownedOutputs: ["assets/demo/models/block/owned.json"]
    });

    const result = await resolveExactPhysicalAssetDefinition({
      context,
      target: { kind: "model", id: "demo:block/owned" },
      scope: "effective"
    }, host);

    assert.strictEqual(result.status, "fallback");
    assert.strictEqual(result.status === "fallback" && result.reason, "ownedOutput");
    assert.strictEqual(result.status === "fallback" && result.layerId, "local");
    assert.deepStrictEqual(host.probes, [
      "file:///pack/assets/demo/models/block/owned.json"
    ]);
  });

  it("falls back without filesystem work for aggregate, extensionless, and unknown kinds", async () => {
    const context = projectContext();
    const host = new FakeDefinitionHost(context);

    for (const target of [
      { kind: "textureDirectory", id: "demo:block" },
      { kind: "fontFile", id: "demo:font/example" },
      { kind: "unknownKind", id: "demo:anything" }
    ]) {
      const result = await resolveExactPhysicalAssetDefinition({
        context,
        target,
        scope: "effective"
      }, host);
      assert.strictEqual(result.status, "fallback");
      assert.strictEqual(
        result.status === "fallback" && result.reason,
        "unsupportedTargetKind"
      );
    }
    assert.deepStrictEqual(host.rootRequests, []);
    assert.deepStrictEqual(host.probes, []);
  });
});

interface FakeDefinitionHostOptions {
  roots?: ReadonlyMap<string, readonly string[]>;
  layerStatuses?: ReadonlyMap<string, "unsupported" | "unavailable">;
  files?: readonly string[];
  probes?: ReadonlyMap<string, PhysicalAssetDefinitionTargetProbe>;
  ownedOutputs?: readonly string[];
}

class FakeDefinitionHost implements PhysicalAssetDefinitionResolverHost {
  public readonly rootRequests: string[] = [];
  public readonly probes: string[] = [];
  private readonly files: ReadonlySet<string>;
  private readonly ownedOutputs: ReadonlySet<string>;

  public constructor(
    private readonly context: ResourcePackProjectContextDto,
    private readonly options: FakeDefinitionHostOptions = {}
  ) {
    this.files = new Set(options.files ?? []);
    this.ownedOutputs = new Set(options.ownedOutputs ?? []);
  }

  public async getOrderedAssetsRootUris(
    context: ResourcePackProjectContextDto,
    layer: ResourceLayerDescriptor
  ): Promise<PhysicalAssetDefinitionLayerRoots> {
    assert.strictEqual(context, this.context);
    this.rootRequests.push(layer.layerId);
    const status = this.options.layerStatuses?.get(layer.layerId);
    if (status) {
      return { status };
    }
    return {
      status: "ready",
      assetsRootUris: this.options.roots?.get(layer.layerId)
        ?? [`${layer.rootUri}/assets`]
    };
  }

  public async probeTargetUri(uri: string): Promise<PhysicalAssetDefinitionTargetProbe> {
    this.probes.push(uri);
    return this.options.probes?.get(uri)
      ?? (this.files.has(uri) ? "file" : "missing");
  }

  public isOwnedOutput(projectId: string, outputPath: string): boolean {
    assert.strictEqual(projectId, this.context.projectId);
    return this.ownedOutputs.has(outputPath);
  }
}

function projectContext(): ResourcePackProjectContextDto {
  const local = layer("local", "local", "file:///pack", 0);
  const customHigh = layer("custom-high", "custom", "file:///custom-high", 10);
  const customLow = layer("custom-low", "custom", "file:///custom-low", 20);
  const vanilla = layer("vanilla", "vanilla", "file:///vanilla", 30);
  return {
    projectId: "project",
    workspaceFolderUri: "file:///workspace",
    projectRootUri: "file:///pack",
    packRootUri: "file:///pack",
    assetsRootUri: "file:///pack/assets",
    rsglSourceRootUris: ["file:///pack/rsgl"],
    outputPackRootUri: "file:///pack",
    outputAssetsRootUri: "file:///pack/assets",
    localLayer: local,
    externalLayers: [customHigh, customLow],
    vanillaLayer: vanilla,
    overlaySelection: [],
    configurationRevision: "configuration-r1",
    contextRevision: "context-r1"
  };
}

function layer(
  layerId: string,
  role: ResourceLayerDescriptor["role"],
  rootUri: string,
  priority: number
): ResourceLayerDescriptor {
  return {
    layerId,
    role,
    source: "directory",
    rootUri,
    priority,
    metadataRevision: `${layerId}-r1`
  };
}
