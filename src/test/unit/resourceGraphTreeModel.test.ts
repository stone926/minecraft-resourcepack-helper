import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ResourceGraphTreeModel,
  type ResourceGraphTreeDocument,
  type ResourceGraphBlockInventory,
  type ResourceGraphDocumentProjection,
  type ResourceGraphProjectedResource,
  type ResourceGraphTreeModelHost,
  type ResourceGraphTreeResolvedReference,
  type ResourceGraphUriLike
} from "../../views/resourceGraphTreeModel";

describe("resource graph tree model", () => {
  it("builds plain tree nodes without VS Code TreeItem ownership", async () => {
    const blockstate = uri(path.join("pack", "assets", "minecraft", "blockstates", "stone.json"));
    let inventoryRequests = 0;
    const host = fakeHost({
      blockstates: [blockstate],
      onInventoryRequest: () => inventoryRequests++
    });
    const model = new ResourceGraphTreeModel(host, localize);

    const roots = await model.getRoots(null);

    assert.deepStrictEqual(roots.map(root => root.label), ["Current File", "Blocks"]);
    assert.strictEqual(roots[0].description, "No resource editor");
    assert.strictEqual(roots[1].description, undefined);
    assert.strictEqual(inventoryRequests, 0, "root rendering must not pull block inventory");
    const blocks = await roots[1].getChildren();
    assert.strictEqual(inventoryRequests, 1);
    assert.strictEqual(blocks[0].label, "stone");
    assert.strictEqual(blocks[0].contextValue, "unsupportedPreviewResource");
    assert.strictEqual("command" in blocks[0], false);
  });

  it("shows partial block coverage explicitly after deferred expansion", async () => {
    const blockstate = uri(path.join("pack", "assets", "minecraft", "blockstates", "stone.json"));
    const model = new ResourceGraphTreeModel(fakeHost({
      blockInventory: {
        status: "partial",
        uris: [blockstate],
        reason: "archive layer unavailable"
      }
    }), localize);

    const roots = await model.getRoots(null);
    const blocks = await roots[1].getChildren();

    assert.deepStrictEqual(blocks.map(node => [node.label, node.icon]), [
      ["Block inventory is partial", "warning"],
      ["stone", "symbol-structure"]
    ]);
    assert.strictEqual(blocks[0].description, "archive layer unavailable");
  });

  it("keeps outgoing and incoming graph sections lazy and model-only", async () => {
    const sourceUri = uri(path.join("pack", "assets", "minecraft", "models", "block", "source.json"));
    const targetUri = uri(path.join("pack", "assets", "minecraft", "models", "block", "target.json"));
    const document: ResourceGraphTreeDocument = {
      uri: sourceUri,
      fileName: sourceUri.fsPath,
      languageId: "json",
      version: 1,
      getText: () => "{}"
    };
    const reference = resolvedReference(sourceUri, targetUri, "minecraft:block/target");
    const host = fakeHost({ references: [reference], incoming: [reference], documents: [document] });
    const model = new ResourceGraphTreeModel(host, localize);

    const [current] = await model.getRoots(document);
    assert.strictEqual(current.contextValue, "modelResource");
    const sections = await current.getChildren();

    assert.deepStrictEqual(sections.map(section => section.label), [
      "References",
      "Referenced By",
      "Model Inheritance"
    ]);
    const outgoing = await sections[0].getChildren();
    assert.strictEqual(outgoing[0].label, "model: minecraft:block/target");
    assert.strictEqual(outgoing[0].contextValue, "modelResource");
  });

  it("projects an active RSGL document into generated and contributor groups without loading Blocks", async () => {
    const sourceUri = uri(path.join("pack", "rsgl", "main.rsgl"));
    const document: ResourceGraphTreeDocument = {
      uri: sourceUri,
      fileName: sourceUri.fsPath,
      languageId: "rsgl",
      version: 3,
      getText: () => ""
    };
    const generated = projectedGenerated("generated", "unbuilt", sourceUri.toString(), 8, 21);
    const contributed = projectedGenerated("from-template", "current", "file:///pack/rsgl/owner.rsgl", 30, 44, sourceUri.toString());
    let inventoryRequests = 0;
    const model = new ResourceGraphTreeModel(fakeHost({
      projection: {
        applicable: true,
        providerIds: ["rsgl"],
        coverage: "authoritative",
        providerCoverages: [{ providerId: "rsgl", coverage: "authoritative" }],
        resources: [generated],
        contributesTo: [contributed]
      },
      onInventoryRequest: () => inventoryRequests++
    }), localize);

    const roots = await model.getRoots(document);

    assert.strictEqual(inventoryRequests, 0);
    const currentGroups = await roots[0].getChildren();
    assert.deepStrictEqual(currentGroups.map(node => node.label), ["Generated Resources", "Contributes To"]);
    const generatedNodes = await currentGroups[0].getChildren();
    assert.strictEqual(generatedNodes[0].label, "model demo:block/generated");
    assert.strictEqual(generatedNodes[0].description, "unbuilt · RSGL");
    assert.strictEqual(generatedNodes[0].contextValue, "resourceGraphGeneratedModelUnbuilt");
    assert.strictEqual(generatedNodes[0].resourceUri, undefined, "unbuilt models cannot expose physical preview URIs");
    const sections = await generatedNodes[0].getChildren();
    assert.deepStrictEqual(sections.map(section => section.label), [
      "Origins",
      "References",
      "Referenced By",
      "Model Inheritance"
    ]);
    const origins = await sections[0].getChildren();
    assert.strictEqual(origins[0].description, "primary source · 8–21");
    const contributedNodes = await currentGroups[1].getChildren();
    assert.strictEqual(contributedNodes[0].label, "model demo:block/from-template");
  });

  it("focuses a searched resource without re-projecting the active editor", async () => {
    const activeUri = uri(path.join("pack", "assets", "minecraft", "models", "block", "active.json"));
    const document: ResourceGraphTreeDocument = {
      uri: activeUri,
      fileName: activeUri.fsPath,
      languageId: "json",
      version: 1,
      getText: () => "{}"
    };
    const focused = projectedGenerated(
      "focused",
      "current",
      "file:///pack/rsgl/main.rsgl",
      4,
      18
    );
    let projectionRequests = 0;
    const model = new ResourceGraphTreeModel(fakeHost({
      onProjectionRequest: () => projectionRequests++
    }), localize);

    const roots = await model.getRoots(document, focused);

    assert.strictEqual(projectionRequests, 0);
    assert.deepStrictEqual(roots.map(root => root.label), ["Selected Resource", "Blocks"]);
    assert.strictEqual(roots[0].description, "model demo:block/focused");
    assert.strictEqual(roots[0].resource, focused);
    assert.strictEqual(roots[0].contextValue, "resourceGraphGeneratedModelCurrent");
    assert.deepStrictEqual(
      (await roots[0].getChildren()).map(section => section.label),
      ["Origins", "References", "Referenced By", "Model Inheritance"]
    );
  });

  it("reuses producer relations and conflict ownership for a focused physical resource", async () => {
    const focused = projectedPhysical("texture", "demo:block/stone", "conflict");
    const model = new ResourceGraphTreeModel(fakeHost({}), localize);

    const [root] = await model.getRoots(null, focused);
    const sections = await root.getChildren();

    assert.strictEqual(root.label, "Selected Resource");
    assert.strictEqual(root.description, "texture demo:block/stone");
    assert.strictEqual(root.contextValue, "resourceGraphFocusedResourceConflict");
    assert.strictEqual(root.resource, focused);
    assert.ok(root.resourceUri?.fsPath.endsWith("stone.png"));
    assert.deepStrictEqual(
      sections.map(section => section.label),
      ["Origins", "References", "Referenced By"]
    );
    const origins = await sections[0].getChildren();
    assert.strictEqual(origins[0].description, "Handwritten");
  });

  it("keeps generated conflict actions bound to the generated source", async () => {
    const current = projectedGenerated(
      "conflicted",
      "current",
      "file:///pack/rsgl/main.rsgl",
      2,
      12
    );
    const focused: ResourceGraphProjectedResource = {
      ...current,
      producer: {
        ...current.producer,
        materializationState: "conflict"
      },
      resolutionStatus: "conflict"
    };
    const model = new ResourceGraphTreeModel(fakeHost({}), localize);

    const [root] = await model.getRoots(null, focused);

    assert.strictEqual(root.contextValue, "resourceGraphGeneratedModelConflict");
    assert.strictEqual(root.resourceUri, undefined);
  });

  it("uses RSGL-specific coverage and shows a genuine snapshot warning only once", async () => {
    const sourceUri = uri(path.join("pack", "rsgl", "main.rsgl"));
    const document: ResourceGraphTreeDocument = {
      uri: sourceUri,
      fileName: sourceUri.fsPath,
      languageId: "rsgl",
      version: 3,
      getText: () => ""
    };
    const aggregatePartial = new ResourceGraphTreeModel(fakeHost({
      projection: {
        applicable: true,
        providerIds: ["physical", "rsgl"],
        coverage: "partial",
        providerCoverages: [
          { providerId: "physical", coverage: "partial" },
          { providerId: "rsgl", coverage: "authoritative" }
        ],
        resources: [],
        contributesTo: []
      }
    }), localize);
    const [aggregateCurrent] = await aggregatePartial.getRoots(document);
    assert.deepStrictEqual(
      (await aggregateCurrent.getChildren()).map(node => node.label),
      ["Generated Resources", "Contributes To"]
    );

    const rsglPartial = new ResourceGraphTreeModel(fakeHost({
      projection: {
        applicable: true,
        providerIds: ["rsgl"],
        coverage: "partial",
        providerCoverages: [{ providerId: "rsgl", coverage: "partial" }],
        resources: [],
        contributesTo: []
      }
    }), localize);
    const [partialCurrent] = await rsglPartial.getRoots(document);
    assert.deepStrictEqual(
      (await partialCurrent.getChildren()).map(node => node.label),
      [
        "RSGL resource snapshot is partial",
        "Generated Resources",
        "Contributes To"
      ]
    );
  });

  it("keeps the pure model source free of VS Code runtime imports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "views", "resourceGraphTreeModel.ts"), "utf8");
    assert.strictEqual(source.includes('from "vscode"'), false);
    assert.strictEqual(source.includes("extends vscode.TreeItem"), false);
  });
});

function fakeHost(options: {
  blockstates?: ResourceGraphUriLike[];
  blockInventory?: ResourceGraphBlockInventory;
  onInventoryRequest?: () => void;
  onProjectionRequest?: () => void;
  references?: ResourceGraphTreeResolvedReference[];
  incoming?: ResourceGraphTreeResolvedReference[];
  documents?: ResourceGraphTreeDocument[];
  projection?: ResourceGraphDocumentProjection;
}): ResourceGraphTreeModelHost {
  return {
    getDocumentProjection: async () => {
      options.onProjectionRequest?.();
      return options.projection ?? {
        applicable: true,
        providerIds: ["physical"],
        coverage: "authoritative",
        providerCoverages: [{ providerId: "physical", coverage: "authoritative" }],
        resources: [],
        contributesTo: []
      };
    },
    getBlockstateInventory: async () => {
      options.onInventoryRequest?.();
      return options.blockInventory ?? {
        status: "authoritative",
        uris: options.blockstates ?? []
      };
    },
    getReferences: async () => options.references ?? [],
    getIncomingReferences: async () => options.incoming ?? [],
    getChildModelReferences: async () => [],
    getProducerReferences: async () => options.references ?? [],
    getProducerIncomingReferences: async () => options.incoming ?? [],
    getProducerChildModelReferences: async () => [],
    loadDocument: async target => {
      const document = options.documents?.find(item => item.uri.fsPath === target.fsPath);
      if (!document) {
        throw new Error("missing test document");
      }
      return document;
    }
  };
}

function projectedGenerated(
  name: string,
  state: "unbuilt" | "current",
  sourceUri: string,
  start: number,
  end: number,
  contributorUri?: string
): ResourceGraphProjectedResource {
  const target = { kind: "model", id: `demo:block/${name}` };
  return {
    target,
    producer: {
      producerId: `rsgl:project:${name}`,
      providerId: "rsgl",
      projectId: "project",
      layerId: "local",
      layerRole: "local",
      origin: "generated",
      logicalKeys: [target],
      sourceOrigins: [
        { uri: sourceUri, range: { start, end }, origin: "generated", editable: true },
        ...(contributorUri ? [{
          uri: contributorUri,
          range: { start: start + 1, end: end + 1 },
          origin: "generated" as const,
          editable: true
        }] : [])
      ],
      physicalOrigins: state === "current"
        ? [{
            uri: `file:///pack/assets/demo/models/block/${name}.json`,
            origin: "materialized",
            editable: true
          }]
        : [],
      materializationState: state,
      outputPath: `assets/demo/models/block/${name}.json`,
      revision: "r1"
    }
  };
}

function projectedPhysical(
  kind: "model" | "blockstate" | "texture",
  id: string,
  resolutionStatus: "resolved" | "conflict"
): ResourceGraphProjectedResource {
  const target = { kind, id };
  const extension = kind === "texture" ? "png" : "json";
  const directory = kind === "blockstate" ? "blockstates" : `${kind}s`;
  const producer = {
    producerId: `physical:project:${kind}:${id}`,
    providerId: "physical",
    projectId: "project",
    layerId: "local",
    layerRole: "local" as const,
    origin: "physical" as const,
    logicalKeys: [target],
    sourceOrigins: [],
    physicalOrigins: [{
      uri: `file:///pack/assets/demo/${directory}/block/stone.${extension}`,
      origin: "physical" as const,
      editable: true
    }],
    materializationState: "handwritten" as const,
    outputPath: `assets/demo/${directory}/block/stone.${extension}`,
    revision: "r1"
  };
  return {
    target,
    producer,
    candidates: resolutionStatus === "conflict" ? [producer, { ...producer, producerId: `${producer.producerId}:lower` }] : [producer],
    resolutionStatus
  };
}

function resolvedReference(
  sourceUri: ResourceGraphUriLike,
  targetUri: ResourceGraphUriLike,
  value: string
): ResourceGraphTreeResolvedReference {
  return {
    sourceUri,
    targetUri,
    reference: {
      value,
      valueNode: {},
      target: "models",
      source: "assets",
      extension: "json",
      kind: "model"
    }
  };
}

function uri(fsPath: string): ResourceGraphUriLike {
  return { scheme: "file", fsPath, toString: () => `file://${fsPath}` };
}

function localize(message: string, ...args: Array<string | number>): string {
  let result = message;
  args.forEach((value, index) => {
    result = result.replace(`{${index}}`, String(value));
  });
  return result;
}
