import * as fs from "node:fs";
import * as path from "node:path";
import {
  buildRsglResourcePackDirectory,
  formatRsglBuildPreview,
  previewRsglResourcePackDirectoryBuild,
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

interface ParsedArgs {
  command: string;
  root?: string;
  outDir?: string;
  watch?: boolean;
  preview?: boolean;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    printHelp();
    return 0;
  }
  if (args.command === "init") {
    return initConfig();
  }
  if (args.command === "watch" || args.watch) {
    return watch(args);
  }
  if (args.command === "check") {
    return check(args);
  }
  if (args.command === "build") {
    return build(args);
  }

  console.error(`Unknown RSGL command: ${args.command}`);
  printHelp();
  return 2;
}

function build(args: ParsedArgs): number {
  const context = createCliContext(args);
  const result = args.preview
    ? previewRsglResourcePackDirectoryBuild(context.root, context.options)
    : buildRsglResourcePackDirectory(context.root, context.options);
  printDiagnostics(result.diagnostics);
  if (args.preview && result.plan) {
    process.stdout.write(formatRsglBuildPreview(result.plan, { sourceRoot: context.root }));
  } else if (result.plan) {
    console.log(`RSGL build complete: ${result.plan.summary.create} created, ${result.plan.summary.update} updated, ${result.plan.summary.unchanged} unchanged.`);
  }
  return result.diagnostics.some(diagnostic => diagnostic.severity === "error") ? 1 : 0;
}

function check(args: ParsedArgs): number {
  const context = createCliContext(args);
  const result = previewRsglResourcePackDirectoryBuild(context.root, context.options);
  printDiagnostics(result.diagnostics);
  return result.diagnostics.some(diagnostic => diagnostic.severity === "error") ? 1 : 0;
}

function watch(args: ParsedArgs): number {
  const context = createCliContext(args);
  const run = () => {
    const result = buildRsglResourcePackDirectory(context.root, context.options);
    printDiagnostics(result.diagnostics);
    if (result.plan) {
      console.log(`RSGL build complete: ${result.plan.summary.create} created, ${result.plan.summary.update} updated, ${result.plan.summary.unchanged} unchanged.`);
    }
  };
  run();
  fs.watch(context.root, { recursive: true }, (_event, fileName) => {
    if (fileName && path.extname(fileName.toString()).toLowerCase() === ".rsgl") {
      run();
    }
  });
  console.log(`Watching ${context.root}`);
  return 0;
}

function initConfig(): number {
  const configFileName = path.resolve("rsgl.config.json");
  if (fs.existsSync(configFileName)) {
    console.error("rsgl.config.json already exists.");
    return 1;
  }
  fs.writeFileSync(configFileName, `${JSON.stringify({
    root: "src",
    outDir: ".generated",
    emitSourceMap: true,
    manifest: true
  }, null, 2)}\n`);
  console.log(`Created ${configFileName}`);
  return 0;
}

function createCliContext(args: ParsedArgs): { root: string; options: RsglBuildOptions } {
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

function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const result: ParsedArgs = { command };
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

function printDiagnostics(diagnostics: { severity: string; code: string; message: string; fileName?: string }[]): void {
  for (const diagnostic of diagnostics) {
    const location = diagnostic.fileName ? `${diagnostic.fileName}: ` : "";
    const line = `${location}${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`;
    if (diagnostic.severity === "error") {
      console.error(line);
    } else {
      console.warn(line);
    }
  }
}

function printHelp(): void {
  console.log([
    "Usage: rsgl <command> [root] [--out <dir>]",
    "",
    "Commands:",
    "  init       Create rsgl.config.json",
    "  build      Compile RSGL files and write generated resource pack files",
    "  check      Compile RSGL files without writing generated files",
    "  watch      Rebuild when .rsgl files change"
  ].join("\n"));
}

if (require.main === module) {
  process.exitCode = main();
}
