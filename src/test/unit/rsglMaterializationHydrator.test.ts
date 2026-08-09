import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { ResourcePackProjectContextDto } from "../../../packages/resource-project/src";
import {
  hydrateRsglMaterializations,
  rsglMaterializationHydrationConcurrency
} from "../../rsgl/rsglMaterializationHydrator";

describe("RSGL materialization hydrator", () => {
  it("bounds owned-output reads while preserving a complete authoritative snapshot", async () => {
    const context = projectContext();
    const files = Array.from(
      { length: rsglMaterializationHydrationConcurrency * 3 },
      (_, index) => {
        const outputPath = `assets/demo/models/item/generated_${index}.json`;
        const bytes = Buffer.from(`{"index":${index}}\n`);
        return {
          outputPath,
          bytes,
          contentHash: sha256(bytes)
        };
      }
    );
    const manifestUri = `${context.outputPackRootUri}/.rsgl/manifests/${context.projectId}.json`;
    const bytesByUri = new Map(files.map(file => [
      `${context.outputPackRootUri}/${file.outputPath}`,
      file.bytes
    ]));
    let activeReads = 0;
    let maximumActiveReads = 0;
    let binaryReads = 0;

    const result = await hydrateRsglMaterializations(context, {
      listDirectoryUris: async () => [manifestUri],
      readTextUri: async uri => uri === manifestUri
        ? ownershipManifest(context, files)
        : undefined,
      readBinaryUri: async uri => {
        binaryReads++;
        activeReads++;
        maximumActiveReads = Math.max(maximumActiveReads, activeReads);
        await Promise.resolve();
        activeReads--;
        return bytesByUri.get(uri);
      }
    });

    assert.strictEqual(result.expectedManifestVerified, true);
    assert.strictEqual(result.snapshot.status, "authoritative");
    assert.strictEqual(result.snapshot.entries.length, files.length);
    assert.strictEqual(binaryReads, files.length);
    assert.ok(maximumActiveReads > 1);
    assert.ok(maximumActiveReads <= rsglMaterializationHydrationConcurrency);
    assert.ok(result.snapshot.entries.every(entry => entry.state === "current"));
  });

  it("reads a shared output once across ownership manifests and preserves conflicts", async () => {
    const context = projectContext();
    const outputPath = "assets/demo/models/item/shared.json";
    const bytes = Buffer.from("{\"shared\":true}\n");
    const file = { outputPath, bytes, contentHash: sha256(bytes) };
    const ownManifestUri = `${context.outputPackRootUri}/.rsgl/manifests/project.json`;
    const siblingManifestUri = `${context.outputPackRootUri}/.rsgl/manifests/sibling.json`;
    let binaryReads = 0;

    const result = await hydrateRsglMaterializations(context, {
      listDirectoryUris: async () => [siblingManifestUri, ownManifestUri],
      readTextUri: async uri => {
        await Promise.resolve();
        return uri === ownManifestUri
          ? ownershipManifest(context, [file])
          : ownershipManifest(context, [file], "sibling");
      },
      readBinaryUri: async uri => {
        binaryReads++;
        return uri.endsWith(outputPath) ? bytes : undefined;
      }
    });

    assert.strictEqual(binaryReads, 1);
    assert.strictEqual(result.snapshot.status, "authoritative");
    assert.deepStrictEqual(result.snapshot.ownedOutputPaths, [outputPath]);
    assert.strictEqual(result.snapshot.entries.length, 1);
    assert.strictEqual(result.snapshot.entries[0].state, "conflict");
  });
});

function projectContext(): ResourcePackProjectContextDto {
  return {
    projectId: "project",
    workspaceFolderUri: "file:///workspace",
    projectRootUri: "file:///workspace/pack",
    packRootUri: "file:///workspace/pack",
    assetsRootUri: "file:///workspace/pack/assets",
    rsglSourceRootUris: ["file:///workspace/pack/rsgl"],
    outputPackRootUri: "file:///workspace/pack",
    outputAssetsRootUri: "file:///workspace/pack/assets",
    localLayer: {
      layerId: "local",
      role: "local",
      source: "directory",
      rootUri: "file:///workspace/pack",
      priority: 0,
      metadataRevision: "metadata-r1"
    },
    externalLayers: [],
    overlaySelection: [],
    configurationRevision: "configuration-r1",
    contextRevision: "context-r1"
  };
}

function ownershipManifest(
  context: ResourcePackProjectContextDto,
  files: readonly { outputPath: string; contentHash: string }[],
  projectId = context.projectId
): string {
  return JSON.stringify({
    version: 2,
    projectId,
    sourceRoot: "rsgl",
    outputPackRootIdentity: context.localLayer.layerId,
    buildRevision: "ownership-r1",
    files: files.map((file, index) => ({
      outputPath: file.outputPath,
      producerId: `rsgl:${projectId}:${index}`,
      kind: "model",
      logicalKeys: [],
      contentHash: file.contentHash,
      sourceOrigins: []
    }))
  });
}

function sha256(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
