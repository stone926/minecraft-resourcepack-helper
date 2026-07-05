import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  buildRsglResourcePackProgram,
  previewRsglResourcePackProgramBuild,
  type RsglBuildOptions,
  type RsglBuildPreviewResult,
  type RsglBuildResult
} from "../../../../packages/rsgl-core/src/build";
import { rsglLanguageId } from "../diagnostics";
import {
  rsglWorkspaceSourceRootCache,
  resolveRsglSourceRootFromFileName,
  type RsglDiscoveredSourceRoot
} from "../../../../packages/rsgl-core/src/sourceRoot";
import { rsglWorkspaceBuildSemanticCache } from "../../../../packages/rsgl-core/src/workspaceBuildSemantic";
import { createRsglWorkspaceValidationOptions } from "../../../../packages/rsgl-core/src/workspaceValidation";

export const buildRsglResourcePackCommand = "rsgl.build";
export const previewRsglResourcePackBuildCommand = "rsgl.previewBuild";
export const buildRsglResourcePackDirectoryCommand = "rsgl.buildDirectory";
export const previewRsglResourcePackDirectoryBuildCommand = "rsgl.previewDirectoryBuild";
export const buildRsglWorkspaceResourcePacksCommand = "rsgl.buildWorkspace";
export const previewRsglWorkspaceResourcePackBuildsCommand = "rsgl.previewWorkspaceBuild";

interface RsglFileBuildContext {
  sourceFileName: string;
  outputRoot: string;
}

interface RsglDirectoryBuildContext extends RsglFileBuildContext {
  sourceRoot: string;
}

interface RsglSkippedSourceRoot {
  sourceRoot: string;
  reason: "missingOutputRoot";
}

interface RsglWorkspaceBuildContexts {
  buildable: RsglDirectoryBuildContext[];
  skipped: RsglSkippedSourceRoot[];
}

interface RsglWorkspaceBuildEntry<T extends RsglBuildResult> {
  context: RsglDirectoryBuildContext;
  result: T;
}

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
    rsglWorkspaceBuildSemanticCache.invalidatePath(document.fileName);
  }

  const outputRoot = await resolveOutputRoot(document.fileName);
  return outputRoot ? { sourceFileName: document.fileName, outputRoot } : null;
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
  return outputRoot ? { sourceFileName: document.fileName, outputRoot, sourceRoot } : null;
}

async function resolveWorkspaceBuildContexts(): Promise<RsglWorkspaceBuildContexts | null> {
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

  const packRoot = findNearestPackRoot(path.dirname(path.resolve(fileName)));
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
  const configuration = vscode.workspace.getConfiguration("rsgl");
  return {
    outputRoot: context.outputRoot,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: context.sourceFileName,
      defaultAssetsPath: configuration.get<string | null>("defaultAssetsPath"),
      resourcePackRoots: configuration.get<string[]>("resourcePackLoadOrder") ?? []
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

function isDirectoryBuildContext(context: RsglFileBuildContext): context is RsglDirectoryBuildContext {
  return "sourceRoot" in context;
}

function runRsglBuildProgress<T>(
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

async function showWorkspaceBuildResult(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>,
  skipped: RsglSkippedSourceRoot[]
): Promise<void> {
  const errorCount = workspaceErrorCount(entries);
  if (errorCount > 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("RSGL workspace build failed with {0} error(s); skipped {1} source directories.", errorCount, skipped.length));
    return;
  }

  const summary = summarizeWorkspaceBuild(entries);
  await vscode.window.showInformationMessage(vscode.l10n.t("RSGL workspace build complete: {0} source directories, {1} created, {2} updated, {3} unchanged, {4} skipped.",
    entries.length,
    summary.create,
    summary.update,
    summary.unchanged,
    skipped.length
  ));
}

async function showWorkspaceBuildPreview(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>>,
  skipped: RsglSkippedSourceRoot[]
): Promise<void> {
  const errorCount = workspaceErrorCount(entries);
  if (errorCount > 0) {
    await vscode.window.showErrorMessage(vscode.l10n.t("RSGL workspace build failed with {0} error(s); skipped {1} source directories.", errorCount, skipped.length));
    return;
  }

  const preview = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: formatWorkspaceBuildPreview(entries, skipped)
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

function formatWorkspaceBuildPreview(
  entries: Array<RsglWorkspaceBuildEntry<RsglBuildPreviewResult>>,
  skipped: RsglSkippedSourceRoot[]
): string {
  const summary = summarizeWorkspaceBuild(entries);
  const lines = [
    "# RSGL Workspace Build Preview",
    "",
    `Summary: ${entries.length} source directories, ${summary.create} create, ${summary.update} update, ${summary.unchanged} unchanged, ${skipped.length} skipped`,
    ""
  ];

  if (skipped.length > 0) {
    lines.push("## Skipped Source Directories", "");
    for (const skippedRoot of skipped) {
      lines.push(`- ${skippedRoot.sourceRoot}: ${skippedRoot.reason}`);
    }
    lines.push("");
  }

  for (const entry of entries) {
    lines.push(`## ${entry.context.sourceRoot}`, "");
    lines.push(...nestMarkdownHeadings(entry.result.preview ?? "No preview."));
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
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
      rsglWorkspaceBuildSemanticCache.invalidatePath(document.fileName);
    }
  }
  return true;
}

function resolveWorkspaceOutputRoot(sourceRoot: RsglDiscoveredSourceRoot): string | null {
  return resolveConfiguredOutDir(sourceRoot.sampleFileName)
    ?? findNearestPackRoot(path.dirname(path.resolve(sourceRoot.sampleFileName)))
    ?? findNearestPackRoot(path.resolve(sourceRoot.sourceRoot));
}

async function findWorkspaceRsglFiles(): Promise<string[]> {
  const rsglFiles = await vscode.workspace.findFiles("**/*.rsgl", "{**/.git/**,**/.vscode/**,**/node_modules/**}");
  return rsglFiles.map(uri => uri.fsPath);
}

function summarizeWorkspaceBuild(entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>): { create: number; update: number; unchanged: number } {
  return entries.reduce((summary, entry) => {
    const planSummary = entry.result.plan?.summary ?? { create: 0, update: 0, unchanged: 0 };
    summary.create += planSummary.create;
    summary.update += planSummary.update;
    summary.unchanged += planSummary.unchanged;
    return summary;
  }, { create: 0, update: 0, unchanged: 0 });
}

function workspaceErrorCount(entries: Array<RsglWorkspaceBuildEntry<RsglBuildResult>>): number {
  return entries.reduce((count, entry) =>
    count + entry.result.diagnostics.filter(diagnostic => diagnostic.severity === "error").length, 0);
}

function nestMarkdownHeadings(markdown: string): string[] {
  const trimmed = markdown.trimEnd();
  if (trimmed.length === 0) {
    return ["No preview."];
  }
  return trimmed.split(/\r?\n/).map(line => line.startsWith("#") ? `#${line}` : line);
}

function isRsglDocument(document: vscode.TextDocument): boolean {
  return document.languageId === rsglLanguageId || path.extname(document.fileName).toLowerCase() === ".rsgl";
}

function isPathInsideOrEqual(fileName: string, directory: string): boolean {
  const relative = path.relative(directory, fileName);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveConfiguredOutDir(anchorFileName: string): string | null {
  const outDir = vscode.workspace.getConfiguration("rsgl").get<string>("outDir");
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

function findNearestPackRoot(startDirectory: string): string | null {
  let directory = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(directory, "pack.mcmeta"))) {
      return directory;
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}
