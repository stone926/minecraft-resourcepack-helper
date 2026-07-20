import * as path from "node:path";
import * as vscode from "vscode";
import {
  assertRsglOutputPackRoot,
  loadRsglProjectConfigForSource,
  resolveRsglOutputPackRoot
} from "../../../../packages/rsgl-core/src/rsglConfig";
import {
  rsglWorkspaceSourceRootCache,
  resolveRsglSourceRootFromFileName,
  type RsglDiscoveredSourceRoot
} from "../../../../packages/rsgl-core/src/sourceRoot";
import { isRsglPathInsideOrEqual } from "../../../../packages/rsgl-core/src/pathIdentity";
import { rsglLanguageId } from "../language";

export interface RsglFileBuildContext {
  sourceFileName: string;
  outputRoot: string;
}

export interface RsglDirectoryBuildContext extends RsglFileBuildContext {
  sourceRoot: string;
}

export interface RsglSkippedSourceRoot {
  sourceRoot: string;
  reason: "missingOutputRoot";
}

export interface RsglWorkspaceBuildContexts {
  buildable: RsglDirectoryBuildContext[];
  skipped: RsglSkippedSourceRoot[];
}

export function isDirectoryBuildContext(context: RsglFileBuildContext): context is RsglDirectoryBuildContext {
  return "sourceRoot" in context;
}

export async function resolveFileBuildContext(uri: vscode.Uri | undefined): Promise<RsglFileBuildContext | null> {
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
  return outputRoot ? { sourceFileName: document.fileName, outputRoot } : null;
}

export async function resolveDirectoryBuildContext(uri: vscode.Uri | undefined): Promise<RsglDirectoryBuildContext | null> {
  const document = await resolveRsglDocumentOrShowError(uri);
  if (!document) {
    return null;
  }

  let sourceRoot: string;
  try {
    sourceRoot = resolveProjectSourceRoot(document.fileName);
  } catch (error) {
    await showProjectConfigurationError(error);
    return null;
  }
  const saved = await saveRsglDocumentsInSourceRoot(sourceRoot);
  if (!saved) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Save all RSGL files in the source directory before building."));
    return null;
  }

  const outputRoot = await resolveOutputRoot(document.fileName);
  return outputRoot ? { sourceFileName: document.fileName, outputRoot, sourceRoot } : null;
}

export async function resolveWorkspaceBuildContexts(): Promise<RsglWorkspaceBuildContexts | null> {
  if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Open a workspace before building RSGL source directories."));
    return null;
  }

  let discovered: RsglDiscoveredSourceRoot[];
  try {
    discovered = await rsglWorkspaceSourceRootCache.discover(
      findWorkspaceRsglFiles,
      resolveProjectSourceRoot
    );
  } catch (error) {
    await showProjectConfigurationError(error);
    return null;
  }
  if (discovered.length === 0) {
    await vscode.window.showInformationMessage(vscode.l10n.t("No RSGL source directories found in the workspace."));
    return null;
  }

  const saved = await saveRsglDocumentsInSourceRoots(discovered.map(root => root.sourceRoot));
  if (!saved) {
    await vscode.window.showErrorMessage(vscode.l10n.t("Save all RSGL files in the workspace source directories before building."));
    return null;
  }

  const buildable: RsglDirectoryBuildContext[] = [];
  const skipped: RsglSkippedSourceRoot[] = [];
  for (const sourceRoot of discovered) {
    const outputRoot = resolveWorkspaceOutputRoot(sourceRoot);
    if (outputRoot) {
      buildable.push({
        sourceRoot: sourceRoot.sourceRoot,
        sourceFileName: sourceRoot.sampleFileName,
        outputRoot
      });
    } else {
      skipped.push({ sourceRoot: sourceRoot.sourceRoot, reason: "missingOutputRoot" });
    }
  }

  if (buildable.length === 0) {
    await vscode.window.showWarningMessage(vscode.l10n.t("No RSGL source directories with resource pack roots found; skipped {0}.", skipped.length));
    return null;
  }
  return { buildable, skipped };
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
  try {
    const projectConfig = loadRsglProjectConfigForSource(fileName)?.config;
    const outputPackRoot = resolveRsglOutputPackRoot(fileName, projectConfig?.outDir);
    if (outputPackRoot) {
      return outputPackRoot;
    }
  } catch (error) {
    await showProjectConfigurationError(error);
    return null;
  }

  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: vscode.l10n.t("Select resource pack output folder")
  });
  if (!selected?.[0]) {
    return null;
  }
  try {
    return assertRsglOutputPackRoot(selected[0].fsPath, "selected output folder");
  } catch (error) {
    await showProjectConfigurationError(error);
    return null;
  }
}

async function saveRsglDocumentsInSourceRoot(sourceRoot: string): Promise<boolean> {
  return saveRsglDocumentsInSourceRoots([sourceRoot]);
}

async function saveRsglDocumentsInSourceRoots(sourceRoots: readonly string[]): Promise<boolean> {
  for (const document of vscode.workspace.textDocuments) {
    if (
      document.isDirty &&
      document.uri.scheme === "file" &&
      isRsglDocument(document) &&
      sourceRoots.some(sourceRoot => isPathInsideOrEqual(document.fileName, sourceRoot))
    ) {
      const saved = await document.save();
      if (!saved) {
        return false;
      }
    }
  }
  return true;
}

function resolveWorkspaceOutputRoot(sourceRoot: RsglDiscoveredSourceRoot): string | null {
  const projectConfig = loadRsglProjectConfigForSource(sourceRoot.sampleFileName)?.config;
  return resolveRsglOutputPackRoot(sourceRoot.sampleFileName, projectConfig?.outDir)
    ?? resolveRsglOutputPackRoot(sourceRoot.sourceRoot, projectConfig?.outDir);
}

async function findWorkspaceRsglFiles(): Promise<string[]> {
  const rsglFiles = await vscode.workspace.findFiles("**/*.rsgl", "{**/.git/**,**/.vscode/**,**/node_modules/**}");
  return rsglFiles.map(uri => uri.fsPath);
}

function isRsglDocument(document: vscode.TextDocument): boolean {
  return document.languageId === rsglLanguageId || path.extname(document.fileName).toLowerCase() === ".rsgl";
}

function isPathInsideOrEqual(fileName: string, directory: string): boolean {
  return isRsglPathInsideOrEqual(fileName, directory);
}

function resolveProjectSourceRoot(fileName: string): string {
  return loadRsglProjectConfigForSource(fileName)?.config.root
    ?? resolveRsglSourceRootFromFileName(fileName);
}

async function showProjectConfigurationError(error: unknown): Promise<void> {
  await vscode.window.showErrorMessage(vscode.l10n.t("Invalid RSGL project configuration: {0}",
    error instanceof Error ? error.message : String(error)
  ));
}
