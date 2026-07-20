import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hashRsglOwnedContent,
  nodeAsyncMaterializationHost,
  parseRsglOwnershipManifestV2,
  rsglOwnershipManifestPath,
  runRsglMaterializationTransaction,
  type RsglAsyncMaterializationHost,
  type RsglEmittedFile,
  type RsglMaterializationProject
} from "../../src/compiler";
import { createTempDir } from "./helpers/fs";

describe("RSGL materialization transaction", () => {
  it("commits create/update/delete in order and writes the project manifest last", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-materialization-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    const committedTargets: string[] = [];
    const host: RsglAsyncMaterializationHost = {
      ...nodeAsyncMaterializationHost,
      replaceFile: async (staged, target) => {
        await nodeAsyncMaterializationHost.replaceFile(staged, target);
        committedTargets.push(target);
      }
    };
    try {
      const first = await run(outputRoot, project, [textFile("a.json", "a1"), textFile("b.json", "b1")], {
        host,
        transactionId: "create"
      });
      assert.strictEqual(first.status, "committed");
      assert.deepStrictEqual(first.preview.writePlan.summary, { create: 2, update: 0, unchanged: 0 });
      assert.strictEqual(committedTargets.at(-1), manifestFileName(outputRoot, project));

      committedTargets.length = 0;
      const second = await run(outputRoot, project, [textFile("a.json", "a2"), textFile("c.json", "c1")], {
        host,
        transactionId: "update-delete"
      });
      assert.strictEqual(second.status, "committed");
      assert.deepStrictEqual(second.preview.writePlan.summary, { create: 1, update: 1, unchanged: 0 });
      assert.deepStrictEqual(second.changedPaths, [resourcePath("a.json"), resourcePath("c.json")]);
      assert.deepStrictEqual(second.deletedPaths, [resourcePath("b.json")]);
      assert.strictEqual(fs.existsSync(outputFileName(outputRoot, "b.json")), false);
      assert.strictEqual(committedTargets.at(-1), manifestFileName(outputRoot, project));

      const manifest = parseRsglOwnershipManifestV2(JSON.parse(
        fs.readFileSync(manifestFileName(outputRoot, project), "utf8")
      ));
      assert.deepStrictEqual(manifest.files.map(file => file.outputPath), [
        resourcePath("a.json"),
        resourcePath("c.json")
      ]);
      assert.strictEqual(manifest.files[0].contentHash, hashRsglOwnedContent("a2"));

      const unchanged = await run(outputRoot, project, [textFile("a.json", "a2"), textFile("c.json", "c1")], {
        transactionId: "unchanged"
      });
      assert.strictEqual(unchanged.status, "committed");
      assert.deepStrictEqual(unchanged.preview.writePlan.summary, { create: 0, update: 0, unchanged: 2 });
      assert.deepStrictEqual(unchanged.changedPaths, []);
      assert.strictEqual(unchanged.invalidation?.transactionId, "unchanged");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves modified stale outputs while relinquishing their ownership", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-stale-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    try {
      await run(outputRoot, project, [textFile("keep.json", "keep"), textFile("stale.json", "generated")]);
      fs.writeFileSync(outputFileName(outputRoot, "stale.json"), "user edit");

      const result = await run(outputRoot, project, [textFile("keep.json", "keep")]);

      assert.strictEqual(result.status, "committed");
      assert.deepStrictEqual(result.preview.deletes.map(entry => [entry.outputPath, entry.status, entry.preserveReason]), [
        [resourcePath("stale.json"), "preserve", "userModified"]
      ]);
      assert.strictEqual(fs.readFileSync(outputFileName(outputRoot, "stale.json"), "utf8"), "user edit");
      const manifest = JSON.parse(fs.readFileSync(manifestFileName(outputRoot, project), "utf8")) as { files: Array<{ outputPath: string }> };
      assert.deepStrictEqual(manifest.files.map(file => file.outputPath), [resourcePath("keep.json")]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses handwritten and user-modified collisions even when content matches", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-conflict-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    try {
      fs.mkdirSync(path.dirname(outputFileName(outputRoot, "handwritten.json")), { recursive: true });
      fs.writeFileSync(outputFileName(outputRoot, "handwritten.json"), "same");
      const unowned = await run(outputRoot, project, [textFile("handwritten.json", "same")]);
      assert.strictEqual(unowned.status, "conflict");
      assert.strictEqual(unowned.preview.ownershipPlan.writes[0].conflictReason, "unownedExistingOutput");
      assert.strictEqual(fs.existsSync(manifestFileName(outputRoot, project)), false);

      await run(outputRoot, project, [textFile("owned.json", "generated")]);
      fs.writeFileSync(outputFileName(outputRoot, "owned.json"), "user edit");
      const modified = await run(outputRoot, project, [textFile("owned.json", "next")]);
      assert.strictEqual(modified.status, "conflict");
      assert.strictEqual(modified.preview.ownershipPlan.writes[0].conflictReason, "userModifiedOwnedOutput");
      assert.strictEqual(fs.readFileSync(outputFileName(outputRoot, "owned.json"), "utf8"), "user edit");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("adopts a byte-identical unowned output only with an explicit request", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-adopt-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    const existing = outputFileName(outputRoot, "adopt.json");
    try {
      fs.mkdirSync(path.dirname(existing), { recursive: true });
      fs.writeFileSync(existing, "same");

      const defaultResult = await run(outputRoot, project, [textFile("adopt.json", "same")]);
      assert.strictEqual(defaultResult.status, "conflict");

      const adopted = await run(outputRoot, project, [textFile("adopt.json", "same")], {
        adoptUnownedIdentical: true
      });
      assert.strictEqual(adopted.status, "committed");
      assert.strictEqual(adopted.preview.ownershipPlan.writes[0].action, "adopt");
      assert.deepStrictEqual(adopted.changedPaths, []);
      assert.strictEqual(fs.readFileSync(existing, "utf8"), "same");
      assert.strictEqual(fs.existsSync(manifestFileName(outputRoot, project)), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes in-root and imported sibling origins as portable paths", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-portable-origin-");
    const sourceRoot = path.join(root, "project", "rsgl");
    const localSource = path.join(sourceRoot, "main.rsgl");
    const sharedSource = path.join(root, "shared", "common.rsgl");
    const outputRoot = path.join(root, "pack outside sources");
    const project = materializationProject("project-portable", "pack-portable");
    const file: RsglEmittedFile = {
      ...textFile("portable.json", "{}\n"),
      ownership: {
        kind: "model",
        logicalKeys: [{ kind: "model", id: "demo:item/portable" }],
        sourceOrigins: [localSource, sharedSource].map(sourceFileName => ({
          sourceUri: pathToFileURL(sourceFileName).toString(),
          range: { start: 1, end: 9 }
        }))
      }
    };
    try {
      const result = await run(outputRoot, project, [file], { sourceRootPath: sourceRoot });
      assert.strictEqual(result.status, "committed");
      const serialized = fs.readFileSync(manifestFileName(outputRoot, project), "utf8");
      const manifest = parseRsglOwnershipManifestV2(JSON.parse(serialized));
      assert.deepStrictEqual(manifest.files[0].sourceOrigins.map(origin => origin.sourcePath), [
        "../../shared/common.rsgl",
        "main.rsgl"
      ]);
      assert.doesNotMatch(serialized, /file:|[a-zA-Z]:[\\/]/);
      assert.strictEqual(serialized.includes(root.replaceAll("\\", "/")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("blocks cross-project claims even when the other project's output is absent", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-multi-project-");
    const outputRoot = path.join(root, "pack");
    const projectA = materializationProject("project-a", "shared-pack");
    const projectB = materializationProject("project-b", "shared-pack");
    try {
      await run(outputRoot, projectA, [textFile("shared.json", "a")]);
      fs.unlinkSync(outputFileName(outputRoot, "shared.json"));

      const result = await run(outputRoot, projectB, [textFile("shared.json", "b")]);

      assert.strictEqual(result.status, "conflict");
      assert.strictEqual(result.preview.ownershipPlan.writes[0].conflictReason, "ownedByOtherProject");
      assert.deepStrictEqual(result.preview.ownershipPlan.writes[0].ownerProjectIds, ["project-a"]);
      assert.strictEqual(fs.existsSync(manifestFileName(outputRoot, projectB)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns cancelled before commit and partial when cancellation arrives mid-commit", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-cancel-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    try {
      const cancelled = await runRsglMaterializationTransaction({
        files: [textFile("a.json", "a")],
        outputRoot,
        project,
        transactionId: "cancel-before-stage",
        isCancellationRequested: () => true
      }, nodeAsyncMaterializationHost);
      assert.strictEqual(cancelled.status, "cancelled");
      assert.strictEqual(fs.existsSync(outputRoot), false);

      let cancellationRequested = false;
      let resourcesCommitted = 0;
      const host: RsglAsyncMaterializationHost = {
        ...nodeAsyncMaterializationHost,
        replaceFile: async (staged, target) => {
          await nodeAsyncMaterializationHost.replaceFile(staged, target);
          if (!target.includes(`${path.sep}.rsgl${path.sep}`)) {
            resourcesCommitted++;
            cancellationRequested = true;
          }
        }
      };
      const partial = await runRsglMaterializationTransaction({
        files: [textFile("a.json", "a"), textFile("b.json", "b")],
        outputRoot,
        project,
        transactionId: "cancel-mid-commit",
        isCancellationRequested: () => cancellationRequested
      }, host);

      assert.strictEqual(partial.status, "partial");
      assert.strictEqual(resourcesCommitted, 1);
      assert.deepStrictEqual(partial.changedPaths, [resourcePath("a.json")]);
      assert.strictEqual(partial.invalidation?.state, "partial");
      assert.strictEqual(partial.manifestCommitted, false);
      assert.strictEqual(fs.existsSync(manifestFileName(outputRoot, project)), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a partial result and keeps the old manifest when a later write fails", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-partial-");
    const outputRoot = path.join(root, "pack");
    const project = materializationProject("project-a", "pack-a");
    let writes = 0;
    const host: RsglAsyncMaterializationHost = {
      ...nodeAsyncMaterializationHost,
      replaceFile: async (staged, target) => {
        if (!target.includes(`${path.sep}.rsgl${path.sep}`) && ++writes === 2) {
          throw new Error("locked output");
        }
        await nodeAsyncMaterializationHost.replaceFile(staged, target);
      }
    };
    try {
      await run(outputRoot, project, [textFile("a.json", "a0"), textFile("b.json", "b0")]);
      const previousManifest = fs.readFileSync(manifestFileName(outputRoot, project), "utf8");
      const result = await run(outputRoot, project, [textFile("a.json", "a1"), textFile("b.json", "b1")], {
        host,
        transactionId: "partial-write"
      });

      assert.strictEqual(result.status, "partial");
      assert.deepStrictEqual(result.changedPaths, [resourcePath("a.json")]);
      assert.strictEqual(result.failure?.operation, "write");
      assert.strictEqual(result.failure?.outputPath, resourcePath("b.json"));
      assert.strictEqual(result.manifestCommitted, false);
      assert.strictEqual(fs.readFileSync(manifestFileName(outputRoot, project), "utf8"), previousManifest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes Windows separators and serializes non-ASCII paths as URIs", async () => {
    const root = createTempDir("mc-resourcepack-helper-rsgl-unicode-");
    const outputRoot = path.join(root, "资源 包");
    const project = materializationProject("project-unicode", "pack-unicode");
    try {
      const result = await runRsglMaterializationTransaction({
        files: [{
          outputPath: "assets\\示例\\models\\item\\模型.json",
          content: "{}\n",
          kind: "resource"
        }],
        outputRoot,
        project,
        transactionId: "windows-unicode"
      }, nodeAsyncMaterializationHost);

      assert.strictEqual(result.status, "committed");
      assert.deepStrictEqual(result.changedPaths, ["assets/示例/models/item/模型.json"]);
      assert.ok(result.invalidation?.changedUris.every(uri => uri.startsWith("file:")));
      assert.ok(result.invalidation?.changedUris.some(uri => uri.includes("%E8%B5%84%E6%BA%90%20%E5%8C%85")));
      assert.strictEqual(fs.existsSync(path.join(outputRoot, "assets", "示例", "models", "item", "模型.json")), true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

async function run(
  outputRoot: string,
  project: RsglMaterializationProject,
  files: readonly RsglEmittedFile[],
  options: {
    host?: RsglAsyncMaterializationHost;
    transactionId?: string;
    sourceRootPath?: string;
    adoptUnownedIdentical?: boolean;
  } = {}
) {
  return runRsglMaterializationTransaction({
    files,
    outputRoot,
    project,
    sourceRootPath: options.sourceRootPath,
    adoptUnownedIdentical: options.adoptUnownedIdentical,
    transactionId: options.transactionId
  }, options.host ?? nodeAsyncMaterializationHost);
}

function textFile(name: string, content: string): RsglEmittedFile {
  return { outputPath: resourcePath(name), content, kind: "resource" };
}

function resourcePath(name: string): string {
  return `assets/demo/models/item/${name}`;
}

function outputFileName(outputRoot: string, name: string): string {
  return path.join(outputRoot, "assets", "demo", "models", "item", name);
}

function manifestFileName(outputRoot: string, project: RsglMaterializationProject): string {
  return path.join(outputRoot, ...rsglOwnershipManifestPath(project.projectId).split("/"));
}

function materializationProject(projectId: string, outputPackRootIdentity: string): RsglMaterializationProject {
  return { projectId, sourceRoot: "rsgl", outputPackRootIdentity };
}
