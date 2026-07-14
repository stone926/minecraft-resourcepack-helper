import * as fs from "node:fs";
import * as path from "node:path";
import {
  DEFAULT_MAX_EVALUATION_ITEMS,
  buildRsglResourcePackDirectory,
  formatRsglBuildPreview,
  getRsglProjectConfigWatchPaths,
  loadRsglProjectConfigForSource,
  projectCompileOptionsFromRsglConfig,
  previewRsglResourcePackDirectoryBuild,
  type CompileDependency,
  type RsglBuildOptions,
  type RsglBuildResult
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

export interface RsglCliArgs {
  command: string;
  root?: string;
  outDir?: string;
  watch?: boolean;
  preview?: boolean;
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
  watchDirectory: (directory, recursive, listener) => fs.watch(directory, { recursive }, listener),
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
  const result = args.preview
    ? previewRsglResourcePackDirectoryBuild(context.root, context.options)
    : buildRsglResourcePackDirectory(context.root, context.options);
  printDiagnostics(result.diagnostics, io);
  if (args.preview && result.plan) {
    io.writeOut(formatRsglBuildPreview(result.plan, { sourceRoot: context.root }));
  } else if (result.plan) {
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
  const externalWatchers = new Map<string, fs.FSWatcher>();

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
      nextWatcher = runtime.watchDirectory(root, true, (_event, fileName) => {
        if (
          fileName
          && isRsglWatchPathRelevant(path.resolve(root, fileName.toString()), dependencies)
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
    syncExternalDependencyWatchers(
      context.root,
      dependencies,
      externalWatchers,
      () => dependencies,
      scheduleRun
    );
    printDiagnostics(result.diagnostics, io);
    if (result.plan) {
      io.writeOut(`RSGL build complete: ${result.plan.summary.create} created, ${result.plan.summary.update} updated, ${result.plan.summary.unchanged} unchanged.\n`);
    }
    if (hasRun && rootChanged) {
      io.writeOut(`Watching ${context.root}\n`);
    }
    hasRun = true;
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

function isKnownDependencyPath(
  changedPath: string,
  dependencies: readonly CompileDependency[]
): boolean {
  const normalizedChangedPath = normalizeWatchPath(changedPath);
  return dependencies.some(dependency => normalizeWatchPath(dependency.path) === normalizedChangedPath);
}

function syncExternalDependencyWatchers(
  root: string,
  dependencies: readonly CompileDependency[],
  watchers: Map<string, fs.FSWatcher>,
  currentDependencies: () => readonly CompileDependency[],
  rebuild: () => void
): void {
  const requiredDirectories = new Set<string>();
  for (const dependency of dependencies) {
    const dependencyPath = path.resolve(dependency.path);
    if (!isPathWithinRoot(root, dependencyPath)) {
      requiredDirectories.add(normalizeWatchPath(nearestExistingWatchDirectory(path.dirname(dependencyPath))));
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
      const watcher = fs.watch(directory, (_event, fileName) => {
        if (
          !fileName
          || watchEventCanAffectDependency(directory, fileName.toString(), currentDependencies())
        ) {
          rebuild();
        }
      });
      watchers.set(directory, watcher);
      watcher.on("error", () => recoverExternalWatcher(directory, watcher, watchers, rebuild));
      watcher.on("close", () => recoverExternalWatcher(directory, watcher, watchers, rebuild, false));
    } catch {
      // A missing/unwatchable external directory remains a recorded dependency and
      // will be picked up once another source change refreshes the watcher set.
    }
  }
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
  dependencies: readonly CompileDependency[]
): boolean {
  const changedPath = path.resolve(watchedDirectory, fileName);
  return dependencies.some(dependency => {
    const dependencyPath = path.resolve(dependency.path);
    return normalizeWatchPath(changedPath) === normalizeWatchPath(dependencyPath)
      || isPathWithinRoot(changedPath, dependencyPath);
  });
}

function recoverExternalWatcher(
  directory: string,
  watcher: fs.FSWatcher,
  watchers: Map<string, fs.FSWatcher>,
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

function isPathWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeWatchPath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
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
  const root = args.root ? configSearchRoot : (config.root ?? configSearchRoot);
  const outputRoot = args.outDir ? path.resolve(args.outDir) : (config.outDir ?? path.resolve("assets"));
  return {
    root,
    configSearchRoot,
    configFileName: loadedConfig?.fileName ?? null,
    options: {
      outputRoot,
      sourceMaps: config.emitSourceMap ?? true,
      manifest: config.manifest ?? true,
      ...projectCompileOptionsFromRsglConfig(config),
      globalExterns: config.extern,
      checkExternExistence: config.checkExternExistence,
      ...createRsglWorkspaceValidationOptions({
        sourceFileName: root,
        defaultAssetsPath: config.defaultAssetsPath,
        resourcePackRoots: config.resourcePackRoots
      })
    }
  };
}

function createCliContextWithoutConfig(
  args: RsglCliArgs,
  configSearchRoot: string
): RsglCliContext {
  const root = configSearchRoot;
  return {
    root,
    configSearchRoot,
    configFileName: null,
    options: {
      outputRoot: args.outDir ? path.resolve(args.outDir) : path.resolve("assets"),
      sourceMaps: true,
      manifest: true,
      ...createRsglWorkspaceValidationOptions({ sourceFileName: root })
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
    "  --watch                      Rebuild after changes (build only; equivalent to watch)"
  ].join("\n")}\n`);
}
