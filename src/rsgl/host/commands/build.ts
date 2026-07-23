import * as vscode from "vscode";
import type {
  RsglBuildPreviewResult,
  RsglBuildResult
} from "../../../../packages/rsgl-core/src/build";
import { createRsglMaterializationDiagnostics } from "../../../../packages/rsgl-core/src/build";
import type {
  RsglMaterializationInvalidation,
  RsglMaterializationProject
} from "../../../../packages/rsgl-core/src/compiler";
import {
  loadRsglProjectConfigForSource,
  projectCompileOptionsFromRsglConfig,
  projectEmitOptionsFromRsglConfig
} from "../../../../packages/rsgl-core/src/rsglConfig";
import { resolveRsglSourceRootFromFileName } from "../../../../packages/rsgl-core/src/sourceRoot";
import { rsglCommands } from "../../../../packages/rsgl-shared/src";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "../configuration";
import { applyRsglEmittedFiles } from "./asyncBuildWriter";
import {
  RsglBuildWorkerExitError,
  RsglCopySourceReadError,
  RsglOutputFileReadError,
  RsglUnsafeOutputPathError
} from "./buildUiErrors";
import { localizedRsglBuildPreviewMessages } from "./buildPreviewMessages";
import {
  isDirectoryBuildContext,
  resolveDirectoryBuildContext,
  resolveFileBuildContext,
  resolveWorkspaceBuildContexts,
  type RsglFileBuildContext
} from "./buildContexts";
import {
  runRsglBuildProgress,
  showBuildPreview,
  showBuildResult,
  showWorkspaceBuildPreview,
  showWorkspaceBuildResult
} from "./buildPresenter";
import { runRsglWorkerTask } from "./buildWorkerClient";
import type {
  RsglWorkerBuildContext,
  RsglWorkerCompileConfiguration,
  RsglWorkerValidationConfiguration
} from "./buildWorkerProtocol";
import { RsglCommandLifecycle, withCombinedCancellation } from "./commandLifecycle";
import type { RsglWorkspaceBuildEntry } from "./workspaceBuildPreview";

export interface RsglBuildCommandOptions {
  workerPath: string;
  stdlibRoot: string;
  onMaterializationInvalidation?: (invalidation: RsglMaterializationInvalidation) => unknown | Promise<unknown>;
  resolveMaterializationProject?: (
    sourceIdentity: string,
    outputRoot: string
  ) => RsglMaterializationProject | undefined | Promise<RsglMaterializationProject | undefined>;
}

export interface RsglBuildCommands {
  executeCommand(command: string, ...args: unknown[]): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Creates command dispatch state only; workers remain transaction-scoped. */
export function createRsglBuildCommands(options: RsglBuildCommandOptions): RsglBuildCommands {
  const runtimePaths = validateRuntimePaths(options);
  const lifecycle = new RsglCommandLifecycle();
  return {
    executeCommand: (command, ...args) => lifecycle.execute(token =>
      executeBuildCommand(command, args, token, runtimePaths)),
    dispose: () => lifecycle.dispose()
  };
}

async function executeBuildCommand(
  command: string,
  args: readonly unknown[],
  token: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const uri = args[0] instanceof vscode.Uri ? args[0] : undefined;
  switch (command) {
    case rsglCommands.build:
      return buildActiveRsglResourcePack(uri, token, paths);
    case rsglCommands.previewBuild:
      return previewActiveRsglResourcePackBuild(uri, token, paths);
    case rsglCommands.buildDirectory:
      return buildActiveRsglResourcePackDirectory(uri, token, paths);
    case rsglCommands.previewDirectoryBuild:
      return previewActiveRsglResourcePackDirectoryBuild(uri, token, paths);
    case rsglCommands.buildWorkspace:
      return buildRsglWorkspaceResourcePacks(token, paths);
    case rsglCommands.previewWorkspaceBuild:
      return previewRsglWorkspaceResourcePackBuilds(token, paths);
    default:
      throw new Error(`Unsupported RSGL command '${command}'.`);
  }
}

async function buildActiveRsglResourcePack(
  uri: vscode.Uri | undefined,
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context || runtimeToken.isCancellationRequested) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL resource pack"), progressToken =>
    withCombinedCancellation(progressToken, runtimeToken, token =>
      prepareAndWriteBuild(context, token, paths))
  );
  if (result && !runtimeToken.isCancellationRequested) {
    await showBuildResult(result);
  }
}

async function buildActiveRsglResourcePackDirectory(
  uri: vscode.Uri | undefined,
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context || runtimeToken.isCancellationRequested) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL source directory"), progressToken =>
    withCombinedCancellation(progressToken, runtimeToken, token =>
      prepareAndWriteBuild(context, token, paths))
  );
  if (result && !runtimeToken.isCancellationRequested) {
    await showBuildResult(result);
  }
}

async function previewActiveRsglResourcePackBuild(
  uri: vscode.Uri | undefined,
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context || runtimeToken.isCancellationRequested) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL resource pack build"), progressToken =>
    withCombinedCancellation(progressToken, runtimeToken, token =>
      prepareBuildPreview(context, token, paths))
  );
  if (result && !runtimeToken.isCancellationRequested) {
    await showBuildPreview(result);
  }
}

async function previewActiveRsglResourcePackDirectoryBuild(
  uri: vscode.Uri | undefined,
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context || runtimeToken.isCancellationRequested) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL source directory build"), progressToken =>
    withCombinedCancellation(progressToken, runtimeToken, token =>
      prepareBuildPreview(context, token, paths))
  );
  if (result && !runtimeToken.isCancellationRequested) {
    await showBuildPreview(result);
  }
}

async function buildRsglWorkspaceResourcePacks(
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts || runtimeToken.isCancellationRequested) {
    return;
  }

  const entries = await runRsglBuildProgress(
    vscode.l10n.t("Building RSGL workspace source directories"),
    progressToken => withCombinedCancellation(progressToken, runtimeToken, async token => {
      const completed: Array<RsglWorkspaceBuildEntry<RsglBuildResult>> = [];
      for (const context of contexts.buildable) {
        const result = await prepareAndWriteBuild(context, token, paths);
        if (!result) {
          return null;
        }
        completed.push({ context, result });
      }
      return completed;
    })
  );
  if (entries && !runtimeToken.isCancellationRequested) {
    await showWorkspaceBuildResult(entries, contexts.skipped);
  }
}

async function previewRsglWorkspaceResourcePackBuilds(
  runtimeToken: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts || runtimeToken.isCancellationRequested) {
    return;
  }

  const entries = await runRsglBuildProgress(
    vscode.l10n.t("Previewing RSGL workspace source directory builds"),
    progressToken => withCombinedCancellation(progressToken, runtimeToken, async token => {
      const completed: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>> = [];
      for (const context of contexts.buildable) {
        const result = await prepareBuildPreview(context, token, paths);
        if (!result) {
          return null;
        }
        completed.push({ context, result });
      }
      return completed;
    })
  );
  if (entries && !runtimeToken.isCancellationRequested) {
    await showWorkspaceBuildPreview(entries, contexts.skipped);
  }
}

async function prepareAndWriteBuild(
  context: RsglFileBuildContext,
  token: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<RsglBuildResult | null> {
  try {
    const outcome = await runRsglWorkerTask({
      kind: "prepareBuild",
      payload: createWorkerBuildPayload(context, paths.stdlibRoot)
    }, {
      workerPath: paths.workerPath,
      cancellationToken: token
    });
    if (outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled) {
      return null;
    }
    if (!outcome.result.files) {
      return {
        diagnostics: outcome.result.diagnostics,
        dependencies: outcome.result.dependencies
      };
    }

    const sourceIdentity = isDirectoryBuildContext(context) ? context.sourceRoot : context.sourceFileName;
    const sourceRootPath = materializationSourceRoot(context);
    const materialization = await applyRsglEmittedFiles(outcome.result.files, context.outputRoot, {
      cancellationToken: token,
      sourceIdentity,
      sourceRootPath,
      project: await paths.resolveMaterializationProject?.(context.sourceFileName, context.outputRoot),
      onInvalidation: paths.onMaterializationInvalidation
    });
    if (materialization.status === "cancelled" || token.isCancellationRequested) {
      return null;
    }
    return {
      diagnostics: [
        ...outcome.result.diagnostics,
        ...createRsglMaterializationDiagnostics(materialization),
        ...(materialization.invalidationDeliveryFailure ? [{
          code: "rsgl.materializationInvalidationFailed",
          severity: "warning" as const,
          message: materialization.invalidationDeliveryFailure,
          range: { start: 0, end: 0 }
        }] : [])
      ],
      dependencies: outcome.result.dependencies,
      plan: materialization.preview.writePlan,
      materialization
    };
  } catch (error) {
    if (!token.isCancellationRequested) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("RSGL build failed: {0}", localizeBuildUiError(error))
      );
    }
    return null;
  }
}

function materializationSourceRoot(context: RsglFileBuildContext): string {
  if (isDirectoryBuildContext(context)) {
    return context.sourceRoot;
  }
  return loadRsglProjectConfigForSource(context.sourceFileName)?.config.root
    ?? resolveRsglSourceRootFromFileName(context.sourceFileName);
}

async function prepareBuildPreview(
  context: RsglFileBuildContext,
  token: vscode.CancellationToken,
  paths: RsglBuildCommandOptions
): Promise<RsglBuildPreviewResult | null> {
  try {
    const project = await paths.resolveMaterializationProject?.(context.sourceFileName, context.outputRoot);
    const outcome = await runRsglWorkerTask({
      kind: "previewBuild",
      payload: {
        ...createWorkerBuildPayload(context, paths.stdlibRoot),
        materializationProject: project,
        materializationSourceRoot: materializationSourceRoot(context),
        previewMessages: localizedRsglBuildPreviewMessages()
      }
    }, {
      workerPath: paths.workerPath,
      cancellationToken: token
    });
    return outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled
      ? null
      : outcome.result;
  } catch (error) {
    if (!token.isCancellationRequested) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t("RSGL build preview failed: {0}", localizeBuildUiError(error))
      );
    }
    return null;
  }
}

function localizeBuildUiError(error: unknown): string {
  if (error instanceof RsglCopySourceReadError) {
    return vscode.l10n.t("Unable to read RSGL copy source '{0}'.", error.copyFrom);
  }
  if (error instanceof RsglOutputFileReadError) {
    return vscode.l10n.t("Unable to read RSGL output file '{0}'.", error.fileName);
  }
  if (error instanceof RsglUnsafeOutputPathError) {
    return vscode.l10n.t("Unsafe RSGL output path '{0}'.", error.outputPath);
  }
  if (error instanceof RsglBuildWorkerExitError) {
    return vscode.l10n.t("RSGL build worker exited before returning a result (code {0}).",
      error.exitCode
    );
  }
  return error instanceof Error ? error.message : String(error);
}

function createWorkerBuildPayload(
  context: RsglFileBuildContext,
  stdlibRoot: string
): RsglWorkerBuildContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration {
  const validationAnchor = isDirectoryBuildContext(context)
    ? context.sourceRoot
    : context.sourceFileName;
  const projectConfig = loadRsglProjectConfigForSource(validationAnchor)?.config;
  const projectDefaultAssetsPath = projectConfig?.defaultAssetsPath;
  const configurationScope = vscode.Uri.file(validationAnchor);
  return {
    ...projectCompileOptionsFromRsglConfig(projectConfig ?? {}),
    ...projectEmitOptionsFromRsglConfig(projectConfig ?? {}),
    stdlibRoot,
    source: {
      kind: isDirectoryBuildContext(context) ? "directory" : "file",
      path: isDirectoryBuildContext(context) ? context.sourceRoot : context.sourceFileName
    },
    validationAnchor,
    outputRoot: context.outputRoot,
    outputPackRoot: context.outputRoot,
    defaultAssetsPath: projectDefaultAssetsPath === undefined
      ? configuredDefaultAssetsPath(configurationScope)
      : projectDefaultAssetsPath,
    resourcePackRoots: projectConfig?.resourcePackRoots
      ?? configuredResourcePackLoadOrder(configurationScope),
    globalExterns: projectConfig?.extern,
    checkExternExistence: projectConfig?.checkExternExistence
  };
}

function validateRuntimePaths(options: RsglBuildCommandOptions): RsglBuildCommandOptions {
  if (!options.workerPath.trim()) {
    throw new TypeError("RSGL workerPath must be an explicit non-empty path.");
  }
  if (!options.stdlibRoot.trim()) {
    throw new TypeError("RSGL stdlibRoot must be an explicit non-empty path.");
  }
  return { ...options };
}
