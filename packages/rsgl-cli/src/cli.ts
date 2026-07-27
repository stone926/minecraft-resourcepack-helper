import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MAX_EVALUATION_ITEMS,
  DEFAULT_MAX_ITEM_MODEL_DEPTH,
  buildRsglResourcePackDirectory,
  compileDependencyMatchesPath,
  compileDependencyPatternStructurallyMatchesPath,
  compileDependencyWatchPattern,
  compileOptionsFromProjectConfig,
  createRsglMaterializationProject,
  getRsglProjectConfigWatchPaths,
  assertRsglOutputPackRoot,
  isRsglPathInsideOrEqual,
  loadRsglProjectConfigForSource,
  projectEmitOptionsFromRsglConfig,
  previewRsglResourcePackDirectoryBuild,
  rebaseCompileDependencyWatchPattern,
  resolveRsglOutputPackRoot,
  resolvedRsglPathKey,
  type CompileDependency,
  type RsglBuildOptions,
  type RsglBuildResult
} from "../../rsgl-core/src";

export interface RsglCliArgs {
  command: string;
  root?: string;
  outDir?: string;
  watch?: boolean;
  preview?: boolean;
  adoptIdentical?: boolean;
}

/** Output sinks for CLI text, injectable for tests. */
export interface RsglCliIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface RsglCliContext {
  root: string;
  options: RsglBuildOptions;
  configSearchRoot: string;
  configFileName: string | null;
}

export interface RsglCliWatchHandle {
  close(): void;
  onError?(listener: () => void): void;
  onClose?(listener: () => void): void;
}

export interface RsglCliWatchRuntime {
  build(root: string, options: RsglBuildOptions): RsglBuildResult;
  watchDirectory(
    directory: string,
    recursive: boolean,
    listener: (eventType: string, fileName: string | Buffer | null) => void
  ): RsglCliWatchHandle;
  watchConfigFile(fileName: string, listener: () => void): RsglCliWatchHandle;
  setTimer(listener: () => void, delay: number): unknown;
  clearTimer(handle: unknown): void;
}

export interface RsglCliWatchSession {
  close(): void;
  currentContext(): RsglCliContext;
}

const processIo: RsglCliIo = {
  writeOut: text => process.stdout.write(text),
  writeErr: text => process.stderr.write(text)
};

const defaultWatchRuntime: RsglCliWatchRuntime = {
  build: (root, options) => buildRsglResourcePackDirectory(root, options),
  watchDirectory: (directory, recursive, listener) => {
    const watcher = fs.watch(directory, { recursive }, listener);
    return {
      close: () => watcher.close(),
      onError: callback => { watcher.on("error", callback); },
      onClose: callback => { watcher.on("close", callback); }
    };
  },
  watchConfigFile: (fileName, listener) => {
    let initialized = false;
    const watchListener = (current: fs.Stats, previous: fs.Stats) => {
      if (!initialized) {
        initialized = true;
        if (current.nlink === 0 && previous.nlink === 0) {
          return;
        }
      }
      listener();
    };
    fs.watchFile(fileName, { interval: 100 }, watchListener);
    return { close: () => fs.unwatchFile(fileName, watchListener) };
  },
  setTimer: (listener, delay) => setTimeout(listener, delay),
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** Runs the RSGL CLI for the given argument vector and returns the process exit code. */
export function runRsglCli(argv: string[], io: RsglCliIo = processIo): number {
  const args = parseRsglCliArgs(argv);
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp(io);
    return 0;
  }
  if (args.command === "init") {
    return initConfig(io);
  }
  if (args.command === "watch" || args.watch) {
    return watch(args, io);
  }
  if (args.command === "check") {
    return check(args, io);
  }
  if (args.command === "build") {
    return build(args, io);
  }

  io.writeErr(`Unknown RSGL command: ${args.command}\n`);
  printHelp(io);
  return 2;
}

function build(args: RsglCliArgs, io: RsglCliIo): number {
  const context = createCliContext(args);
  if (args.preview) {
    const result = previewRsglResourcePackDirectoryBuild(context.root, context.options);
    printDiagnostics(result.diagnostics, io);
    if (result.preview) {
      io.writeOut(result.preview);
    }
    return result.diagnostics.some(diagnostic => diagnostic.severity === "error") ? 1 : 0;
  }
  const result = buildRsglResourcePackDirectory(context.root, context.options);
  printDiagnostics(result.diagnostics, io);
  if (result.plan && (!result.materialization || result.materialization.status === "committed")) {
    io.writeOut(`RSGL build complete: ${result.plan.summary.create} created, ${result.plan.summary.update} updated, ${result.plan.summary.unchanged} unchanged.\n`);
  }
  return result.diagnostics.some(diagnostic => diagnostic.severity === "error") ? 1 : 0;
}

function check(args: RsglCliArgs, io: RsglCliIo): number {
  const context = createCliContext(args);
  const result = previewRsglResourcePackDirectoryBuild(context.root, context.options);
  printDiagnostics(result.diagnostics, io);
  return result.diagnostics.some(diagnostic => diagnostic.severity === "error") ? 1 : 0;
}

function watch(args: RsglCliArgs, io: RsglCliIo): number {
  startRsglCliWatch(args, io);
  return 0;
}

/** Starts a rebuild session whose source and config watchers follow config changes. */
export function startRsglCliWatch(
  args: RsglCliArgs,
  io: RsglCliIo,
  runtime: RsglCliWatchRuntime = defaultWatchRuntime
): RsglCliWatchSession {
  const configSearchRoot = resolveCliConfigSearchRoot(args);
  let context: RsglCliContext;
  try {
    context = createCliContextForSearchRoot(args, configSearchRoot);
  } catch {
    context = createCliContextWithoutConfig(args, configSearchRoot);
  }
  let dependencies: CompileDependency[] = [];
  let sourceWatcher: RsglCliWatchHandle | undefined;
  let sourceWatchRoot: string | undefined;
  let pendingSourceRootWatcher: RsglCliWatchHandle | undefined;
  let pendingSourceWatchRoot: string | undefined;
  let rebuildTimer: unknown;
  let rebuildScheduled = false;
  let closed = false;
  let hasRun = false;
  const configWatchers = new Map<string, RsglCliWatchHandle>();
  const externalWatchers = new Map<string, RsglCliWatchHandle>();

  const scheduleRun = () => {
    if (closed || rebuildScheduled) {
      return;
    }
    rebuildScheduled = true;
    rebuildTimer = runtime.setTimer(() => {
      rebuildScheduled = false;
      rebuildTimer = undefined;
      run();
    }, 25);
  };

  const syncConfigWatchers = () => {
    const requiredPaths = new Set(
      getRsglProjectConfigWatchPaths(configSearchRoot, "directory").map(normalizeWatchPath)
    );
    for (const [configPath, watcher] of configWatchers) {
      if (!requiredPaths.has(configPath)) {
        configWatchers.delete(configPath);
        watcher.close();
      }
    }
    for (const configPath of requiredPaths) {
      if (!configWatchers.has(configPath)) {
        configWatchers.set(configPath, runtime.watchConfigFile(configPath, scheduleRun));
      }
    }
  };

  const syncSourceWatcher = (root: string) => {
    const normalizedRoot = normalizeWatchPath(root);
    if (sourceWatcher && sourceWatchRoot === normalizedRoot) {
      pendingSourceRootWatcher?.close();
      pendingSourceRootWatcher = undefined;
      pendingSourceWatchRoot = undefined;
      return;
    }
    let nextWatcher: RsglCliWatchHandle;
    try {
      nextWatcher = runtime.watchDirectory(root, true, (eventType, fileName) => {
        if (
          !fileName
          || isRsglWatchEventRelevant(
            path.resolve(root, fileName.toString()),
            eventType,
            dependencies
          )
        ) {
          scheduleRun();
        }
      });
    } catch (error) {
      if (pendingSourceWatchRoot !== normalizedRoot) {
        pendingSourceRootWatcher?.close();
        pendingSourceWatchRoot = normalizedRoot;
        pendingSourceRootWatcher = runtime.watchConfigFile(root, scheduleRun);
      }
      throw error;
    }
    const previousWatcher = sourceWatcher;
    sourceWatcher = nextWatcher;
    sourceWatchRoot = normalizedRoot;
    previousWatcher?.close();
    pendingSourceRootWatcher?.close();
    pendingSourceRootWatcher = undefined;
    pendingSourceWatchRoot = undefined;
  };

  const run = () => {
    syncConfigWatchers();
    let nextContext: RsglCliContext;
    try {
      nextContext = createCliContextForSearchRoot(args, configSearchRoot);
    } catch (error) {
      io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }

    const rootChanged = normalizeWatchPath(context.root) !== normalizeWatchPath(nextContext.root);
    let result: RsglBuildResult;
    try {
      syncSourceWatcher(nextContext.root);
      context = nextContext;
      result = runtime.build(context.root, context.options);
    } catch (error) {
      io.writeErr(`${error instanceof Error ? error.message : String(error)}\n`);
      return;
    }
    dependencies = result.dependencies;
    const externalWatchersExpanded = syncExternalDependencyWatchers(
      context.root,
      dependencies,
      externalWatchers,
      runtime,
      () => dependencies,
      scheduleRun
    );
    printDiagnostics(result.diagnostics, io);
    if (result.plan && (!result.materialization || result.materialization.status === "committed")) {
      io.writeOut(`RSGL build complete: ${result.plan.summary.create} created, ${result.plan.summary.update} updated, ${result.plan.summary.unchanged} unchanged.\n`);
    }
    if (hasRun && rootChanged) {
      io.writeOut(`Watching ${context.root}\n`);
    }
    hasRun = true;
    if (externalWatchersExpanded) {
      // Verify once after installing newly discovered external watchers. A
      // dependency can change between the build and watcher installation.
      scheduleRun();
    }
  };

  syncConfigWatchers();
  run();
  io.writeOut(`Watching ${context.root}\n`);
  return {
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (rebuildScheduled) {
        runtime.clearTimer(rebuildTimer);
      }
      sourceWatcher?.close();
      pendingSourceRootWatcher?.close();
      for (const watcher of configWatchers.values()) {
        watcher.close();
      }
      configWatchers.clear();
      for (const watcher of externalWatchers.values()) {
        watcher.close();
      }
      externalWatchers.clear();
    },
    currentContext: () => context
  };
}

/** Returns whether a watcher event can invalidate the current RSGL build. */
export function isRsglWatchPathRelevant(
  changedPath: string,
  dependencies: readonly CompileDependency[]
): boolean {
  if (path.extname(changedPath).toLowerCase() === ".rsgl") {
    return true;
  }
  return isKnownDependencyPath(changedPath, dependencies);
}

function isRsglWatchEventRelevant(
  changedPath: string,
  eventType: string,
  dependencies: readonly CompileDependency[]
): boolean {
  if (isRsglWatchPathRelevant(changedPath, dependencies)) {
    return true;
  }
  if (eventType !== "rename") {
    return false;
  }
  const candidateExists = pathExists(changedPath);
  const candidateIsDirectory = candidateExists && isDirectory(changedPath);
  return dependencies.some(dependency => {
    if (isRsglPathInsideOrEqual(dependency.path, changedPath)) {
      return true;
    }
    const pattern = compileDependencyWatchPattern(dependency);
    return Boolean(
      pattern
      && compileDependencyPatternStructurallyMatchesPath(pattern, changedPath)
      && (!candidateExists || candidateIsDirectory)
    );
  });
}

function isKnownDependencyPath(
  changedPath: string,
  dependencies: readonly CompileDependency[]
): boolean {
  return dependencies.some(dependency => compileDependencyMatchesPath(dependency, changedPath));
}

function syncExternalDependencyWatchers(
  root: string,
  dependencies: readonly CompileDependency[],
  watchers: Map<string, RsglCliWatchHandle>,
  runtime: RsglCliWatchRuntime,
  currentDependencies: () => readonly CompileDependency[],
  rebuild: () => void
): boolean {
  const requiredDirectories = new Set<string>();
  let expanded = false;
  for (const dependency of dependencies) {
    const dependencyPath = path.resolve(dependency.path);
    if (!isRsglPathInsideOrEqual(dependencyPath, root)) {
      const pattern = compileDependencyWatchPattern(dependency);
      const watchDirectory = pattern
        ? rebaseCompileDependencyWatchPattern(pattern, isDirectory).basePath
        : nearestExistingWatchDirectory(path.dirname(dependencyPath));
      requiredDirectories.add(normalizeWatchPath(watchDirectory));
    }
  }

  for (const [directory, watcher] of watchers) {
    if (!requiredDirectories.has(directory)) {
      watchers.delete(directory);
      watcher.close();
    }
  }

  for (const directory of requiredDirectories) {
    if (watchers.has(directory)) {
      continue;
    }
    try {
      const watcher = runtime.watchDirectory(directory, true, (eventType, fileName) => {
        if (
          !fileName
          || watchEventCanAffectDependency(
            directory,
            fileName.toString(),
            eventType,
            currentDependencies()
          )
        ) {
          rebuild();
        }
      });
      watchers.set(directory, watcher);
      expanded = true;
      watcher.onError?.(() => recoverExternalWatcher(directory, watcher, watchers, rebuild));
      watcher.onClose?.(() => recoverExternalWatcher(directory, watcher, watchers, rebuild, false));
    } catch {
      // A missing/unwatchable external directory remains a recorded dependency and
      // will be picked up once another source change refreshes the watcher set.
    }
  }
  return expanded;
}

/** Finds the closest existing directory that can observe creation of a missing dependency parent. */
export function nearestExistingWatchDirectory(directory: string): string {
  let candidate = path.resolve(directory);
  while (!isDirectory(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return candidate;
    }
    candidate = parent;
  }
  return candidate;
}

function watchEventCanAffectDependency(
  watchedDirectory: string,
  fileName: string,
  eventType: string,
  dependencies: readonly CompileDependency[]
): boolean {
  const changedPath = path.resolve(watchedDirectory, fileName);
  return isRsglWatchEventRelevant(changedPath, eventType, dependencies);
}

function recoverExternalWatcher(
  directory: string,
  watcher: RsglCliWatchHandle,
  watchers: Map<string, RsglCliWatchHandle>,
  rebuild: () => void,
  close = true
): void {
  if (watchers.get(directory) !== watcher) {
    return;
  }
  watchers.delete(directory);
  if (close) {
    watcher.close();
  }
  rebuild();
}

function isDirectory(directory: string): boolean {
  try {
    return fs.statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

function pathExists(fileName: string): boolean {
  try {
    fs.statSync(fileName);
    return true;
  } catch {
    return false;
  }
}

function normalizeWatchPath(fileName: string): string {
  return resolvedRsglPathKey(fileName);
}

function initConfig(io: RsglCliIo): number {
  const configFileName = path.resolve("rsgl.config.json");
  if (fs.existsSync(configFileName)) {
    io.writeErr("rsgl.config.json already exists.\n");
    return 1;
  }
  fs.writeFileSync(configFileName, `${JSON.stringify({
    root: "src",
    outDir: ".generated",
    namespace: "minecraft",
    maxEvaluationItems: DEFAULT_MAX_EVALUATION_ITEMS,
    maxItemModelDepth: DEFAULT_MAX_ITEM_MODEL_DEPTH,
    emitSourceMap: true,
    manifest: true
  }, null, 2)}\n`);
  io.writeOut(`Created ${configFileName}\n`);
  return 0;
}

/** Resolves CLI paths and validated config into core build options. */
export function createCliContext(args: RsglCliArgs): RsglCliContext {
  return createCliContextForSearchRoot(args, resolveCliConfigSearchRoot(args));
}

function createCliContextForSearchRoot(args: RsglCliArgs, configSearchRoot: string): RsglCliContext {
  const loadedConfig = loadRsglProjectConfigForSource(configSearchRoot);
  const config = loadedConfig?.config ?? {};
  const root = config.root ?? configSearchRoot;
  const outputRoot = args.outDir
    ? assertRsglOutputPackRoot(path.resolve(args.outDir), "--out")
    : resolveRsglOutputPackRoot(root, config.outDir) ?? path.resolve(".generated");
  return {
    root,
    configSearchRoot,
    configFileName: loadedConfig?.fileName ?? null,
    options: {
      outputRoot,
      materializationProject: createRsglMaterializationProject(
        root,
        outputRoot,
        loadedConfig ? path.dirname(loadedConfig.fileName) : outputRoot
      ),
      materializationSourceRoot: root,
      adoptUnownedIdentical: args.adoptIdentical,
      ...projectEmitOptionsFromRsglConfig(config),
      ...compileOptionsFromProjectConfig(config, {
        sourceFileName: root,
        outputPackRoot: outputRoot
      })
    }
  };
}

function createCliContextWithoutConfig(
  args: RsglCliArgs,
  configSearchRoot: string
): RsglCliContext {
  const root = configSearchRoot;
  const outputRoot = args.outDir
    ? assertRsglOutputPackRoot(path.resolve(args.outDir), "--out")
    : resolveRsglOutputPackRoot(root) ?? path.resolve(".generated");
  return {
    root,
    configSearchRoot,
    configFileName: null,
    options: {
      outputRoot,
      materializationProject: createRsglMaterializationProject(root, outputRoot, outputRoot),
      materializationSourceRoot: root,
      adoptUnownedIdentical: args.adoptIdentical,
      sourceMaps: true,
      manifest: true,
      ...compileOptionsFromProjectConfig({}, { sourceFileName: root, outputPackRoot: outputRoot })
    }
  };
}

function resolveCliConfigSearchRoot(args: RsglCliArgs): string {
  return path.resolve(args.root ?? "src");
}

/** Parses a raw argument vector into the CLI command and its options. */
export function parseRsglCliArgs(argv: string[]): RsglCliArgs {
  const [command = "help", ...rest] = argv;
  const result: RsglCliArgs = { command };
  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--out" || arg === "--outDir") {
      result.outDir = rest[++index];
    } else if (arg === "--watch") {
      result.watch = true;
    } else if (arg === "--preview") {
      result.preview = true;
    } else if (arg === "--adopt-identical") {
      result.adoptIdentical = true;
    } else if (!result.root) {
      result.root = arg;
    }
  }
  return result;
}

function printDiagnostics(diagnostics: { severity: string; code: string; message: string; fileName?: string }[], io: RsglCliIo): void {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.fileName ? `${diagnostic.fileName}: ` : "";
    io.writeErr(`${location}${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}\n`);
  }
}

function printHelp(io: RsglCliIo): void {
  io.writeOut(`${[
    "Usage: rsgl <command> [root|file] [options]",
    "",
    "Commands:",
    "  init       Create rsgl.config.json",
    "  build      Compile RSGL files and write generated resource pack files",
    "  check      Compile RSGL files without writing generated files",
    "  watch      Rebuild when .rsgl files, project config, or dependencies change",
    "",
    "Options:",
    "  --out <dir>, --outDir <dir>  Override the output directory for build, check, and watch",
    "  --preview                    Preview changes without writing generated files (build only)",
    "  --adopt-identical            Claim byte-identical unowned outputs after explicit review",
    "  --watch                      Rebuild after changes (build only; equivalent to watch)"
  ].join("\n")}\n`);
}
