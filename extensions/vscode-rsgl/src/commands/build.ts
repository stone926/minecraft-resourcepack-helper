import * as vscode from "vscode";
import {
  buildRsglResourcePackProgram,
  previewRsglResourcePackProgramBuild,
  type RsglBuildOptions,
  type RsglBuildPreviewResult,
  type RsglBuildResult
} from "../../../../packages/rsgl-core/src/build";
import { rsglWorkspaceBuildSemanticCache } from "../../../../packages/rsgl-core/src/workspaceBuildSemantic";
import { createRsglWorkspaceValidationOptions } from "../../../../packages/rsgl-core/src/workspaceValidation";
import { configuredDefaultAssetsPath, configuredResourcePackLoadOrder } from "../configuration";
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

export async function buildActiveRsglResourcePack(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL resource pack"), () =>
    buildRsglResourcePackProgramForContext(context)
  );
  await showBuildResult(result);
}

export async function buildActiveRsglResourcePackDirectory(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL source directory"), () =>
    buildRsglResourcePackProgramForContext(context)
  );
  await showBuildResult(result);
}

export async function previewActiveRsglResourcePackBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL resource pack build"), () =>
    previewRsglResourcePackProgramForContext(context)
  );
  await showBuildPreview(result);
}

export async function previewActiveRsglResourcePackDirectoryBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL source directory build"), () =>
    previewRsglResourcePackProgramForContext(context)
  );
  await showBuildPreview(result);
}

export async function buildRsglWorkspaceResourcePacks(): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts) {
    return;
  }

  const entries = await runRsglBuildProgress(vscode.l10n.t("Building RSGL workspace source directories"), () =>
    contexts.buildable.map(context => ({
      context,
      result: buildRsglResourcePackProgramForContext(context)
    }))
  );
  await showWorkspaceBuildResult(entries, contexts.skipped);
}

export async function previewRsglWorkspaceResourcePackBuilds(): Promise<void> {
  const contexts = await resolveWorkspaceBuildContexts();
  if (!contexts) {
    return;
  }

  const entries = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL workspace source directory builds"), () =>
    contexts.buildable.map(context => ({
      context,
      result: previewRsglResourcePackProgramForContext(context)
    }))
  );
  await showWorkspaceBuildPreview(entries, contexts.skipped);
}

function createBuildOptions(context: RsglFileBuildContext): RsglBuildOptions {
  return {
    outputRoot: context.outputRoot,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: context.sourceFileName,
      defaultAssetsPath: configuredDefaultAssetsPath(),
      resourcePackRoots: configuredResourcePackLoadOrder()
    })
  };
}

function buildRsglResourcePackProgramForContext(context: RsglFileBuildContext): RsglBuildResult {
  const program = loadSemanticProgramForBuildContext(context);
  return buildRsglResourcePackProgram(program.files, {
    ...createBuildOptions(context),
    entryFileName: program.entryFileName,
    sourceRoot: program.rootDirectory,
    semanticProgram: program.program
  });
}

function previewRsglResourcePackProgramForContext(context: RsglFileBuildContext): RsglBuildPreviewResult {
  const program = loadSemanticProgramForBuildContext(context);
  return previewRsglResourcePackProgramBuild(program.files, {
    ...createBuildOptions(context),
    entryFileName: program.entryFileName,
    sourceRoot: program.rootDirectory,
    semanticProgram: program.program
  });
}

function loadSemanticProgramForBuildContext(context: RsglFileBuildContext) {
  return isDirectoryBuildContext(context)
    ? rsglWorkspaceBuildSemanticCache.loadProgramFromDirectory(context.sourceRoot)
    : rsglWorkspaceBuildSemanticCache.loadProgramFromEntry(context.sourceFileName);
}
