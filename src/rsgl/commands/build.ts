import * as path from "node:path";
import * as vscode from "vscode";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import { buildRsglResourcePack } from "../build";
import { rsglLanguageId } from "../diagnostics";
import { createRsglWorkspaceValidationOptions } from "../workspaceValidation";

export const buildRsglResourcePackCommand = "McResHelper.buildRsglResourcePack";

export async function buildActiveRsglResourcePack(uri?: vscode.Uri): Promise<void> {
  const document = await resolveRsglDocument(uri);
  if (!document) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Open an RSGL file before building."));
    return;
  }

  if (document.isDirty) {
    const saved = await document.save();
    if (!saved) {
      await vscode.window.showErrorMessage(vscode.l10n.t("Save the RSGL file before building."));
      return;
    }
  }

  const outputRoot = await resolveOutputRoot(document.fileName);
  if (!outputRoot) {
    return;
  }

  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: vscode.l10n.t("Building RSGL resource pack"),
    cancellable: false
  }, () => Promise.resolve(buildRsglResourcePack(document.fileName, {
    outputRoot,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: document.fileName,
      defaultAssetsPath: vscode.workspace.getConfiguration().get<string | null>("McResHelper.defaultMcAssetsPath"),
      resourcePackRoots: vscode.workspace.getConfiguration().get<string[]>("McResHelper.resourcePackLoadOrder") ?? []
    })
  })));

  const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (errors.length > 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("RSGL build failed with {0} error(s).", errors.length));
    return;
  }

  const summary = result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL build complete: {0} created, {1} updated, {2} unchanged.",
    summary.create,
    summary.update,
    summary.unchanged
  ));
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
