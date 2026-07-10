import * as vscode from "vscode";
import type {
  RsglBuildPreviewResult,
  RsglBuildResult
} from "../../../../packages/rsgl-core/src/build";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "../configuration";
import { applyRsglEmittedFiles } from "./asyncBuildWriter";
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
  showWorkspaceBuildResult,
  type RsglWorkspaceBuildEntry
} from "./buildPresenter";
import { runRsglWorkerTask } from "./buildWorkerClient";
import type {
  RsglWorkerBuildContext,
  RsglWorkerValidationConfiguration
} from "./buildWorkerProtocol";

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
  const outcome = await runRsglWorkerTask({
    kind: "prepareBuild",
    payload: createWorkerBuildPayload(context)
  }, token);
  if (outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled) {
    return null;
  }
  if (!outcome.result.files) {
    return { diagnostics: outcome.result.diagnostics };
  }

  const plan = await applyRsglEmittedFiles(outcome.result.files, context.outputRoot, token);
  return plan && !token.isCancellationRequested
    ? { diagnostics: outcome.result.diagnostics, plan }
    : null;
}

async function prepareBuildPreview(
  context: RsglFileBuildContext,
  token: vscode.CancellationToken
): Promise<RsglBuildPreviewResult | null> {
  const outcome = await runRsglWorkerTask({
    kind: "previewBuild",
    payload: createWorkerBuildPayload(context)
  }, token);
  return outcome.type === "cancelled" || token.isCancellationRequested || outcome.result.cancelled
    ? null
    : outcome.result;
}

function createWorkerBuildPayload(
  context: RsglFileBuildContext
): RsglWorkerBuildContext & RsglWorkerValidationConfiguration {
  return {
    source: {
      kind: isDirectoryBuildContext(context) ? "directory" : "file",
      path: isDirectoryBuildContext(context) ? context.sourceRoot : context.sourceFileName
    },
    validationAnchor: context.sourceFileName,
    outputRoot: context.outputRoot,
    defaultAssetsPath: configuredDefaultAssetsPath(),
    resourcePackRoots: configuredResourcePackLoadOrder()
  };
}
