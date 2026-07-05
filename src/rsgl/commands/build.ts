import * as path from "node:path";
import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import {
  buildRsglResourcePack,
  buildRsglResourcePackDirectory,
  previewRsglResourcePackBuild,
  previewRsglResourcePackDirectoryBuild,
  type RsglBuildOptions,
  type RsglBuildPreviewResult,
  type RsglBuildResult
} from "../build";
import { rsglLanguageId } from "../diagnostics";
import { resolveRsglSourceRootFromFileName } from "../sourceRoot";
import { createRsglWorkspaceValidationOptions } from "../workspaceValidation";

export const buildRsglResourcePackCommand = "McResHelper.buildRsglResourcePack";
export const previewRsglResourcePackBuildCommand = "McResHelper.previewRsglResourcePackBuild";
export const buildRsglResourcePackDirectoryCommand = "McResHelper.buildRsglResourcePackDirectory";
export const previewRsglResourcePackDirectoryBuildCommand = "McResHelper.previewRsglResourcePackDirectoryBuild";

interface RsglFileBuildContext {
  document: vscode.TextDocument;
  outputRoot: string;
}

interface RsglDirectoryBuildContext extends RsglFileBuildContext {
  sourceRoot: string;
}

export async function buildActiveRsglResourcePack(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL resource pack"), () =>
    buildRsglResourcePack(context.document.fileName, createBuildOptions(context))
  );
  await showBuildResult(result);
}

export async function buildActiveRsglResourcePackDirectory(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Building RSGL source directory"), () =>
    buildRsglResourcePackDirectory(context.sourceRoot, createBuildOptions(context))
  );
  await showBuildResult(result);
}

export async function previewActiveRsglResourcePackBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveFileBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL resource pack build"), () =>
    previewRsglResourcePackBuild(context.document.fileName, createBuildOptions(context))
  );
  await showBuildPreview(result);
}

export async function previewActiveRsglResourcePackDirectoryBuild(uri?: vscode.Uri): Promise<void> {
  const context = await resolveDirectoryBuildContext(uri);
  if (!context) {
    return;
  }

  const result = await runRsglBuildProgress(vscode.l10n.t("Previewing RSGL source directory build"), () =>
    previewRsglResourcePackDirectoryBuild(context.sourceRoot, createBuildOptions(context))
  );
  await showBuildPreview(result);
}

async function resolveFileBuildContext(uri: vscode.Uri | undefined): Promise<RsglFileBuildContext | null> {
  const document = await resolveRsglDocumentOrShowError(uri);
  if (!document) {
    return null;
  }

  if (document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      await vscode.window.showErrorMessage(vscode.l10n.t("Save the RSGL file before building."));
      return null;
    }
  }

  const outputRoot = await resolveOutputRoot(document.fileName);
  return outputRoot ? { document, outputRoot } : null;
}

async function resolveDirectoryBuildContext(uri: vscode.Uri | undefined): Promise<RsglDirectoryBuildContext | null> {
  const document = await resolveRsglDocumentOrShowError(uri);
  if (!document) {
    return null;
  }

  const sourceRoot = resolveRsglSourceRootFromFileName(document.fileName);
  const saved = await saveRsglDocumentsInSourceRoot(sourceRoot);
  if (!saved) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Save all RSGL files in the source directory before building."));
    return null;
  }

  const outputRoot = await resolveOutputRoot(document.fileName);
  return outputRoot ? { document, outputRoot, sourceRoot } : null;
}

async function resolveRsglDocumentOrShowError(uri: vscode.Uri | undefined): Promise<vscode.TextDocument | null> {
  const document = await resolveRsglDocument(uri);
  if (!document) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Open an RSGL file before building."));
  }
  return document;
}

async function resolveRsglDocument(uri: vscode.Uri | undefined): Promise<vscode.TextDocument | null> {
  const active = vscode.window.activeTextEditor?.document;
  const target = uri ?? active?.uri;
  if (!target || target.scheme !== "file") {
    return null;
  }
  if (active?.uri.toString() === target.toString() && active.languageId === rsglLanguageId) {
    return active;
  }
  const document = await vscode.workspace.openTextDocument(target);
  return document.languageId === rsglLanguageId || path.extname(document.fileName).toLowerCase() === ".rsgl"
    ? document
    : null;
}

async function resolveOutputRoot(fileName: string): Promise<string | null> {
  const packRoot = workspaceResourceCache.getPackRoot(fileName);
  if (packRoot) {
    return packRoot;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: vscode.l10n.t("Select resource pack output folder")
  });
  return selected?.[0]?.fsPath ?? null;
}

function createBuildOptions(context: RsglFileBuildContext): RsglBuildOptions {
  return {
    outputRoot: context.outputRoot,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: context.document.fileName,
      defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
      resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
    })
  };
}

function runRsglBuildProgress<T extends RsglBuildResult>(
  title: string,
  task: () => T
): Thenable<T> {
  return vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
    cancellable: false
  }, () => Promise.resolve(task()));
}

async function showBuildResult(result: RsglBuildResult): Promise<void> {
  if (await showBuildErrors(result)) {
    return;
  }

  const summary = result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL build complete: {0} created, {1} updated, {2} unchanged.",
    summary.create,
    summary.update,
    summary.unchanged
  ));
}

async function showBuildPreview(result: RsglBuildPreviewResult): Promise<void> {
  if (await showBuildErrors(result)) {
    return;
  }

  const preview = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: result.preview ?? ""
  });
  await vscode.window.showTextDocument(preview, { preview: true });
}

async function showBuildErrors(result: RsglBuildResult): Promise<boolean> {
  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (errors.length === 0) {
    return false;
  }
  await vscode.window.showErrorMessage(vscode.l10n.t("RSGL build failed with {0} error(s).", errors.length));
  return true;
}

async function saveRsglDocumentsInSourceRoot(sourceRoot: string): Promise<boolean> {
  for (const document of vscode.workspace.textDocuments) {
    if (
      document.isDirty &&
      document.uri.scheme === "file" &&
      isRsglDocument(document) &&
      isPathInsideOrEqual(document.fileName, sourceRoot)
    ) {
      const saved = await document.save();
      if (!saved) {
        return false;
      }
    }
  }
  return true;
}

function isRsglDocument(document: vscode.TextDocument): boolean {
  return document.languageId === rsglLanguageId || path.extname(document.fileName).toLowerCase() === ".rsgl";
}

function isPathInsideOrEqual(fileName: string, directory: string): boolean {
  const relative = path.relative(directory, fileName);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
