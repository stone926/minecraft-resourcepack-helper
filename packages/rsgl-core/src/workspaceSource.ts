import * as fs from "node:fs";
import * as path from "node:path";
import {
  ExportDeclNode,
  ImportDeclNode,
  RsglModule,
  parseRsgl
} from "./parser";
import { RsglSourceFile } from "./semantic";
import {
  isRsglStdlibImportSource,
  readRsglStdlibVirtualSource,
  rsglStdlibVirtualFileName
} from "./stdlib";

export interface RsglTextDocumentLike {
  fileName: string;
  version?: number;
  getText(): string;
}

export interface RsglWorkspaceSourceCacheOptions {
  encoding?: BufferEncoding;
  fileSystem?: RsglWorkspaceSourceFileSystem;
}

export type RsglOpenTextDocumentProvider = (fileName: string) => RsglTextDocumentLike | null;

export interface RsglWorkspaceSourceFileStat {
  mtimeMs: number;
  size: number;
  isFile(): boolean;
}

export interface RsglWorkspaceSourceFileSystem {
  statFile(fileName: string): RsglWorkspaceSourceFileStat;
  readTextFile(fileName: string, encoding: BufferEncoding): string;
}

interface RsglCachedSourceFile {
  versionKey: string;
  sourceFile: RsglSourceFile;
}

interface RsglSourceReadResult {
  text: string;
  versionKey: string;
}

export class RsglWorkspaceSourceCache {
  private readonly sourceFiles = new Map<string, RsglCachedSourceFile>();
  private openTextDocumentProvider: RsglOpenTextDocumentProvider | null = null;
  private readonly fileSystem: RsglWorkspaceSourceFileSystem;

  public constructor(private readonly options: RsglWorkspaceSourceCacheOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeSourceFileSystem;
  }

  public setOpenTextDocumentProvider(provider: RsglOpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
    this.invalidateAll();
  }

  public invalidatePath(fileName: string): void {
    this.sourceFiles.delete(normalizeFileName(path.resolve(fileName)));
  }

  public invalidateAll(): void {
    this.sourceFiles.clear();
  }

  public loadProgramFromEntry(entryFileName: string): RsglSourceFile[] {
    const files: RsglSourceFile[] = [];
    const visited = new Set<string>();

    const visit = (fileName: string): void => {
      const normalizedFileName = normalizeSourceFileName(fileName);
      if (visited.has(normalizedFileName)) {
        return;
      }
      visited.add(normalizedFileName);

      const sourceFile = this.readSourceFile(normalizedFileName);
      if (!sourceFile) {
        return;
      }
      files.push(sourceFile);

      for (const source of collectRsglModuleSources(sourceFile.module)) {
        const resolved = resolveModuleSourceFileName(normalizedFileName, source);
        if (resolved) {
          visit(resolved);
        }
      }
    };

    visit(entryFileName);
    return files;
  }

  public loadProgramFromDirectory(rootDirectory: string): RsglSourceFile[] {
    const files: RsglSourceFile[] = [];
    const visited = new Set<string>();

    const visit = (fileName: string): void => {
      const normalizedFileName = normalizeSourceFileName(fileName);
      if (visited.has(normalizedFileName)) {
        return;
      }
      visited.add(normalizedFileName);

      const sourceFile = this.readSourceFile(normalizedFileName);
      if (!sourceFile) {
        return;
      }
      files.push(sourceFile);

      for (const source of collectRsglModuleSources(sourceFile.module)) {
        const resolved = resolveModuleSourceFileName(normalizedFileName, source);
        if (resolved) {
          visit(resolved);
        }
      }
    };

    for (const fileName of enumerateRsglFiles(rootDirectory)) {
      visit(fileName);
    }
    return files;
  }

  private readSourceFile(fileName: string): RsglSourceFile | null {
    const normalizedFileName = normalizeFileName(isVirtualSourceFileName(fileName) ? fileName : path.resolve(fileName));
    const cached = this.sourceFiles.get(normalizedFileName);
    const trustedVersionKey = this.currentTrustedVersionKey(normalizedFileName);
    if (cached && trustedVersionKey && cached.versionKey === trustedVersionKey) {
      return cached.sourceFile;
    }

    const readResult = this.readText(normalizedFileName);
    if (!readResult) {
      this.sourceFiles.delete(normalizedFileName);
      return null;
    }

    if (cached?.versionKey === readResult.versionKey) {
      return cached.sourceFile;
    }

    const sourceFile = {
      fileName: normalizedFileName,
      module: parseRsgl(readResult.text)
    };
    this.sourceFiles.set(normalizedFileName, { versionKey: readResult.versionKey, sourceFile });
    return sourceFile;
  }

  private readText(fileName: string): RsglSourceReadResult | null {
    const stdlibText = readRsglStdlibVirtualSource(fileName);
    if (stdlibText !== null) {
      return {
        text: stdlibText,
        versionKey: `rsgl-stdlib:${hashText(stdlibText)}`
      };
    }

    const openDocument = this.openTextDocumentProvider?.(fileName);
    if (openDocument) {
      const text = openDocument.getText();
      return {
        text,
        versionKey: openDocumentVersionKey(openDocument, text)
      };
    }

    try {
      const stat = this.fileSystem.statFile(fileName);
      if (!stat.isFile()) {
        return null;
      }
      const text = this.fileSystem.readTextFile(fileName, this.options.encoding ?? "utf8");
      return {
        text,
        versionKey: fsVersionKey(stat)
      };
    } catch {
      return null;
    }
  }

  private currentTrustedVersionKey(fileName: string): string | null {
    const openDocument = this.openTextDocumentProvider?.(fileName);
    if (openDocument && typeof openDocument.version === "number") {
      return `open:${openDocument.version}`;
    }

    if (openDocument) {
      return null;
    }

    try {
      const stat = this.fileSystem.statFile(fileName);
      return stat.isFile() ? fsVersionKey(stat) : null;
    } catch {
      return null;
    }
  }
}

export function collectRsglRelativeModuleSources(module: RsglModule): string[] {
  return collectRsglModuleSources(module).filter(source => source.startsWith("."));
}

function collectRsglModuleSources(module: RsglModule): string[] {
  return module.statements
    .filter((statement): statement is ImportDeclNode | ExportDeclNode => isImportDeclNode(statement) || isExportDeclNode(statement))
    .map(statement => statement.source?.value)
    .filter((source): source is string => Boolean(source && (source.startsWith(".") || isRsglStdlibImportSource(source))));
}

function resolveModuleSourceFileName(fromFileName: string, source: string): string | null {
  if (source.startsWith(".")) {
    return path.resolve(path.dirname(fromFileName), source);
  }
  if (isRsglStdlibImportSource(source)) {
    return rsglStdlibVirtualFileName(source);
  }
  return null;
}

function isVirtualSourceFileName(fileName: string): boolean {
  return readRsglStdlibVirtualSource(fileName) !== null;
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function normalizeSourceFileName(fileName: string): string {
  return normalizeFileName(isVirtualSourceFileName(fileName) ? fileName : path.resolve(fileName));
}

function enumerateRsglFiles(rootDirectory: string): string[] {
  const normalizedRoot = path.resolve(rootDirectory);
  const result: string[] = [];

  const visitDirectory = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    entries
      .sort((left, right) => left.name.localeCompare(right.name))
      .forEach(entry => {
        const fileName = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!ignoredDirectoryNames.has(entry.name)) {
            visitDirectory(fileName);
          }
        } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === ".rsgl") {
          result.push(normalizeFileName(fileName));
        }
      });
  };

  visitDirectory(normalizedRoot);
  return result;
}

const ignoredDirectoryNames = new Set([".git", ".vscode", "node_modules"]);

function isImportDeclNode(node: unknown): node is ImportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ImportDecl");
}

function isExportDeclNode(node: unknown): node is ExportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ExportDecl");
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash.toString(36);
}

function fsVersionKey(stat: RsglWorkspaceSourceFileStat): string {
  return `fs:${stat.mtimeMs}:${stat.size}`;
}

function openDocumentVersionKey(document: RsglTextDocumentLike, text: string): string {
  return typeof document.version === "number"
    ? `open:${document.version}`
    : `open:unknown:${hashText(text)}`;
}

const nodeSourceFileSystem: RsglWorkspaceSourceFileSystem = {
  statFile: fileName => fs.statSync(fileName),
  readTextFile: (fileName, encoding) => fs.readFileSync(fileName, encoding)
};
