import * as vscode from "vscode";
import type {
  RsglBuildPreviewResult,
  RsglBuildResult
} from "../../../../packages/rsgl-core/src/build";
import {
  loadRsglProjectConfigForSource,
  projectCompileOptionsFromRsglConfig
} from "../../../../packages/rsgl-core/src/rsglConfig";
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
import type { RsglWorkspaceBuildEntry } from "./workspaceBuildPreview";

export async function buildActiveRsglResourcePack(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL resource pack"), token =>
    prepareAndWriteBuild(context, token)
  );
  if (result) {
    await showBuildResult(result);
  }
}

export async function buildActiveRsglResourcePackDirectory(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL source directory"), token =>
    prepareAndWriteBuild(context, token)
  );
  if (result) {
    await showBuildResult(result);
  }
}

export async function previewActiveRsglResourcePackBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL resource pack build"), token =>
    prepareBuildPreview(context, token)
  );
  if (result) {
    await showBuildPreview(result);
  }
}

export async function previewActiveRsglResourcePackDirectoryBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL source directory build"), token =>
    prepareBuildPreview(context, token)
  );
  if (result) {
    await showBuildPreview(result);
  }
}

export async function buildRsglWorkspaceResourcePacks(): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts) {
    return;
  }

  const entries = await runRsglBuildProgress(
    vscode.l10n.t("Building RSGL workspace source directories"),
    async token => {
      const completed: Array<RsglWorkspaceBuildEntry<RsglBuildResult>> = [];
      for (const context of contexts.buildable) {
        const result = await prepareAndWriteBuild(context, token);
        if (!result) {
          return null;
        }
        completed.push({ context, result });
      }
      return completed;
    }
  );
  if (entries) {
    await showWorkspaceBuildResult(entries, contexts.skipped);
  }
}

export async function previewRsglWorkspaceResourcePackBuilds(): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts) {
    return;
  }

  const entries = await runRsglBuildProgress(
    vscode.l10n.t("Previewing RSGL workspace source directory builds"),
    async token => {
      const completed: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>> = [];
      for (const context of contexts.buildable) {
        const result = await prepareBuildPreview(context, token);
        if (!result) {
          return null;
        }
        completed.push({ context, result });
      }
      return completed;
    }
  );
  if (entries) {
    await showWorkspaceBuildPreview(entries, contexts.skipped);
  }
}

async function prepareAndWriteBuild(
  context: RsglFileBuildContext,
  token: vscode.CancellationToken
): Promise<RsglBuildResult | null> {
  try {
    const outcome = await runRsglWorkerTask({
      kind: "prepareBuild",
      payload: createWorkerBuildPayload(context)
    }, token);
    if (outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled) {
      return null;
    }
    if (!outcome.result.files) {
      return {
        diagnostics: outcome.result.diagnostics,
        dependencies: outcome.result.dependencies
      };
    }

    const plan = await applyRsglEmittedFiles(outcome.result.files, context.outputRoot, token);
    return plan && !token.isCancellationRequested
      ? {
        diagnostics: outcome.result.diagnostics,
        dependencies: outcome.result.dependencies,
        plan
      }
      : null;
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("RSGL build failed: {0}", localizeBuildUiError(error))
    );
    return null;
  }
}

async function prepareBuildPreview(
  context: RsglFileBuildContext,
  token: vscode.CancellationToken
): Promise<RsglBuildPreviewResult | null> {
  try {
    const outcome = await runRsglWorkerTask({
      kind: "previewBuild",
      payload: {
        ...createWorkerBuildPayload(context),
        previewMessages: localizedRsglBuildPreviewMessages()
      }
    }, token);
    return outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled
      ? null
      : outcome.result;
  } catch (error) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("RSGL build preview failed: {0}", localizeBuildUiError(error))
    );
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
    return vscode.l10n.t(
      "RSGL build worker exited before returning a result (code {0}).",
      error.exitCode
    );
  }
  return error instanceof Error ? error.message : String(error);
}

function createWorkerBuildPayload(
  context: RsglFileBuildContext
): RsglWorkerBuildContext & RsglWorkerValidationConfiguration & RsglWorkerCompileConfiguration {
  const validationAnchor = isDirectoryBuildContext(context)
    ? context.sourceRoot
    : context.sourceFileName;
  const projectConfig = loadRsglProjectConfigForSource(validationAnchor)?.config;
  const projectDefaultAssetsPath = projectConfig?.defaultAssetsPath;
  return {
    ...projectCompileOptionsFromRsglConfig(projectConfig ?? {}),
    source: {
      kind: isDirectoryBuildContext(context) ? "directory" : "file",
      path: isDirectoryBuildContext(context) ? context.sourceRoot : context.sourceFileName
    },
    validationAnchor,
    outputRoot: context.outputRoot,
    defaultAssetsPath: projectDefaultAssetsPath === undefined
      ? configuredDefaultAssetsPath()
      : projectDefaultAssetsPath,
    resourcePackRoots: projectConfig?.resourcePackRoots ?? configuredResourcePackLoadOrder(),
    globalExterns: projectConfig?.extern,
    checkExternExistence: projectConfig?.checkExternExistence
  };
}
