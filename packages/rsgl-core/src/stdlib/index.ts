import * as fs from "node:fs";
import * as path from "node:path";
import { ExportDeclNode, ImportDeclNode, parseRsgl, RsglModule } from "../parser";
import type { RsglSourceFile } from "../semantic/types";

export const rsglStdlibScheme = "rsgl:";
export const rsglStdlibVirtualRoot = "<rsgl-stdlib>";

const stdlibDirectoryName = "rsgl";

/** Options for the stdlib discovery entry points; `stdlibRoot` redirects discovery to a different directory (test seam). */
export interface RsglStdlibDiscoveryOptions {
  stdlibRoot?: string;
}

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

export function readRsglStdlibSource(source: string, options: RsglStdlibDiscoveryOptions = {}): string | null {
  const filePath = rsglStdlibSourceFilePath(source, options);
  if (!filePath) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

export function createRsglStdlibSourceFile(source: string, options: RsglStdlibDiscoveryOptions = {}): RsglSourceFile | null {
  const fileName = rsglStdlibVirtualFileName(source);
  const text = readRsglStdlibSource(source, options);
  return fileName && text !== null ? { fileName, module: parseRsgl(text) } : null;
}

export function createAllRsglStdlibSourceFiles(options: RsglStdlibDiscoveryOptions = {}): RsglSourceFile[] {
  return enumerateRsglStdlibModulePaths(options)
    .map(source => createRsglStdlibSourceFile(source, options))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

export function createRsglStdlibPreludeSourceFiles(options: RsglStdlibDiscoveryOptions = {}): RsglSourceFile[] {
  return enumerateRsglStdlibPreludeModulePaths(options)
    .map(source => createRsglStdlibSourceFile(source, options))
    .filter((file): file is RsglSourceFile => Boolean(file));
}

export function readRsglStdlibVirtualSource(fileName: string, options: RsglStdlibDiscoveryOptions = {}): string | null {
  if (!isRsglStdlibVirtualFileName(fileName)) {
    return null;
  }
  const relative = path.relative(rsglStdlibVirtualRoot, fileName).replace(/\\/g, "/");
  return readRsglStdlibSource(relative, options);
}

export function includeRsglStdlibSourceFiles(files: readonly RsglSourceFile[], options: RsglStdlibDiscoveryOptions = {}): RsglSourceFile[] {
  const result = [...files];
  const known = new Set(result.map(file => path.normalize(file.fileName)));

  for (let index = 0; index < result.length; index++) {
    const file = result[index];
    for (const source of collectRsglStdlibImports(file.module)) {
      const sourceFile = createRsglStdlibSourceFile(source, options);
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

function rsglStdlibSourceFilePath(source: string, options: RsglStdlibDiscoveryOptions): string | null {
  const modulePath = normalizeRsglStdlibModulePath(source);
  if (!modulePath) {
    return null;
  }

  for (const root of rsglStdlibRootCandidates(options)) {
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

function enumerateRsglStdlibModulePaths(options: RsglStdlibDiscoveryOptions): string[] {
  const modulePaths: string[] = [];
  const known = new Set<string>();
  for (const root of rsglStdlibRootCandidates(options)) {
    for (const fileName of enumerateRsglFiles(root)) {
      const modulePath = path.relative(root, fileName).replace(/\\/g, "/");
      if (!known.has(modulePath)) {
        known.add(modulePath);
        modulePaths.push(modulePath);
      }
    }
  }
  return modulePaths;
}

function enumerateRsglStdlibPreludeModulePaths(options: RsglStdlibDiscoveryOptions): string[] {
  return enumerateRsglStdlibModulePaths(options).filter(isRsglStdlibPreludeModulePath);
}

function isRsglStdlibPreludeModulePath(modulePath: string): boolean {
  return modulePath === "prelude.rsgl" || modulePath.endsWith("/prelude.rsgl");
}

function enumerateRsglFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fileName = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(fileName);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".rsgl") {
        result.push(path.normalize(fileName));
      }
    }
  };
  visit(root);
  return result;
}

function rsglStdlibRootCandidates(options: RsglStdlibDiscoveryOptions): string[] {
  if (options.stdlibRoot) {
    return [path.normalize(path.resolve(options.stdlibRoot))];
  }
  const candidates = [
    path.join(__dirname, stdlibDirectoryName),
    path.resolve(process.cwd(), "packages", "rsgl-core", "src", "stdlib", stdlibDirectoryName),
    path.resolve(process.cwd(), "extensions", "vscode-rsgl", "out", "packages", "rsgl-core", "src", "stdlib", stdlibDirectoryName)
  ];
  return Array.from(new Set(candidates.map(item => path.normalize(item))));
}
