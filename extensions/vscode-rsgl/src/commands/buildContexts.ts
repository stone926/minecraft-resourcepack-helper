import * as path from "node:path";
import * as vscode from "vscode";
import { findPackRoot } from "../../../../packages/mc-assets/src";
import {
  rsglWorkspaceSourceRootCache,
  resolveRsglSourceRootFromFileName,
  type RsglDiscoveredSourceRoot
} from "../../../../packages/rsgl-core/src/sourceRoot";
import { rsglConfigKeys } from "../../../../packages/rsgl-shared/src";
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

  const sourceRoot = resolveRsglSourceRootFromFileName(document.fileName);
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

  const discovered = await rsglWorkspaceSourceRootCache.discover(findWorkspaceRsglFiles);
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
  const configuredOutDir = resolveConfiguredOutDir(fileName);
  if (configuredOutDir) {
    return configuredOutDir;
  }

  const packRoot = findPackRoot(path.resolve(fileName));
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
  return resolveConfiguredOutDir(sourceRoot.sampleFileName)
    ?? findPackRoot(path.resolve(sourceRoot.sampleFileName))
    ?? findPackRoot(path.join(path.resolve(sourceRoot.sourceRoot), "pack.mcmeta"));
}

async function findWorkspaceRsglFiles(): Promise<string[]> {
  const rsglFiles = await vscode.workspace.findFiles("**/*.rsgl", "{**/.git/**,**/.vscode/**,**/node_modules/**}");
  return rsglFiles.map(uri => uri.fsPath);
}

function isRsglDocument(document: vscode.TextDocument): boolean {
  return document.languageId === rsglLanguageId || path.extname(document.fileName).toLowerCase() === ".rsgl";
}

function isPathInsideOrEqual(fileName: string, directory: string): boolean {
  const relative = path.relative(directory, fileName);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveConfiguredOutDir(anchorFileName: string): string | null {
  const outDir = vscode.workspace.getConfiguration().get<string>(rsglConfigKeys.outDir);
  if (!outDir || outDir.trim().length === 0) {
    return null;
  }

  if (path.isAbsolute(outDir)) {
    return path.resolve(outDir);
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(anchorFileName));
  const baseDirectory = workspaceFolder?.uri.fsPath ?? path.dirname(path.resolve(anchorFileName));
  return path.resolve(baseDirectory, outDir);
}
