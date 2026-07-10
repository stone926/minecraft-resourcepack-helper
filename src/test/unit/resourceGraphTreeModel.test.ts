import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ResourceGraphTreeModel,
  type ResourceGraphTreeDocument,
  type ResourceGraphTreeModelHost,
  type ResourceGraphTreeResolvedReference,
  type ResourceGraphUriLike
} from "../../views/resourceGraphTreeModel";

describe("resource graph tree model", () => {
  it("builds plain tree nodes without VS Code TreeItem ownership", async () => {
    const blockstate = uri(path.join("pack", "assets", "minecraft", "blockstates", "stone.json"));
    const host = fakeHost({ blockstates: [blockstate] });
    const model = new ResourceGraphTreeModel(host, localize);

    const roots = await model.getRoots(null);

    assert.deepStrictEqual(roots.map(root => root.label), ["Current File", "Blocks"]);
    assert.strictEqual(roots[0].description, "No resource editor");
    assert.strictEqual(roots[1].description, "1");
    const blocks = await roots[1].getChildren();
    assert.strictEqual(blocks[0].label, "stone");
    assert.strictEqual(blocks[0].contextValue, "unsupportedPreviewResource");
    assert.strictEqual("command" in blocks[0], false);
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

  it("keeps the pure model source free of VS Code runtime imports", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "views", "resourceGraphTreeModel.ts"), "utf8");
    assert.strictEqual(source.includes('from "vscode"'), false);
    assert.strictEqual(source.includes("extends vscode.TreeItem"), false);
  });
});

function fakeHost(options: {
  blockstates?: ResourceGraphUriLike[];
  references?: ResourceGraphTreeResolvedReference[];
  incoming?: ResourceGraphTreeResolvedReference[];
  documents?: ResourceGraphTreeDocument[];
}): ResourceGraphTreeModelHost {
  return {
    getBlockstateUris: async () => options.blockstates ?? [],
    getReferences: () => options.references ?? [],
    getIncomingReferences: async () => options.incoming ?? [],
    getChildModelReferences: async () => [],
    loadDocument: async target => {
      const document = options.documents?.find(item => item.uri.fsPath === target.fsPath);
      if (!document) {
        throw new Error("missing test document");
      }
      return document;
    }
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
