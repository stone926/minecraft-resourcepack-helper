import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  compileRsglResourceAnalysis,
  RsglWorkspaceSemanticCache,
  RsglWorkspaceValidationCache
} from "../../../rsgl-core/src";
import {
  isRsglResourceSnapshotInvalidationNotification,
  isRsglResourceSnapshotResponse,
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceSnapshotRequest
} from "../../../rsgl-shared/src";
import { resourceAnalysisConfigurationFor, type RsglValidationSettings } from "../../src/serverCore";
import { RsglResourceAnalysisCache } from "../../src/resourceAnalysisCache";
import {
  RsglResourceSnapshotProtocolError,
  RsglResourceSnapshotService
} from "../../src/resourceSnapshotService";

const emptySettings: RsglValidationSettings = { defaultAssetsPath: null, resourcePackRoots: [] };

describe("RSGL LSP resource snapshot service", () => {
  it("shares one checked analysis with navigation and returns contentless not-modified snapshots", () => {
    const root = createTempRoot("checked");
    const projectRoot = path.join(root, "tooling");
    const sourceRoot = path.join(projectRoot, "src");
    const sourceFile = path.join(sourceRoot, "main.rsgl");
    const outputPack = path.join(root, "output pack");
    const customPack = path.join(root, "custom pack");
    const vanillaRoot = path.join(root, "vanilla assets");
    const localTexture = resourceFile(outputPack, "local.png");
    const customTexture = resourceFile(customPack, "custom.png");
    const vanillaTexture = resourceFile(vanillaRoot, "vanilla.png");
    try {
      for (const fileName of [sourceFile, localTexture, customTexture, vanillaTexture]) {
        fs.mkdirSync(path.dirname(fileName), { recursive: true });
        fs.writeFileSync(fileName, fileName.endsWith(".rsgl") ? sourceText() : Buffer.alloc(0));
      }
      for (const packRoot of [outputPack, customPack]) {
        fs.writeFileSync(path.join(packRoot, "pack.mcmeta"), "{}");
      }
      fs.writeFileSync(path.join(projectRoot, "rsgl.config.json"), JSON.stringify({
        root: "src",
        outDir: path.relative(projectRoot, outputPack),
        defaultAssetsPath: path.relative(projectRoot, vanillaRoot),
        resourcePackRoots: [path.relative(projectRoot, customPack)]
      }));

      const context = projectContext({
        projectId: "project-checked",
        projectRoot,
        sourceRoot,
        outputPack,
        customPack,
        vanillaRoot
      });
      const semanticCache = RsglWorkspaceSemanticCache.create();
      const validationCache = new RsglWorkspaceValidationCache({ watcherTrusted: true });
      let compileCount = 0;
      const analysisCache = new RsglResourceAnalysisCache({
        compile: (program, options) => {
          compileCount++;
          return compileRsglResourceAnalysis(program.files, options);
        }
      });
      const semanticProgram = semanticCache.loadProgramFromDirectory(sourceRoot);

      // This is the exact entry consumed by Definition/References.
      const navigationEntry = analysisCache.getOrCreate(
        semanticProgram,
        resourceAnalysisConfigurationFor(sourceFile, emptySettings, validationCache)
      );
      assert.ok(navigationEntry.analysis.index);

      const service = new RsglResourceSnapshotService({
        loadAnalysis: (sourceRootFileName, project) => analysisCache.getOrCreate(
          semanticCache.loadProgramFromDirectory(sourceRootFileName),
          resourceAnalysisConfigurationFor(sourceRootFileName, emptySettings, validationCache, project)
        )
      });
      const response = service.handle(snapshotRequest(context));
      assert.strictEqual(isRsglResourceSnapshotResponse(response), true);
      assert.strictEqual(response.status, "ok");
      assert.strictEqual(compileCount, 1, "navigation and snapshot must reuse one compiler analysis");
      assert.strictEqual(JSON.stringify(response).includes('"content"'), false);

      const physical = response.edges?.filter(edge => edge.resolvedTarget?.status === "physical") ?? [];
      assert.deepStrictEqual(
        physical.map(edge => [edge.resolutionScope, edge.resolvedTarget?.uri]).sort(),
        [
          ["custom", pathToFileURL(customTexture).toString()],
          ["local", pathToFileURL(localTexture).toString()],
          ["vanilla", pathToFileURL(vanillaTexture).toString()]
        ].sort()
      );

      const notModified = service.handle(snapshotRequest(context, response.revision));
      assert.strictEqual(notModified.status, "notModified");
      assert.strictEqual(notModified.resources, undefined);
      assert.strictEqual(notModified.edges, undefined);
      assert.strictEqual(compileCount, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports skipped malformed modules as partial instead of authoritative absence", () => {
    const root = createTempRoot("partial");
    const sourceRoot = path.join(root, "rsgl");
    const validFile = path.join(sourceRoot, "valid.rsgl");
    const brokenFile = path.join(sourceRoot, "broken.rsgl");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(validFile, "namespace demo\nmodel block valid {}");
      fs.writeFileSync(brokenFile, "model block {");
      fs.writeFileSync(path.join(root, "pack.mcmeta"), "{}");
      const context = projectContext({
        projectId: "project-partial",
        projectRoot: root,
        sourceRoot,
        outputPack: root
      });
      const service = createFilesystemService(sourceRoot);
      const response = service.handle(snapshotRequest(context));

      assert.strictEqual(response.status, "partial");
      assert.strictEqual(response.coverage.status, "partial");
      assert.deepStrictEqual(response.skippedSourceUris, [pathToFileURL(brokenFile).toString()]);
      assert.strictEqual(response.resources?.some(resource =>
        resource.logicalKeys.some(key => key.id === "demo:block/valid")
      ), true);

      const validDocument = service.handle(documentSnapshotRequest(context, validFile));
      assert.strictEqual(validDocument.status, "ok", "an unrelated broken sibling must not empty the document projection");
      const brokenDocument = service.handle(documentSnapshotRequest(context, brokenFile));
      assert.strictEqual(brokenDocument.status, "partial");
      assert.deepStrictEqual(brokenDocument.skippedSourceUris, [pathToFileURL(brokenFile).toString()]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("marks declared non-directory layers unavailable instead of claiming an empty authoritative scope", () => {
    const root = createTempRoot("virtual-layer");
    const sourceRoot = path.join(root, "rsgl");
    const sourceFile = path.join(sourceRoot, "main.rsgl");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(sourceFile, "namespace demo\nmodel block valid {}");
      fs.writeFileSync(path.join(root, "pack.mcmeta"), "{}");
      const base = projectContext({
        projectId: "project-virtual-layer",
        projectRoot: root,
        sourceRoot,
        outputPack: root
      });
      const context: RsglResourceSnapshotRequest["projectContext"] = {
        ...base,
        externalLayers: [{
          layerId: "custom-zip",
          role: "custom",
          source: "zip",
          rootUri: pathToFileURL(path.join(root, "external.zip")).toString(),
          priority: 0,
          metadataRevision: "custom-zip-metadata"
        }]
      };
      const response = createFilesystemService(sourceRoot).handle(snapshotRequest(context));

      assert.strictEqual(response.status, "partial");
      assert.strictEqual(response.coverage.status, "partial");
      assert.strictEqual(response.coverage.status === "partial"
        && response.coverage.unavailableScopes.some(scope =>
          scope.resolutionScopes?.includes("custom")
        ), true);
      assert.strictEqual(response.resources?.length, 1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the host sidecar to analyze a vscode-remote project without native paths in ProjectContext", () => {
    const root = createTempRoot("remote-sidecar");
    const sourceRoot = path.join(root, "rsgl");
    const sourceFile = path.join(sourceRoot, "main.rsgl");
    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(sourceFile, "namespace demo\nmodel block remote {}");
      fs.writeFileSync(path.join(root, "pack.mcmeta"), "{}");
      const remoteRoot = "vscode-remote://ssh-remote+dev/workspace/pack";
      const context: RsglResourceSnapshotRequest["projectContext"] = {
        ...projectContext({
          projectId: "project-remote-sidecar",
          projectRoot: root,
          sourceRoot,
          outputPack: root
        }),
        workspaceFolderUri: remoteRoot,
        projectRootUri: remoteRoot,
        packRootUri: remoteRoot,
        assetsRootUri: `${remoteRoot}/assets`,
        rsglSourceRootUris: [`${remoteRoot}/rsgl`],
        outputPackRootUri: remoteRoot,
        outputAssetsRootUri: `${remoteRoot}/assets`,
        localLayer: {
          layerId: "local-layer",
          role: "local",
          source: "directory",
          rootUri: remoteRoot,
          priority: 0,
          metadataRevision: "local-metadata"
        }
      };
      const service = createFilesystemService(sourceRoot);
      const response = service.handle({
        ...snapshotRequest(context),
        nativePathMappings: [{
          uriRoot: remoteRoot,
          fileSystemPath: root
        }]
      });

      assert.strictEqual(response.status, "ok");
      assert.strictEqual(response.coverage.status, "authoritative");
      assert.strictEqual(response.resources?.some(resource =>
        resource.logicalKeys.some(key => key.id === "demo:block/remote")
      ), true);
      assert.strictEqual(
        response.resources?.[0]?.sourceOrigins[0]?.uri.startsWith(`${remoteRoot}/rsgl/`),
        true
      );
      assert.deepStrictEqual(
        service.invalidations("document", [sourceFile])[0]?.affectedSourceUris,
        [`${remoteRoot}/rsgl/main.rsgl`]
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed/version-mismatched requests and keeps analysis failure unavailable", () => {
    const root = createTempRoot("unavailable");
    const sourceRoot = path.join(root, "rsgl");
    fs.mkdirSync(sourceRoot, { recursive: true });
    const context = projectContext({
      projectId: "project-unavailable",
      projectRoot: root,
      sourceRoot,
      outputPack: root
    });
    try {
      const service = new RsglResourceSnapshotService({
        loadAnalysis: () => {
          throw new Error("analysis failed");
        }
      });
      assert.throws(
        () => service.handle({ protocolVersion: rsglResourceSnapshotProtocolVersion }),
        (error: unknown) => error instanceof RsglResourceSnapshotProtocolError
          && error.code === "invalidRequest"
      );
      assert.throws(
        () => service.handle({ ...snapshotRequest(context), protocolVersion: 99 }),
        (error: unknown) => error instanceof RsglResourceSnapshotProtocolError
          && error.code === "protocolMismatch"
      );

      const response = service.handle(snapshotRequest(context));
      assert.strictEqual(response.status, "unavailable");
      assert.strictEqual(response.coverage.status, "unavailable");
      assert.strictEqual(response.resources, undefined);
      assert.strictEqual(response.edges, undefined);

      const invalidations = service.invalidations("document", [path.join(sourceRoot, "main.rsgl")]);
      assert.strictEqual(invalidations.length, 1);
      assert.strictEqual(isRsglResourceSnapshotInvalidationNotification(invalidations[0]), true);
      assert.strictEqual("resources" in invalidations[0], false);
      assert.strictEqual("edges" in invalidations[0], false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("registers an exact guarded request and a send-only stale invalidation channel", () => {
    const serverSource = fs.readFileSync(path.join(
      process.cwd(),
      "packages",
      "rsgl-lsp",
      "src",
      "server.ts"
    ), "utf8");
    const serviceSource = fs.readFileSync(path.join(
      process.cwd(),
      "packages",
      "rsgl-lsp",
      "src",
      "resourceSnapshotService.ts"
    ), "utf8");

    assert.ok(serverSource.includes("connection.onRequest(rsglResourceSnapshotRequest"));
    assert.ok(serverSource.includes("resourceSnapshotService.handle(request)"));
    assert.ok(serviceSource.includes("isRsglResourceSnapshotRequest"));
    assert.ok(serviceSource.includes("isRsglResourceSnapshotResponse"));
    assert.ok(serverSource.includes("connection.sendNotification(rsglResourceSnapshotInvalidatedNotification"));
    assert.strictEqual(
      serverSource.includes("connection.onNotification(rsglResourceSnapshotInvalidatedNotification"),
      false,
      "the server-to-client stale notification must not be subscribed back into the server"
    );
  });
});

function createFilesystemService(sourceRoot: string): RsglResourceSnapshotService {
  const semanticCache = RsglWorkspaceSemanticCache.create();
  const validationCache = new RsglWorkspaceValidationCache({ watcherTrusted: true });
  const analysisCache = new RsglResourceAnalysisCache();
  return new RsglResourceSnapshotService({
    loadAnalysis: (sourceRootFileName, project, nativePathMappings) => analysisCache.getOrCreate(
      semanticCache.loadProgramFromDirectory(sourceRootFileName || sourceRoot),
      resourceAnalysisConfigurationFor(
        sourceRootFileName || sourceRoot,
        emptySettings,
        validationCache,
        project,
        nativePathMappings
      )
    )
  });
}

function snapshotRequest(
  projectContext: RsglResourceSnapshotRequest["projectContext"],
  knownRevision?: string
): RsglResourceSnapshotRequest {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectContext,
    scope: { kind: "project", projectId: projectContext.projectId },
    ...(knownRevision ? { knownRevision } : {}),
    requestGeneration: 1
  };
}

function documentSnapshotRequest(
  projectContext: RsglResourceSnapshotRequest["projectContext"],
  fileName: string
): RsglResourceSnapshotRequest {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectContext,
    scope: { kind: "document", documentUri: pathToFileURL(fileName).toString() },
    requestGeneration: 2
  };
}

function projectContext(options: {
  projectId: string;
  projectRoot: string;
  sourceRoot: string;
  outputPack: string;
  customPack?: string;
  vanillaRoot?: string;
}): RsglResourceSnapshotRequest["projectContext"] {
  const projectRootUri = pathToFileURL(options.projectRoot).toString();
  const outputPackRootUri = pathToFileURL(options.outputPack).toString();
  return {
    projectId: options.projectId,
    workspaceFolderUri: projectRootUri,
    projectRootUri,
    packRootUri: outputPackRootUri,
    assetsRootUri: pathToFileURL(path.join(options.outputPack, "assets")).toString(),
    rsglSourceRootUris: [pathToFileURL(options.sourceRoot).toString()],
    outputPackRootUri,
    outputAssetsRootUri: pathToFileURL(path.join(options.outputPack, "assets")).toString(),
    localLayer: layer("local", "directory", options.outputPack, 0),
    ...(options.vanillaRoot
      ? { vanillaLayer: layer("vanilla", "directory", options.vanillaRoot, 0) }
      : {}),
    externalLayers: options.customPack
      ? [layer("custom", "directory", options.customPack, 0)]
      : [],
    overlaySelection: [],
    configurationRevision: `configuration:${options.projectId}`,
    contextRevision: `context:${options.projectId}`
  };
}

function layer(
  role: "local" | "custom" | "vanilla",
  source: "directory",
  root: string,
  priority: number
) {
  return {
    layerId: `${role}-layer`,
    role,
    source,
    rootUri: pathToFileURL(root).toString(),
    priority,
    metadataRevision: `${role}-metadata`
  } as const;
}

function resourceFile(packRoot: string, name: string): string {
  return path.join(
    packRoot,
    "assets",
    "demo",
    "textures",
    "block",
    name
  );
}

function sourceText(): string {
  return [
    "namespace demo",
    "extern local texture demo:block/local",
    "extern custom texture demo:block/custom",
    "extern vanilla texture demo:block/vanilla",
    "model block sample {",
    "  textures { a: demo:block/local b: demo:block/custom c: demo:block/vanilla }",
    "}"
  ].join("\n");
}

function createTempRoot(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mc-resourcepack-helper-rsgl-snapshot-${label}-`));
}
