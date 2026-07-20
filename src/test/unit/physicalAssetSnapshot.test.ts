import * as assert from "node:assert";
import {
  adaptPhysicalAssetDocuments,
  createPhysicalAssetSnapshot,
  PhysicalAssetContributionProvider
} from "../../resourceUniverse/providers";

describe("physical asset provider snapshot", () => {
  it("projects physical files onto canonical producers and unresolved logical edges", () => {
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 3,
      revision: "physical-r3",
      documents: [{
        uri: "file:///workspace/assets/demo/models/block/consumer.json",
        fileName: "C:\\workspace\\assets\\demo\\models\\block\\consumer.json",
        revision: "doc-r1",
        layerId: "local",
        layerRole: "local",
        references: [{
          targetKind: "model",
          value: "demo:block/parent.json",
          target: "models",
          source: "assets",
          extension: "json",
          relationship: "modelParent",
          sourceLocation: {
            uri: "file:///workspace/assets/demo/models/block/consumer.json",
            range: { start: 12, end: 36 },
            origin: "physical",
            editable: true
          }
        }, {
          targetKind: "texture",
          value: "demo:block/stone.png",
          extension: "png"
        }]
      }]
    });

    assert.strictEqual(snapshot.coverage.status, "authoritative");
    assert.deepStrictEqual(snapshot.producers[0].logicalKeys, [{
      kind: "model",
      id: "demo:block/consumer"
    }]);
    assert.deepStrictEqual(snapshot.edges.map(edge => ({
      target: edge.target,
      relationship: edge.relationship,
      sourceReference: edge.sourceReference
    })), [{
      target: { kind: "model", id: "demo:block/parent" },
      relationship: "modelParent",
      sourceReference: {
        value: "demo:block/parent.json",
        target: "models",
        source: "assets",
        extension: "json",
        kind: "model"
      }
    }, {
      target: { kind: "texture", id: "demo:block/stone" },
      relationship: undefined,
      sourceReference: undefined
    }]);
  });

  it("keeps texture aliases and aggregate memberships on one physical producer", () => {
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 1,
      revision: "r1",
      documents: [{
        uri: "file:///workspace/assets/demo/textures/block/stone.png",
        fileName: "/workspace/assets/demo/textures/block/stone.png",
        revision: "doc-r1",
        layerId: "local",
        layerRole: "local",
        references: []
      }]
    });

    assert.deepStrictEqual(snapshot.producers[0].logicalKeys, [{ kind: "texture", id: "demo:block/stone" }]);
    assert.deepStrictEqual(snapshot.producers[0].aliasKeys, [{ kind: "texture", id: "demo:block/stone.png" }]);
    assert.deepStrictEqual(snapshot.producers[0].aggregateMemberships, [{
      kind: "textureDirectory",
      id: "demo:block"
    }]);
  });

  it("does not register manifest-owned materializations as handwritten producers", () => {
    const outputPath = "assets/demo/models/block/generated.json";
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 1,
      revision: "r1",
      ownedOutputPaths: new Set([outputPath]),
      documents: [{
        uri: "file:///workspace/assets/demo/models/block/generated.json",
        fileName: "/workspace/assets/demo/models/block/generated.json",
        outputPath,
        revision: "doc-r1",
        layerId: "local",
        layerRole: "local",
        references: []
      }]
    });
    assert.deepStrictEqual(snapshot.producers, []);
  });

  it("keeps vanilla origins read-only even when the configured layer is a local directory", () => {
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 1,
      revision: "r1",
      documents: [{
        uri: "file:///minecraft/client/assets/minecraft/models/block/cube_all.json",
        fileName: "/minecraft/client/assets/minecraft/models/block/cube_all.json",
        revision: "vanilla-r1",
        layerId: "vanilla",
        layerRole: "vanilla",
        references: []
      }, {
        uri: "vscode-remote://ssh-remote+dev/work/assets/demo/models/block/local.json",
        fileName: "/work/assets/demo/models/block/local.json",
        revision: "local-r1",
        layerId: "local",
        layerRole: "local",
        references: []
      }]
    });

    const byLayer = new Map(snapshot.producers.map(producer => [
      producer.layerRole,
      producer.physicalOrigins[0].editable
    ]));
    assert.strictEqual(byLayer.get("vanilla"), false);
    assert.strictEqual(byLayer.get("local"), true);
  });

  it("isolates malformed resource identities while retaining a provider-local source node", () => {
    const snapshot = createPhysicalAssetSnapshot({
      projectId: "project",
      generation: 1,
      revision: "r1",
      documents: [{
        uri: "file:///workspace/assets/DEMO/models/block/Broken.json",
        fileName: "/workspace/assets/DEMO/models/block/Broken.json",
        revision: "doc-r1",
        layerId: "local",
        layerRole: "local",
        references: [{ targetKind: "model", value: "not valid" }]
      }]
    });
    assert.strictEqual(snapshot.producers.length, 1);
    assert.deepStrictEqual(snapshot.producers[0].logicalKeys, []);
    assert.deepStrictEqual(snapshot.edges, []);
  });

  it("adapts the existing JSON reference extractor without persisting resolved target URIs", () => {
    const text = JSON.stringify({ parent: "demo:block/base" });
    const facts = adaptPhysicalAssetDocuments([{
      uri: "vscode-remote://ssh-remote+dev/work/assets/demo/models/block/consumer.json",
      fileName: "/work/assets/demo/models/block/consumer.json",
      languageId: "json",
      version: 4,
      revision: "open-4",
      layerId: "local",
      layerRole: "local",
      outputPath: "assets/demo/models/block/consumer.json",
      getText: () => text
    }]);

    assert.strictEqual(facts.length, 1);
    assert.deepStrictEqual(facts[0].references.map(reference => ({
      kind: reference.targetKind,
      value: reference.value,
      relationship: reference.relationship,
      uri: reference.sourceLocation?.uri
    })), [{
      kind: "model",
      value: "demo:block/base",
      relationship: "modelParent",
      uri: "vscode-remote://ssh-remote+dev/work/assets/demo/models/block/consumer.json"
    }]);
  });

  it("keeps scan orchestration behind a project-scoped provider source", async () => {
    const provider = new PhysicalAssetContributionProvider({
      scanProject: async request => ({
        revision: "scan-r1",
        documents: [{
          uri: "file:///workspace/assets/demo/textures/block/stone.png",
          fileName: "/workspace/assets/demo/textures/block/stone.png",
          languageId: "plaintext",
          revision: "png-r1",
          layerId: "local",
          layerRole: "local",
          outputPath: "assets/demo/textures/block/stone.png",
          getText: () => ""
        }],
        coverage: {
          status: "authoritative",
          revision: "scan-r1",
          coveredScope: request.scope
        }
      })
    });

    const snapshot = await provider.getSnapshot({
      projectId: "project",
      scope: { projectId: "project" },
      requestGeneration: 9
    }, new AbortController().signal);

    assert.strictEqual(snapshot.generation, 9);
    assert.deepStrictEqual(snapshot.producers[0].logicalKeys, [{
      kind: "texture",
      id: "demo:block/stone"
    }]);
  });
});
