import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildRsglResourcePackDirectory,
  formatRsglBuildPreview,
  previewRsglResourcePackDirectoryBuild,
  type CompileDependency,
  type RsglBuildOptions
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

interface RsglCliConfig {
  root?: string;
  outDir?: string;
  emitSourceMap?: boolean;
  manifest?: boolean;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

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

const processIo: RsglCliIo = {
  writeOut: text => process.stdout.write(text),
  writeErr: text => process.stderr.write(text)
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
  const context = createCliContext(args);
  let dependencies: CompileDependency[] = [];
  const externalWatchers = new Map<string, fs.FSWatcher>();
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    const result = buildRsglResourcePackDirectory(context.root, context.options);
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
  };
  const scheduleRun = () => {
    if (rebuildTimer) {
      return;
    }
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      run();
    }, 25);
  };
  run();
  fs.watch(context.root, { recursive: true }, (_event, fileName) => {
    if (
      fileName
      && isRsglWatchPathRelevant(path.resolve(context.root, fileName.toString()), dependencies)
    ) {
      scheduleRun();
    }
  });
  io.writeOut(`Watching ${context.root}\n`);
  return 0;
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
    emitSourceMap: true,
    manifest: true
  }, null, 2)}\n`);
  io.writeOut(`Created ${configFileName}\n`);
  return 0;
}

function createCliContext(args: RsglCliArgs): { root: string; options: RsglBuildOptions } {
  const config = readConfig();
  const root = path.resolve(args.root ?? config.root ?? "src");
  const outputRoot = path.resolve(args.outDir ?? config.outDir ?? "assets");
  return {
    root,
    options: {
      outputRoot,
      sourceMaps: config.emitSourceMap ?? true,
      manifest: config.manifest ?? true,
      ...createRsglWorkspaceValidationOptions({
        sourceFileName: root,
        defaultAssetsPath: config.defaultAssetsPath,
        resourcePackRoots: config.resourcePackRoots
      })
    }
  };
}

function readConfig(): RsglCliConfig {
  const fileName = path.resolve("rsgl.config.json");
  if (!fs.existsSync(fileName)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(fileName, "utf8")) as RsglCliConfig;
  } catch (error) {
    throw new Error(`Failed to read ${fileName}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
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
    "Usage: rsgl <command> [root] [--out <dir>]",
    "",
    "Commands:",
    "  init       Create rsgl.config.json",
    "  build      Compile RSGL files and write generated resource pack files",
    "  check      Compile RSGL files without writing generated files",
    "  watch      Rebuild when .rsgl files or imported JSON dependencies change"
  ].join("\n")}\n`);
}
