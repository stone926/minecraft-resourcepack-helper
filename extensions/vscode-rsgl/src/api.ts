import * as vscode from "vscode";
import {
  compileRsglDirectory,
  compileRsglFile,
  emitRsglFiles,
  type RsglCompileDiagnostic,
  type RsglEmittedFile
} from "../../../packages/rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../../packages/rsgl-core/src/workspaceValidation";

export interface RsglApi {
  version: string;
  compileFile(uri: vscode.Uri, options?: RsglApiCompileOptions): RsglApiCompileResult;
  compileWorkspace(workspace: vscode.Uri, options?: RsglApiCompileOptions): RsglApiCompileResult;
  checkWorkspace(workspace: vscode.Uri, options?: RsglApiCheckOptions): RsglApiCheckResult;
  createWatcher(workspace: vscode.Uri, options?: RsglApiWatchOptions): vscode.Disposable;
}

export interface RsglApiCompileOptions {
  sourceMaps?: boolean;
  manifest?: boolean;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface RsglApiCheckOptions {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface RsglApiWatchOptions extends RsglApiCompileOptions {
  onDidCompile?: (result: RsglApiCompileResult) => void;
}

export interface RsglApiCompileResult {
  success: boolean;
  diagnostics: RsglCompileDiagnostic[];
  emittedFiles: RsglEmittedFile[];
}

export interface RsglApiCheckResult {
  success: boolean;
  diagnostics: RsglCompileDiagnostic[];
}

export function createRsglApi(context: vscode.ExtensionContext): RsglApi {
  return {
    version: extensionVersion(context),
    compileFile: (uri, options) => compileFile(uri, options),
    compileWorkspace: (workspace, options) => compileWorkspace(workspace, options),
    checkWorkspace: (workspace, options) => checkWorkspace(workspace, options),
    createWatcher: (workspace, options) => createWatcher(workspace, options)
  };
}

function compileFile(uri: vscode.Uri, options: RsglApiCompileOptions = {}): RsglApiCompileResult {
  const sourceFileName = uri.fsPath;
  const result = compileRsglFile(sourceFileName, {
    ...createRsglWorkspaceValidationOptions({
      sourceFileName,
      defaultAssetsPath: options.defaultAssetsPath,
      resourcePackRoots: options.resourcePackRoots
    })
  });
  return toCompileResult(result, options);
}

function compileWorkspace(workspace: vscode.Uri, options: RsglApiCompileOptions = {}): RsglApiCompileResult {
  const result = compileRsglDirectory(workspace.fsPath, {
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: workspace.fsPath,
      defaultAssetsPath: options.defaultAssetsPath,
      resourcePackRoots: options.resourcePackRoots
    })
  });
  return toCompileResult(result, options);
}

function checkWorkspace(workspace: vscode.Uri, options: RsglApiCheckOptions = {}): RsglApiCheckResult {
  const result = compileRsglDirectory(workspace.fsPath, {
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: workspace.fsPath,
      defaultAssetsPath: options.defaultAssetsPath,
      resourcePackRoots: options.resourcePackRoots
    })
  });
  return {
    success: !result.diagnostics.some(diagnostic => diagnostic.severity === "error"),
    diagnostics: result.diagnostics
  };
}

function toCompileResult(
  result: ReturnType<typeof compileRsglFile> | ReturnType<typeof compileRsglDirectory>,
  options: RsglApiCompileOptions
): RsglApiCompileResult {
  const success = !result.diagnostics.some(diagnostic => diagnostic.severity === "error");
  return {
    success,
    diagnostics: result.diagnostics,
    emittedFiles: success
      ? emitRsglFiles(result.units, {
        sourceMaps: options.sourceMaps ?? true,
        manifest: options.manifest ?? true
      })
      : []
  };
}

function createWatcher(workspace: vscode.Uri, options: RsglApiWatchOptions = {}): vscode.Disposable {
  const pattern = new vscode.RelativePattern(workspace.fsPath, "**/*.rsgl");
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  const compile = () => options.onDidCompile?.(compileWorkspace(workspace, options));
  watcher.onDidCreate(compile);
  watcher.onDidChange(compile);
  watcher.onDidDelete(compile);
  return watcher;
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  return typeof version === "string" ? version : "0.0.0";
}
