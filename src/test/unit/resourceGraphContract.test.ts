import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

describe("resource graph index contract", () => {
  it("builds incoming references as a shared target index instead of per-target scans", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "resourceGraph.ts"), "utf8");

    assert.ok(source.includes("buildReferenceIndexes"), "incoming references should be built as a shared source pass");
    assert.ok(source.includes("ResourceGraphReferenceIndex"), "incoming references should use the shared incremental target index");
    assert.strictEqual(source.includes("new Map<string, Promise<ResolvedResourceReference[]>>()"), false, "incoming references should not cache one scan per target");
    assert.strictEqual(source.includes("collectIncomingReferences(targetUri"), false, "resource graph should not collect incoming references separately for each target");
    assert.strictEqual(source.includes("createIncomingReferenceSearch"), false, "incoming index should not rebuild candidate searches per target");
  });

  it("keeps workspace query and graph-index ownership outside the TreeDataProvider", () => {
    const treeSource = fs.readFileSync(path.join(process.cwd(), "src", "views", "resourceGraphTree.ts"), "utf8");
    const serviceSource = fs.readFileSync(path.join(process.cwd(), "src", "services", "resourceGraphService.ts"), "utf8");

    assert.strictEqual(treeSource.includes("new ResourceGraphWorkspaceCache"), false);
    assert.strictEqual(treeSource.includes("new ResourceGraphIndex"), false);
    assert.ok(serviceSource.includes("new ResourceGraphWorkspaceCache"));
    assert.ok(serviceSource.includes("new ResourceGraphIndex"));
  });

  it("updates indexed source references without discarding the whole incoming index", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src", "utils", "resourceGraph.ts"), "utf8");

    assert.ok(source.includes("pendingDocuments"));
    assert.ok(source.includes("removeIndexedSource"));
    assert.ok(source.includes("indexDocument(document)"));
    assert.strictEqual(source.includes("invalidateDocument(document: ResourceGraphDocument): void {\n    this.invalidate();"), false);
    const invalidatePath = source.slice(
      source.indexOf("invalidatePath(uri: vscode.Uri"),
      source.indexOf("getReferences(document:")
    );
    assert.ok(invalidatePath.includes("workspaceCache.updatePath(uri, kind)"));
    assert.strictEqual(invalidatePath.includes("workspaceCache.invalidate()"), false);
  });

  it("keeps block inventory snapshots across content-only refreshes", () => {
    const tree = fs.readFileSync(
      path.join(process.cwd(), "src", "views", "resourceGraphTree.ts"),
      "utf8"
    );
    const events = fs.readFileSync(
      path.join(process.cwd(), "src", "registration", "registerWorkspaceEvents.ts"),
      "utf8"
    );

    assert.ok(tree.includes("if (invalidateInventory)"));
    assert.ok(events.includes('kind !== "change" && isBlockstateDocumentPath(uri.fsPath)'));
    assert.ok(events.includes('handleChange(uri, "create")'));
    assert.ok(events.includes('handleChange(uri, "delete")'));
  });

  it("replaces open-document references and reloads disk content after close", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src", "registration", "registerWorkspaceEvents.ts"),
      "utf8"
    );
    const openHandler = source.slice(
      source.indexOf("onDidOpenTextDocument"),
      source.indexOf("onDidCloseTextDocument")
    );
    const closeHandler = source.slice(
      source.indexOf("onDidCloseTextDocument"),
      source.indexOf("onDidChangeConfiguration")
    );

    assert.ok(openHandler.includes("resourceGraph.invalidateDocument(document)"));
    assert.ok(openHandler.includes("resourceGraph.refreshSoon()"));
    assert.ok(closeHandler.includes("resourceGraph.invalidatePath(document.uri)"));
    assert.ok(closeHandler.includes("resourceGraph.refreshSoon()"));
  });
});
