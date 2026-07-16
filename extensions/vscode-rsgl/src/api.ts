import * as path from "node:path";
import * as vscode from "vscode";
import {
  compileRsglDirectory,
  compileRsglFile,
  emitRsglFiles,
  loadRsglProjectConfigForSource,
  projectCompileOptionsFromRsglConfig,
  type CompileDependency,
  type RsglGlobalExternConfigEntry,
  type RsglCompileDiagnostic,
  type RsglEmittedFile
} from "../../../packages/rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../../packages/rsgl-core/src/workspaceValidation";
import { rsglFileGlob } from "../../../packages/rsgl-shared/src";
import { runRsglWorkerTask } from "./commands/buildWorkerClient";
import {
  DependencyWatchRegistry,
  dependencyBuildNeedsVerification,
  dependencyPathSet,
  isPathWithinRoot,
  normalizeDependencyPath,
  requiresExactDependencyWatcher
} from "./dependencyWatch";
import { RsglProjectConfigWatchRegistry } from "./projectConfigWatch";
import { mergeRsglValidationConfiguration } from "./validationConfiguration";

export interface RsglApi {
  version: string;
  compileFile(uri: vscode.Uri, options?: RsglApiCompileOptions): RsglApiCompileResult;
  compileWorkspace(workspace: vscode.Uri, options?: RsglApiCompileOptions): RsglApiCompileResult;
  checkWorkspace(workspace: vscode.Uri, options?: RsglApiCheckOptions): RsglApiCheckResult;
  createWatcher(workspace: vscode.Uri, options?: RsglApiWatchOptions): vscode.Disposable;
}

export interface RsglApiCheckOptions {
  /** Hard namespace override; takes precedence over file and project declarations. */
  namespace?: string;
  maxEvaluationItems?: number;
  maxItemModelDepth?: number;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
  globalExterns?: RsglGlobalExternConfigEntry[];
  checkExternExistence?: boolean;
}

export interface RsglApiCompileOptions extends RsglApiCheckOptions {
  sourceMaps?: boolean;
  manifest?: boolean;
}

export interface RsglApiWatchOptions extends RsglApiCompileOptions {
  /** Seeds JSON dependency filtering before the first watched RSGL compilation. */
  dependencies?: readonly CompileDependency[];
  onDidCompile?: (result: RsglApiCompileResult) => void;
}

export interface RsglApiCompileResult {
  success: boolean;
  diagnostics: RsglCompileDiagnostic[];
  dependencies: CompileDependency[];
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
    ...apiValidationOptions(sourceFileName, options)
  });
  return toCompileResult(result, options);
}

function compileWorkspace(workspace: vscode.Uri, options: RsglApiCompileOptions = {}): RsglApiCompileResult {
  const result = compileRsglDirectory(workspace.fsPath, {
    ...apiValidationOptions(workspace.fsPath, options)
  });
  return toCompileResult(result, options);
}

function checkWorkspace(workspace: vscode.Uri, options: RsglApiCheckOptions = {}): RsglApiCheckResult {
  const result = compileRsglDirectory(workspace.fsPath, {
    ...apiValidationOptions(workspace.fsPath, options)
  });
  return {
    success: !result.diagnostics.some(diagnostic => diagnostic.severity === "error"),
    diagnostics: result.diagnostics
  };
}

function apiValidationOptions(
  sourceFileName: string,
  options: RsglApiCheckOptions
) {
  const configuration = apiWorkerConfiguration(sourceFileName, options);
  const { defaultAssetsPath, resourcePackRoots, ...compileOptions } = configuration;
  return {
    ...compileOptions,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName,
      defaultAssetsPath,
      resourcePackRoots
    })
  };
}

function apiWorkerConfiguration(
  sourceFileName: string,
  options: RsglApiCheckOptions
) {
  const projectConfig = loadRsglProjectConfigForSource(sourceFileName)?.config;
  const projectCompileOptions = projectCompileOptionsFromRsglConfig(projectConfig ?? {});
  const validationConfiguration = mergeRsglValidationConfiguration(options, {
    defaultAssetsPath: projectConfig?.defaultAssetsPath,
    resourcePackRoots: projectConfig?.resourcePackRoots,
    globalExterns: projectConfig?.extern,
    checkExternExistence: projectConfig?.checkExternExistence
  });
  return {
    ...projectCompileOptions,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    maxEvaluationItems: options.maxEvaluationItems ?? projectCompileOptions.maxEvaluationItems,
    maxItemModelDepth: options.maxItemModelDepth ?? projectCompileOptions.maxItemModelDepth,
    defaultAssetsPath: validationConfiguration.defaultAssetsPath,
    resourcePackRoots: validationConfiguration.resourcePackRoots,
    globalExterns: validationConfiguration.globalExterns,
    checkExternExistence: validationConfiguration.checkExternExistence
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
    dependencies: result.dependencies,
    emittedFiles: success
      ? emitRsglFiles(result.units, {
        sourceMaps: options.sourceMaps ?? true,
        manifest: options.manifest ?? true
      })
      : []
  };
}

function createWatcher(workspace: vscode.Uri, options: RsglApiWatchOptions = {}): vscode.Disposable {
  const rsglWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace.fsPath, rsglFileGlob)
  );
  const jsonWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspace.fsPath, "**/*.json")
  );
  let dependencyPaths = dependencyPathSet(options.dependencies ?? []);
  const invalidatedDuringBuild = new Set<string>();
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let activeCancellation: vscode.CancellationTokenSource | null = null;
  let generation = 0;
  let disposed = false;

  const scheduleCompile = () => {
    if (!options.onDidCompile || disposed) {
      return;
    }
    generation++;
    activeCancellation?.cancel();
    activeCancellation?.dispose();
    activeCancellation = null;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      let workerConfiguration: ReturnType<typeof apiWorkerConfiguration>;
      try {
        workerConfiguration = apiWorkerConfiguration(workspace.fsPath, options);
      } catch (error) {
        console.error("RSGL watcher configuration failed", error);
        return;
      }
      const cancellation = new vscode.CancellationTokenSource();
      activeCancellation = cancellation;
      invalidatedDuringBuild.clear();
      const currentGeneration = generation;
      void runRsglWorkerTask({
        kind: "compileDirectory",
        payload: {
          sourceRoot: workspace.fsPath,
          validationAnchor: workspace.fsPath,
          sourceMaps: options.sourceMaps,
          manifest: options.manifest,
          ...workerConfiguration
        }
      }, cancellation.token).then(outcome => {
        if (
          outcome.type === "success" &&
          !disposed &&
          currentGeneration === generation &&
          !cancellation.token.isCancellationRequested
        ) {
          const nextDependencyPaths = dependencyPathSet(outcome.result.dependencies);
          const needsVerification = dependencyBuildNeedsVerification(
            dependencyPaths,
            nextDependencyPaths,
            invalidatedDuringBuild
          );
          dependencyPaths = nextDependencyPaths;
          externalDependencyWatchers.update(exactDependencyPaths(
            workspace.fsPath,
            outcome.result.dependencies
          ));
          if (needsVerification) {
            scheduleCompile();
          } else {
            options.onDidCompile?.(outcome.result);
          }
        }
      }).catch(error => {
        if (!disposed && currentGeneration === generation) {
          console.error("RSGL watcher compile failed", error);
        }
      }).finally(() => {
        if (activeCancellation === cancellation) {
          activeCancellation = null;
        }
        cancellation.dispose();
      });
    }, 75);
  };

  const projectConfigWatchers = new RsglProjectConfigWatchRegistry(
    workspace.fsPath,
    "directory",
    (fileName, onDidChange) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
        vscode.Uri.file(path.dirname(fileName)),
        path.basename(fileName)
      ));
      watcher.onDidCreate(onDidChange);
      watcher.onDidChange(onDidChange);
      watcher.onDidDelete(onDidChange);
      return watcher;
    },
    scheduleCompile
  );

  const scheduleDependencyCompile = (uri: vscode.Uri) => {
    const dependencyPath = normalizeDependencyPath(uri.fsPath);
    if (activeCancellation) {
      invalidatedDuringBuild.add(dependencyPath);
    }
    if (dependencyPaths.has(dependencyPath)) {
      scheduleCompile();
    }
  };

  const externalDependencyWatchers = new DependencyWatchRegistry(fileName => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(
      vscode.Uri.file(path.dirname(fileName)),
      path.basename(fileName)
    ));
    watcher.onDidCreate(scheduleDependencyCompile);
    watcher.onDidChange(scheduleDependencyCompile);
    watcher.onDidDelete(scheduleDependencyCompile);
    return watcher;
  });
  externalDependencyWatchers.update(exactDependencyPaths(
    workspace.fsPath,
    options.dependencies ?? []
  ));

  rsglWatcher.onDidCreate(scheduleCompile);
  rsglWatcher.onDidChange(scheduleCompile);
  rsglWatcher.onDidDelete(scheduleCompile);
  jsonWatcher.onDidCreate(scheduleDependencyCompile);
  jsonWatcher.onDidChange(scheduleDependencyCompile);
  jsonWatcher.onDidDelete(scheduleDependencyCompile);
  return new vscode.Disposable(() => {
    disposed = true;
    generation++;
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    activeCancellation?.cancel();
    activeCancellation?.dispose();
    activeCancellation = null;
    rsglWatcher.dispose();
    jsonWatcher.dispose();
    projectConfigWatchers.dispose();
    externalDependencyWatchers.dispose();
  });
}

function exactDependencyPaths(
  workspaceRoot: string,
  dependencies: readonly CompileDependency[]
): string[] {
  return dependencies
    .map(dependency => dependency.path)
    .filter(fileName => requiresExactDependencyWatcher(
      fileName,
      isPathWithinRoot(workspaceRoot, fileName)
    ));
}

function extensionVersion(context: vscode.ExtensionContext): string {
  const version = context.extension.packageJSON?.version;
  return typeof version === "string" ? version : "0.0.0";
}
