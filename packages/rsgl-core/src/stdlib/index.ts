import * as fs from "node:fs";
import * as path from "node:path";
import { ExportDeclNode, ImportDeclNode, parseRsgl, RsglModule } from "../parser";
import { RsglSourceFile } from "../semantic";

export const rsglStdlibScheme = "rsgl:";
export const rsglStdlibVirtualRoot = "<rsgl-stdlib>";
export const rsglStdlibOverrideDirectory = "rsgl-std";

const stdlibDirectoryName = "rsgl";

const stdlibModulePaths = [
  "constants.rsgl",
  "blockstates/stairs.rsgl",
  "blockstates/slab.rsgl",
  "blockstates/fence.rsgl",
  "blockstates/fence_gate.rsgl",
  "blockstates/door.rsgl",
  "blockstates/trapdoor.rsgl",
  "blockstates/wall.rsgl",
  "blockstates/pane.rsgl"
] as const;

const preludeModulePaths = [
  "blockstates/stairs.rsgl",
  "blockstates/slab.rsgl",
  "blockstates/fence.rsgl",
  "blockstates/fence_gate.rsgl",
  "blockstates/door.rsgl",
  "blockstates/trapdoor.rsgl",
  "blockstates/wall.rsgl",
  "blockstates/pane.rsgl"
];

export function isRsglStdlibImportSource(source: string): boolean {
  return source.startsWith(rsglStdlibScheme);
}

export function normalizeRsglStdlibModulePath(source: string): string | null {
  const raw = isRsglStdlibImportSource(source) ? source.slice(rsglStdlibScheme.length) : source;
  const normalized = raw.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.includes("..")) {
    return null;
  }
  return normalized.endsWith(".rsgl") ? normalized : `${normalized}.rsgl`;
}

export function rsglStdlibVirtualFileName(source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  return modulePath ? path.join(rsglStdlibVirtualRoot, modulePath) : null;
}

export function isRsglStdlibVirtualFileName(fileName: string): boolean {
  return path.normalize(fileName).startsWith(path.normalize(rsglStdlibVirtualRoot + path.sep));
}

export function readRsglStdlibSource(source: string): string | null {
  const filePath = rsglStdlibSourceFilePath(source);
  if (!filePath) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function createRsglStdlibSourceFile(source: string): RsglSourceFile | null {
  const fileName = rsglStdlibVirtualFileName(source);
  const text = readRsglStdlibSource(source);
  return fileName && text !== null ? { fileName, module: parseRsgl(text) } : null;
}

export function createAllRsglStdlibSourceFiles(): RsglSourceFile[] {
  return stdlibModulePaths
    .map(source => createRsglStdlibSourceFile(source))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

export function createRsglStdlibPreludeSourceFiles(fromFileName?: string): RsglSourceFile[] {
  return preludeModulePaths
    .map(source => createRsglStdlibPreludeSourceFile(source, fromFileName))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

function createRsglStdlibPreludeSourceFile(source: string, fromFileName: string | undefined): RsglSourceFile | null {
  const override = fromFileName ? resolveRsglStdlibOverrideFromDisk(fromFileName, source) : null;
  if (override) {
    try {
      return { fileName: path.normalize(override), module: parseRsgl(fs.readFileSync(override, "utf8")) };
    } catch {
      return null;
    }
  }
  return createRsglStdlibSourceFile(source);
}

export function readRsglStdlibVirtualSource(fileName: string): string | null {
  if (!isRsglStdlibVirtualFileName(fileName)) {
    return null;
  }
  const relative = path.relative(rsglStdlibVirtualRoot, fileName).replace(/\\/g, "/");
  return readRsglStdlibSource(relative);
}

export function resolveRsglStdlibOverrideFromDisk(fromFileName: string, source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath || isRsglStdlibVirtualFileName(fromFileName)) {
    return null;
  }

  let directory = path.dirname(path.resolve(fromFileName));
  while (true) {
    const candidate = path.join(directory, rsglStdlibOverrideDirectory, ...modulePath.split("/"));
    try {
      if (fs.statSync(candidate).isFile()) {
        return path.normalize(candidate);
      }
    } catch {
      // Keep walking parent directories.
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      return null;
    }
    directory = parent;
  }
}

export function resolveRsglStdlibOverrideFromFiles(source: string, fileNames: readonly string[]): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath) {
    return null;
  }
  const suffix = path.join(rsglStdlibOverrideDirectory, ...modulePath.split("/")).toLowerCase();
  return fileNames.find(fileName => path.normalize(fileName).toLowerCase().endsWith(suffix)) ?? null;
}

export function includeRsglStdlibSourceFiles(files: readonly RsglSourceFile[]): RsglSourceFile[] {
  const result = [...files];
  const known = new Set(result.map(file => path.normalize(file.fileName)));

  for (let index = 0; index < result.length; index++) {
    const file = result[index];
    for (const source of collectRsglStdlibImports(file.module)) {
      if (resolveRsglStdlibOverrideFromFiles(source, result.map(item => item.fileName))) {
        continue;
      }
      const sourceFile = createRsglStdlibSourceFile(source);
      if (!sourceFile) {
        continue;
      }
      const normalized = path.normalize(sourceFile.fileName);
      if (!known.has(normalized)) {
        known.add(normalized);
        result.push(sourceFile);
      }
    }
  }

  return result;
}

export function collectRsglStdlibImports(module: RsglModule): string[] {
  return module.statements
    .filter((statement): statement is ImportDeclNode | ExportDeclNode => statement.kind === "ImportDecl" || statement.kind === "ExportDecl")
    .map(statement => statement.source?.value)
    .filter((source): source is string => Boolean(source && isRsglStdlibImportSource(source)));
}

function rsglStdlibSourceFilePath(source: string): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath) {
    return null;
  }

  for (const root of rsglStdlibRootCandidates()) {
    const candidate = path.join(root, ...modulePath.split("/"));
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next candidate root.
    }
  }
  return null;
}

function rsglStdlibRootCandidates(): string[] {
  const candidates = [
    path.join(__dirname, stdlibDirectoryName),
    path.resolve(process.cwd(), "packages", "rsgl-core", "src", "stdlib", stdlibDirectoryName),
    path.resolve(process.cwd(), "extensions", "vscode-rsgl", "out", "packages", "rsgl-core", "src", "stdlib", stdlibDirectoryName)
  ];
  return Array.from(new Set(candidates.map(item => path.normalize(item))));
}
