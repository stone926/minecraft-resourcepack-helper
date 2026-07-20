import * as assert from "node:assert";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileRsglResourceAnalysis,
  createRsglResourceSnapshot
} from "../../src/compiler";
import { parseRsgl } from "../../src/parser";

describe("RSGL contentless resource snapshot", () => {
  it("records per-final-unit generated and physical edges with source-owned metadata", () => {
    const fileName = path.resolve("snapshot project", "资源", "main.rsgl");
    const localTexture = path.resolve("snapshot project", "pack", "assets", "demo", "textures", "block", "stone.png");
    const source = [
      "namespace demo",
      "extern local texture demo:block/stone",
      "model block parent { textures { all: demo:block/stone } }",
      "model block child { parent demo:block/parent }",
      "blockstate variants sample { case * => demo:block/child }"
    ].join("\n");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }], {
      externResourceResolution: (origin, kind, id) => ({
        resolvedPath: origin === "local" && kind === "texture" && id === "demo:block/stone"
          ? localTexture
          : null,
        candidatePaths: [localTexture],
        metadataPaths: [path.resolve("snapshot project", "pack", "pack.mcmeta")]
      })
    });
    const snapshot = createRsglResourceSnapshot(analysis, {
      projectId: "project-a",
      analysisRevision: "semantic-r7",
      documentFact: candidate => candidate === fileName
        ? { version: 7, signature: "sha256:document" }
        : undefined
    });

    assert.deepStrictEqual(snapshot.resources.map(resource => resource.logicalKeys[0]), [
      { kind: "blockstate", id: "demo:sample" },
      { kind: "model", id: "demo:block/child" },
      { kind: "model", id: "demo:block/parent" }
    ]);
    assert.deepStrictEqual(snapshot.edges.map(edge => [
      edge.relationship,
      edge.target,
      edge.resolutionScope,
      edge.resolvedTarget.status
    ]), [
      ["blockstateModel", { kind: "model", id: "demo:block/child" }, "effective", "generated"],
      ["modelInheritance", { kind: "model", id: "demo:block/parent" }, "effective", "generated"],
      ["texture", { kind: "texture", id: "demo:block/stone" }, "local", "physical"]
    ]);
    const physical = snapshot.edges.find(edge => edge.resolvedTarget.status === "physical");
    assert.ok(physical);
    assert.ok(physical.resolvedTarget.uri?.startsWith("file:"));
    assert.deepStrictEqual(physical.resolvedTarget.candidateUris, [physical.resolvedTarget.uri]);
    assert.strictEqual(physical?.sourceLocation.documentVersion, 7);
    assert.strictEqual(physical?.sourceLocation.documentSignature, "sha256:document");
    assert.ok(physical?.sourceGeneratedPath?.startsWith("/textures/"));
    assert.strictEqual(JSON.stringify(snapshot).includes('"content"'), false);
  });

  it("keeps one template origin attached to every concrete final output", () => {
    const fileName = path.resolve("snapshot-template.rsgl");
    const source = [
      "namespace demo",
      "template emit(id: String) {",
      "  model block id {}",
      "}",
      "for id in [stone, dirt] { use emit(id) }"
    ].join("\n");
    const analysis = compileRsglResourceAnalysis([{ fileName, module: parseRsgl(source) }]);
    const snapshot = createRsglResourceSnapshot(analysis, { projectId: "project-template" });

    assert.deepStrictEqual(snapshot.resources.map(resource => resource.logicalKeys[0].id), [
      "demo:block/dirt",
      "demo:block/stone"
    ]);
    assert.strictEqual(snapshot.resources[0].sourceOrigins[0].uri, snapshot.resources[1].sourceOrigins[0].uri);
    assert.deepStrictEqual(snapshot.resources[0].sourceOrigins[0].range, snapshot.resources[1].sourceOrigins[0].range);
    assert.strictEqual(snapshot.edges.length, 0);
  });

  it("isolates malformed siblings and never invents edges for generic JSON strings", () => {
    const validFileName = path.resolve("snapshot-siblings", "valid.rsgl");
    const brokenFileName = path.resolve("snapshot-siblings", "broken.rsgl");
    const valid = [
      "namespace demo",
      "model block valid {}",
      "json \"assets/demo/custom/plain.json\" { value \"demo:block/valid\" }"
    ].join("\n");
    const analysis = compileRsglResourceAnalysis([
      { fileName: validFileName, module: parseRsgl(valid) },
      { fileName: brokenFileName, module: parseRsgl("model block {") }
    ]);
    const snapshot = createRsglResourceSnapshot(analysis, { projectId: "project-partial" });

    assert.deepStrictEqual(snapshot.skippedSourceUris, [pathToFileURL(brokenFileName).toString()]);
    assert.strictEqual(snapshot.resources.some(resource => resource.logicalKeys[0].id === "demo:block/valid"), true);
    assert.strictEqual(snapshot.edges.length, 0);
  });

  it("changes revision when producer content changes while preserving stable identities", () => {
    const fileName = path.resolve("snapshot-revision.rsgl");
    const create = (ambient: boolean) => createRsglResourceSnapshot(
      compileRsglResourceAnalysis([{
        fileName,
        module: parseRsgl(`namespace demo\nmodel block stable { ambientocclusion ${ambient} }`)
      }]),
      { projectId: "project-revision" }
    );
    const before = create(true);
    const after = create(false);

    assert.strictEqual(before.resources[0].producerId, after.resources[0].producerId);
    assert.notStrictEqual(before.resources[0].revision, after.resources[0].revision);
    assert.notStrictEqual(before.revision, after.revision);
  });
});
