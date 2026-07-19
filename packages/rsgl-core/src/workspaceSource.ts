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
import {
  normalizeRsglPath,
  resolveRsglPath,
  rsglPathKey
} from "./pathIdentity";

export interface RsglTextDocumentLike {
  fileName: string;
  version?: number;
  getText(): string;
}

export interface RsglWorkspaceSourceCacheOptions {
  encoding?: BufferEncoding;
  fileSystem?: RsglWorkspaceSourceFileSystem;
  /**
   * Trusts callers to invalidate disk paths from a covering file watcher.
   * Cached disk sources then require no stat/read on a hot hit.
   */
  watcherTrusted?: boolean;
  /** Verification interval for disk paths not covered by a trusted watcher. */
  verificationTtlMs?: number;
  /** Injectable monotonic-ish clock used by verification-cache tests. */
  clock?: () => number;
  /** Injectable directory enumerator used by cache and performance tests. */
  enumerateRsglFiles?: (rootDirectory: string) => readonly string[];
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
  kind: "disk" | "open" | "virtual";
  versionKey: string;
  sourceFile: RsglSourceFile;
  verifiedAtMs?: number;
}

interface RsglSourceReadResult {
  text: string;
  versionKey: string;
}

interface RsglCachedDirectoryListing {
  fileNames: readonly string[];
  verifiedAtMs: number;
}

export class RsglWorkspaceSourceCache {
  private readonly sourceFiles = new Map<string, RsglCachedSourceFile>();
  private readonly directoryListings = new Map<string, RsglCachedDirectoryListing>();
  private openTextDocumentProvider: RsglOpenTextDocumentProvider | null = null;
  private readonly fileSystem: RsglWorkspaceSourceFileSystem;
  private readonly verificationTtlMs: number;
  private readonly clock: () => number;
  private readonly enumerateDirectoryFiles: (rootDirectory: string) => readonly string[];

  public constructor(private readonly options: RsglWorkspaceSourceCacheOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeSourceFileSystem;
    this.verificationTtlMs = normalizedVerificationTtl(options.verificationTtlMs);
    this.clock = options.clock ?? Date.now;
    this.enumerateDirectoryFiles = options.enumerateRsglFiles ?? enumerateRsglFiles;
  }

  public setOpenTextDocumentProvider(provider: RsglOpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
    this.invalidateAll();
  }

  public invalidatePath(fileName: string): void {
    this.sourceFiles.delete(rsglPathKey(resolveRsglPath(fileName)));
    this.directoryListings.clear();
  }

  public invalidateAll(): void {
    this.sourceFiles.clear();
    this.directoryListings.clear();
  }

  public loadProgramFromEntry(entryFileName: string): RsglSourceFile[] {
    const files: RsglSourceFile[] = [];
    const visited = new Set<string>();

    const visit = (fileName: string): void => {
      const normalizedFileName = normalizeSourceFileName(fileName);
      const fileKey = rsglPathKey(normalizedFileName);
      if (visited.has(fileKey)) {
        return;
      }
      visited.add(fileKey);

      const sourceFile = this.readSourceFile(normalizedFileName);
      if (!sourceFile) {
        return;
      }
      files.push(sourceFile);

      for (const source of collectRsglModuleSources(sourceFile.module)) {
        const resolved = resolveModuleSourceFileName(sourceFile.fileName, source);
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
      const fileKey = rsglPathKey(normalizedFileName);
      if (visited.has(fileKey)) {
        return;
      }
      visited.add(fileKey);

      const sourceFile = this.readSourceFile(normalizedFileName);
      if (!sourceFile) {
        return;
      }
      files.push(sourceFile);

      for (const source of collectRsglModuleSources(sourceFile.module)) {
        const resolved = resolveModuleSourceFileName(sourceFile.fileName, source);
        if (resolved) {
          visit(resolved);
        }
      }
    };

    for (const fileName of this.rsglFilesInDirectory(rootDirectory)) {
      visit(fileName);
    }
    return files;
  }

  private rsglFilesInDirectory(rootDirectory: string): readonly string[] {
    const normalizedRoot = resolveRsglPath(rootDirectory);
    const rootKey = rsglPathKey(normalizedRoot);
    const cached = this.directoryListings.get(rootKey);
    const now = this.clock();
    if (
      cached
      && (this.options.watcherTrusted
        || (now >= cached.verifiedAtMs
          && now - cached.verifiedAtMs < this.verificationTtlMs))
    ) {
      return cached.fileNames;
    }
    const fileNames = [...this.enumerateDirectoryFiles(normalizedRoot)];
    this.directoryListings.set(rootKey, { fileNames, verifiedAtMs: now });
    return fileNames;
  }

  private readSourceFile(fileName: string): RsglSourceFile | null {
    const normalizedFileName = normalizeSourceFileName(fileName);
    const fileKey = rsglPathKey(normalizedFileName);
    const cached = this.sourceFiles.get(fileKey);
    const canonicalFileName = cached?.sourceFile.fileName ?? normalizedFileName;

    if (cached?.kind === "virtual") {
      return cached.sourceFile;
    }

    const virtualText = readRsglStdlibVirtualSource(canonicalFileName);
    if (virtualText !== null) {
      return this.cacheReadResult(fileKey, canonicalFileName, cached, {
        text: virtualText,
        versionKey: `rsgl-stdlib:${hashText(virtualText)}`
      }, "virtual");
    }

    const openDocument = this.openTextDocumentProvider?.(canonicalFileName);
    if (openDocument) {
      const trustedVersionKey = typeof openDocument.version === "number"
        ? `open:${openDocument.version}`
        : null;
      if (
        cached?.kind === "open"
        && trustedVersionKey
        && cached.versionKey === trustedVersionKey
      ) {
        return cached.sourceFile;
      }
      const text = openDocument.getText();
      return this.cacheReadResult(fileKey, canonicalFileName, cached, {
        text,
        versionKey: openDocumentVersionKey(openDocument, text)
      }, "open");
    }

    return this.readDiskSource(fileKey, canonicalFileName, cached);
  }

  private readDiskSource(
    fileKey: string,
    fileName: string,
    cached: RsglCachedSourceFile | undefined
  ): RsglSourceFile | null {
    if (cached?.kind === "disk" && this.options.watcherTrusted) {
      return cached.sourceFile;
    }

    const now = this.clock();
    if (
      cached?.kind === "disk"
      && cached.verifiedAtMs !== undefined
      && now >= cached.verifiedAtMs
      && now - cached.verifiedAtMs < this.verificationTtlMs
    ) {
      return cached.sourceFile;
    }

    try {
      const stat = this.fileSystem.statFile(fileName);
      if (!stat.isFile()) {
        this.sourceFiles.delete(fileKey);
        return null;
      }
      const versionKey = fsVersionKey(stat);
      if (cached?.kind === "disk" && cached.versionKey === versionKey) {
        cached.verifiedAtMs = now;
        return cached.sourceFile;
      }
      const text = this.fileSystem.readTextFile(fileName, this.options.encoding ?? "utf8");
      return this.cacheReadResult(fileKey, fileName, cached, {
        text,
        versionKey
      }, "disk", now);
    } catch {
      this.sourceFiles.delete(fileKey);
      return null;
    }
  }

  private cacheReadResult(
    fileKey: string,
    fileName: string,
    cached: RsglCachedSourceFile | undefined,
    readResult: RsglSourceReadResult,
    kind: RsglCachedSourceFile["kind"],
    verifiedAtMs?: number
  ): RsglSourceFile {
    if (cached?.kind === kind && cached.versionKey === readResult.versionKey) {
      cached.verifiedAtMs = verifiedAtMs;
      return cached.sourceFile;
    }

    const sourceFile = {
      fileName,
      module: parseRsgl(readResult.text)
    };
    this.sourceFiles.set(fileKey, {
      kind,
      versionKey: readResult.versionKey,
      sourceFile,
      ...(verifiedAtMs === undefined ? {} : { verifiedAtMs })
    });
    return sourceFile;
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

function normalizeSourceFileName(fileName: string): string {
  return isVirtualSourceFileName(fileName) ? normalizeRsglPath(fileName) : resolveRsglPath(fileName);
}

function enumerateRsglFiles(rootDirectory: string): string[] {
  const normalizedRoot = resolveRsglPath(rootDirectory);
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
          result.push(normalizeRsglPath(fileName));
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

const DEFAULT_VERIFICATION_TTL_MS = 1_000;

function normalizedVerificationTtl(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : DEFAULT_VERIFICATION_TTL_MS;
}

const nodeSourceFileSystem: RsglWorkspaceSourceFileSystem = {
  statFile: fileName => fs.statSync(fileName),
  readTextFile: (fileName, encoding) => fs.readFileSync(fileName, encoding)
};
