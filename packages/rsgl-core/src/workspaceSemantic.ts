import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  bindRsglProgram,
  RsglProgram,
  RsglSourceFile
} from "./semantic";
import {
  RsglOpenTextDocumentProvider,
  RsglWorkspaceSourceCache,
  RsglWorkspaceSourceCacheOptions
} from "./workspaceSource";

export interface RsglWorkspaceSemanticProgram {
  sourceKind: "entry" | "directory";
  sourceName: string;
  entryFileName?: string;
  rootDirectory?: string;
  files: RsglSourceFile[];
  program: RsglProgram;
}

interface RsglCachedSemanticProgram {
  signature: string;
  dependencyKeys: Set<string>;
  rootDirectoryKey?: string;
  result: RsglWorkspaceSemanticProgram;
}

export class RsglWorkspaceSemanticCache {
  private readonly sourceFileIds = new WeakMap<RsglSourceFile, number>();
  private readonly programs = new Map<string, RsglCachedSemanticProgram>();
  private nextSourceFileId = 1;

  public constructor(private readonly sourceCache = new RsglWorkspaceSourceCache()) { }

  public static create(options: RsglWorkspaceSourceCacheOptions = {}): RsglWorkspaceSemanticCache {
    return new RsglWorkspaceSemanticCache(new RsglWorkspaceSourceCache(options));
  }

  public setOpenTextDocumentProvider(provider: RsglOpenTextDocumentProvider | null): void {
    this.sourceCache.setOpenTextDocumentProvider(provider);
    this.invalidatePrograms();
  }

  public invalidatePath(fileName: string): void {
    const normalizedFileName = normalizeFileName(path.resolve(fileName));
    const key = normalizePathKey(normalizedFileName);
    this.sourceCache.invalidatePath(normalizedFileName);

    for (const [programKey, cached] of this.programs) {
      if (
        cached.dependencyKeys.has(key) ||
        (cached.rootDirectoryKey && isPathInsideOrEqual(normalizedFileName, cached.rootDirectoryKey))
      ) {
        this.programs.delete(programKey);
      }
    }
  }

  public invalidateAll(): void {
    this.sourceCache.invalidateAll();
    this.invalidatePrograms();
  }

  public loadProgramFromEntry(entryFileName: string): RsglWorkspaceSemanticProgram {
    const normalizedEntryFileName = normalizeFileName(path.resolve(entryFileName));
    const files = this.sourceCache.loadProgramFromEntry(normalizedEntryFileName);
    return this.loadProgram("entry", normalizedEntryFileName, files, {
      entryFileName: normalizedEntryFileName
    });
  }

  public loadProgramFromDirectory(rootDirectory: string): RsglWorkspaceSemanticProgram {
    const normalizedRootDirectory = normalizeFileName(path.resolve(rootDirectory));
    const files = this.sourceCache.loadProgramFromDirectory(normalizedRootDirectory);
    return this.loadProgram("directory", normalizedRootDirectory, files, {
      rootDirectory: normalizedRootDirectory,
      rootDirectoryKey: normalizePathKey(normalizedRootDirectory)
    });
  }

  private invalidatePrograms(): void {
    this.programs.clear();
  }

  private loadProgram(
    sourceKind: RsglWorkspaceSemanticProgram["sourceKind"],
    sourceName: string,
    files: RsglSourceFile[],
    options: { entryFileName?: string; rootDirectory?: string; rootDirectoryKey?: string }
  ): RsglWorkspaceSemanticProgram {
    const programKey = `${sourceKind}:${normalizePathKey(sourceName)}`;
    const signature = this.createProgramSignature(files);
    const cached = this.programs.get(programKey);
    if (cached?.signature === signature) {
      return cached.result;
    }

    const result = {
      sourceKind,
      sourceName,
      entryFileName: options.entryFileName,
      rootDirectory: options.rootDirectory,
      files,
      program: bindRsglProgram(files)
    };
    this.programs.set(programKey, {
      signature,
      dependencyKeys: new Set(files.map(file => normalizePathKey(file.fileName))),
      rootDirectoryKey: options.rootDirectoryKey,
      result
    });
    return result;
  }

  private createProgramSignature(files: RsglSourceFile[]): string {
    return files
      .map(file => `${normalizePathKey(file.fileName)}@${this.sourceFileId(file)}`)
      .join("|");
  }

  private sourceFileId(file: RsglSourceFile): number {
    const existing = this.sourceFileIds.get(file);
    if (existing !== undefined) {
      return existing;
    }
    const id = this.nextSourceFileId++;
    this.sourceFileIds.set(file, id);
    return id;
  }
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function isPathInsideOrEqual(fileName: string, directoryKey: string): boolean {
  const relative = path.relative(directoryKey, normalizePathKey(fileName));
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}
