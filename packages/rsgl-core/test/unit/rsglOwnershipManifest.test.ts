import * as assert from "node:assert/strict";
import {
  createRsglOwnershipManifestV2,
  hashRsglOwnedContent,
  parseRsglOwnershipManifestV2,
  planRsglOwnedMaterialization,
  rsglOwnershipManifestPath,
  serializeRsglOwnershipManifestV2,
  type RsglOwnershipManifestFileV2,
  type RsglOwnershipManifestV2
} from "../../src/compiler";

describe("RSGL ownership manifest v2", () => {
  it("serializes stable project-scoped portable provenance without absolute paths", () => {
    const manifest = createRsglOwnershipManifestV2({
      projectId: "project-a",
      sourceRoot: "rsgl/src",
      outputPackRootIdentity: "pack:demo",
      buildRevision: "build-r1",
      files: [ownedFile("assets/demo/models/block/b.json", "b"), ownedFile("assets/demo/models/block/a.json", "a")]
    });

    assert.strictEqual(manifest.version, 2);
    assert.deepStrictEqual(manifest.files.map(file => file.outputPath), [
      "assets/demo/models/block/a.json",
      "assets/demo/models/block/b.json"
    ]);
    assert.strictEqual(rsglOwnershipManifestPath(manifest.projectId), ".rsgl/manifests/project-a.json");
    assert.notStrictEqual(rsglOwnershipManifestPath("project/a"), rsglOwnershipManifestPath("project?a"));
    assert.deepStrictEqual(parseRsglOwnershipManifestV2(JSON.parse(
      serializeRsglOwnershipManifestV2(manifest)
    )), manifest);
  });

  it("rejects legacy manifests, unsafe paths, duplicate outputs, and malformed hashes", () => {
    assert.throws(() => parseRsglOwnershipManifestV2({ version: 1, files: [] }), /Unsupported/);
    assert.throws(() => createRsglOwnershipManifestV2({
      projectId: "project",
      sourceRoot: ".",
      outputPackRootIdentity: "pack",
      buildRevision: "r1",
      files: [ownedFile("../outside.json", "outside")]
    }), /must not escape/);
    assert.throws(() => createRsglOwnershipManifestV2({
      projectId: "project",
      sourceRoot: ".",
      outputPackRootIdentity: "pack",
      buildRevision: "r1",
      files: [ownedFile(".rsgl/manifests/hijack.json", "outside")]
    }), /reserved .rsgl/);
    assert.throws(() => createRsglOwnershipManifestV2({
      projectId: "project",
      sourceRoot: ".",
      outputPackRootIdentity: "pack",
      buildRevision: "r1",
      files: [ownedFile("assets/demo/a.json", "a"), ownedFile("assets/demo/a.json", "b")]
    }), /Duplicate manifest file path/);
    assert.throws(() => createRsglOwnershipManifestV2({
      projectId: "project",
      sourceRoot: ".",
      outputPackRootIdentity: "pack",
      buildRevision: "r1",
      files: [{ ...ownedFile("assets/demo/a.json", "a"), contentHash: "md5:nope" }]
    }), /SHA-256/);
    assert.throws(() => createRsglOwnershipManifestV2({
      projectId: "project",
      sourceRoot: ".",
      outputPackRootIdentity: "pack",
      buildRevision: "r1",
      files: [{
        ...ownedFile("assets/demo/a.json", "a"),
        sourceOrigins: [{ sourcePath: "file:///workspace/private/main.rsgl" }]
      }]
    }), /without a URI scheme/);
  });

  it("classifies create, update, and unchanged only when current ownership hash is intact", () => {
    const previous = manifest("project-a", [
      ownedFile("assets/demo/models/block/unchanged.json", "same"),
      ownedFile("assets/demo/models/block/update.json", "old")
    ]);
    const planned = [
      ownedFile("assets/demo/models/block/create.json", "new"),
      ownedFile("assets/demo/models/block/unchanged.json", "same"),
      ownedFile("assets/demo/models/block/update.json", "new")
    ];
    const plan = planRsglOwnedMaterialization({
      projectId: "project-a",
      previousManifest: previous,
      plannedOutputs: planned,
      existingOutputs: previous.files.map(file => ({
        outputPath: file.outputPath,
        contentHash: file.contentHash
      }))
    });

    assert.deepStrictEqual(plan.writes.map(entry => [entry.output.outputPath, entry.action]), [
      ["assets/demo/models/block/create.json", "create"],
      ["assets/demo/models/block/unchanged.json", "unchanged"],
      ["assets/demo/models/block/update.json", "update"]
    ]);
    assert.strictEqual(plan.hasConflicts, false);
  });

  it("refuses unowned, user-modified, and cross-project collisions by default", () => {
    const modified = ownedFile("assets/demo/models/block/modified.json", "old");
    const previous = manifest("project-a", [modified]);
    const other = manifest("project-b", [ownedFile("assets/demo/models/block/other.json", "other")]);
    const planned = [
      ownedFile("assets/demo/models/block/unowned.json", "same-as-disk"),
      ownedFile("assets/demo/models/block/modified.json", "next"),
      ownedFile("assets/demo/models/block/other.json", "next")
    ];
    const plan = planRsglOwnedMaterialization({
      projectId: "project-a",
      previousManifest: previous,
      otherManifests: [other],
      plannedOutputs: planned,
      existingOutputs: [{
        outputPath: "assets/demo/models/block/unowned.json",
        contentHash: planned[0].contentHash
      }, {
        outputPath: modified.outputPath,
        contentHash: hashRsglOwnedContent("user edit")
      }, {
        outputPath: other.files[0].outputPath,
        contentHash: other.files[0].contentHash
      }]
    });

    assert.deepStrictEqual(plan.writes.map(entry => [entry.output.outputPath, entry.conflictReason]), [
      ["assets/demo/models/block/modified.json", "userModifiedOwnedOutput"],
      ["assets/demo/models/block/other.json", "ownedByOtherProject"],
      ["assets/demo/models/block/unowned.json", "unownedExistingOutput"]
    ]);
    assert.strictEqual(plan.hasConflicts, true);
  });

  it("adopts an unowned output only through the explicit byte-identical flow", () => {
    const output = ownedFile("assets/demo/models/block/existing.json", "same");
    const adopted = planRsglOwnedMaterialization({
      projectId: "project-a",
      plannedOutputs: [output],
      existingOutputs: [{ outputPath: output.outputPath, contentHash: output.contentHash }],
      adoptUnownedIdentical: true
    });
    const different = planRsglOwnedMaterialization({
      projectId: "project-a",
      plannedOutputs: [output],
      existingOutputs: [{
        outputPath: output.outputPath,
        contentHash: hashRsglOwnedContent("different")
      }],
      adoptUnownedIdentical: true
    });

    assert.strictEqual(adopted.writes[0].action, "adopt");
    assert.strictEqual(adopted.hasConflicts, false);
    assert.strictEqual(different.writes[0].action, "conflict");
    assert.strictEqual(different.writes[0].conflictReason, "unownedExistingOutput");
  });

  it("keeps another project's ownership authoritative while its output is absent", () => {
    const output = ownedFile("assets/demo/models/block/shared.json", "other");
    const plan = planRsglOwnedMaterialization({
      projectId: "project-a",
      plannedOutputs: [{ ...output, contentHash: hashRsglOwnedContent("next") }],
      otherManifests: [manifest("project-b", [output])],
      existingOutputs: []
    });

    assert.strictEqual(plan.writes[0].action, "conflict");
    assert.strictEqual(plan.writes[0].conflictReason, "ownedByOtherProject");
    assert.deepStrictEqual(plan.writes[0].ownerProjectIds, ["project-b"]);
  });

  it("deletes stale outputs only while ownership and the previous content hash still agree", () => {
    const safe = ownedFile("assets/demo/models/block/safe.json", "safe");
    const modified = ownedFile("assets/demo/models/block/modified.json", "old");
    const absent = ownedFile("assets/demo/models/block/absent.json", "absent");
    const shared = ownedFile("assets/demo/models/block/shared.json", "shared");
    const previous = manifest("project-a", [safe, modified, absent, shared]);
    const plan = planRsglOwnedMaterialization({
      projectId: "project-a",
      previousManifest: previous,
      otherManifests: [manifest("project-b", [shared])],
      plannedOutputs: [],
      existingOutputs: [{ outputPath: safe.outputPath, contentHash: safe.contentHash }, {
        outputPath: modified.outputPath,
        contentHash: hashRsglOwnedContent("user edit")
      }, {
        outputPath: shared.outputPath,
        contentHash: shared.contentHash
      }]
    });

    assert.deepStrictEqual(plan.stale.map(entry => [
      entry.previous.outputPath,
      entry.action,
      entry.preserveReason
    ]), [
      ["assets/demo/models/block/absent.json", "alreadyAbsent", undefined],
      ["assets/demo/models/block/modified.json", "preserve", "userModified"],
      ["assets/demo/models/block/safe.json", "delete", undefined],
      ["assets/demo/models/block/shared.json", "preserve", "ownedByOtherProject"]
    ]);
  });

  function manifest(projectId: string, files: readonly RsglOwnershipManifestFileV2[]): RsglOwnershipManifestV2 {
    return createRsglOwnershipManifestV2({
      projectId,
      sourceRoot: "rsgl",
      outputPackRootIdentity: "pack",
      buildRevision: `${projectId}-r1`,
      files
    });
  }

  function ownedFile(outputPath: string, content: string): RsglOwnershipManifestFileV2 {
    const resourcePath = outputPath.split("/models/")[1]?.replace(/\.json$/, "") ?? "unknown";
    return {
      outputPath,
      producerId: `producer:${resourcePath}`,
      kind: "model",
      logicalKeys: [{ kind: "model", id: `demo:${resourcePath}` }],
      contentHash: hashRsglOwnedContent(content),
      sourceMapPath: `${outputPath}.rsgl.map`,
      sourceOrigins: [{
        sourcePath: "main.rsgl",
        range: { start: 0, end: 10 }
      }]
    };
  }
});
