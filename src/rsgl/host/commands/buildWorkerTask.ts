import {
  compileRsglDirectory,
  emitRsglFiles
} from "../../../../packages/rsgl-core/src/compiler";
import {
  prepareRsglResourcePackBuild,
  prepareRsglResourcePackDirectoryBuild,
  previewRsglResourcePackBuild,
  previewRsglResourcePackDirectoryBuild,
  type RsglBuildOptions,
  type RsglBuildPreviewResult
} from "../../../../packages/rsgl-core/src/build";
import { createRsglWorkspaceValidationOptions } from "../../../../packages/rsgl-core/src/workspaceValidation";
import type {
  RsglAnyWorkerRequest,
  RsglAnyWorkerResponse,
  RsglWorkerBuildContext,
  RsglWorkerCompileConfiguration,
  RsglWorkerCompileDirectoryContext,
  RsglWorkerValidationConfiguration
} from "./buildWorkerProtocol";

export function executeRsglWorkerTask(
  request: RsglAnyWorkerRequest,
  isCancellationRequested: () => boolean
): RsglAnyWorkerResponse {
  if (isCancellationRequested()) {
    return { type: "cancelled" };
  }

  switch (request.kind) {
    case "prepareBuild": {
      const options = createBuildOptions(request.payload, isCancellationRequested);
      const result = request.payload.source.kind === "directory"
        ? prepareRsglResourcePackDirectoryBuild(request.payload.source.path, options)
        : prepareRsglResourcePackBuild(request.payload.source.path, options);
      return result.cancelled || isCancellationRequested()
        ? { type: "cancelled" }
        : { type: "success", kind: request.kind, result };
    }
    case "previewBuild": {
      const options = createBuildOptions(request.payload, isCancellationRequested);
      const result = request.payload.source.kind === "directory"
        ? previewRsglResourcePackDirectoryBuild(request.payload.source.path, options)
        : previewRsglResourcePackBuild(request.payload.source.path, options);
      return result.cancelled || isCancellationRequested()
        ? { type: "cancelled" }
        : { type: "success", kind: request.kind, result: compactBuildPreviewResult(result) };
    }
    case "compileDirectory": {
      const result = compileRsglDirectory(request.payload.sourceRoot, {
        ...createValidationOptions(request.payload),
        stdlibRoot: request.payload.stdlibRoot
      });
      if (isCancellationRequested()) {
        return { type: "cancelled" };
      }
      const success = !result.diagnostics.some(diagnostic => diagnostic.severity === "error");
      const emittedFiles = success
        ? emitRsglFiles(result.units, {
          sourceMaps: request.payload.sourceMaps ?? true,
          manifest: request.payload.manifest ?? true
        })
        : [];
      return isCancellationRequested()
        ? { type: "cancelled" }
        : {
          type: "success",
          kind: request.kind,
          result: {
            success,
            diagnostics: result.diagnostics,
            dependencies: result.dependencies,
            emittedFiles
          }
        };
    }
  }
}

function compactBuildPreviewResult(result: RsglBuildPreviewResult): RsglBuildPreviewResult {
  return {
    diagnostics: result.diagnostics,
    dependencies: result.dependencies,
    preview: result.preview,
    plan: result.plan ? {
      outputRoot: result.plan.outputRoot,
      entries: [],
      summary: result.plan.summary
    } : undefined
  };
}

function createBuildOptions(
  context: RsglWorkerBuildContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration,
  isCancellationRequested: () => boolean
): RsglBuildOptions & { stdlibRoot: string } {
  return {
    outputRoot: context.outputRoot,
    sourceMaps: context.sourceMaps,
    manifest: context.manifest,
    previewMessages: context.previewMessages,
    materializationProject: context.materializationProject,
    materializationSourceRoot: context.materializationSourceRoot,
    adoptUnownedIdentical: context.adoptUnownedIdentical,
    stdlibRoot: context.stdlibRoot,
    isCancellationRequested,
    ...createValidationOptions(context)
  };
}

function createValidationOptions(
  context: (RsglWorkerBuildContext | RsglWorkerCompileDirectoryContext)
    & RsglWorkerValidationConfiguration
    & RsglWorkerCompileConfiguration
) {
  return {
    namespace: context.namespace,
    defaultNamespace: context.defaultNamespace,
    projectTarget: context.projectTarget,
    maxEvaluationItems: context.maxEvaluationItems,
    maxItemModelDepth: context.maxItemModelDepth,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: context.validationAnchor,
      outputPackRoot: context.outputPackRoot
        ?? ("outputRoot" in context ? context.outputRoot : undefined),
      excludedLocalResourcePaths: context.excludedLocalResourcePaths,
      defaultAssetsPath: context.defaultAssetsPath,
      resourcePackRoots: context.resourcePackRoots
    }),
    globalExterns: context.globalExterns,
    checkExternExistence: context.checkExternExistence
  };
}
