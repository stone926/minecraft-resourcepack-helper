import * as path from "node:path";
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
  entryFileName: string;
  files: RsglSourceFile[];
  program: RsglProgram;
}

interface RsglCachedSemanticProgram {
  signature: string;
  dependencyKeys: Set<string>;
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
    const key = fileNameKey(normalizedFileName);
    this.sourceCache.invalidatePath(normalizedFileName);

    for (const [entryKey, cached] of this.programs) {
      if (entryKey === key || cached.dependencyKeys.has(key)) {
        this.programs.delete(entryKey);
      }
    }
  }

  public invalidateAll(): void {
    this.sourceCache.invalidateAll();
    this.invalidatePrograms();
  }

  public loadProgramFromEntry(entryFileName: string): RsglWorkspaceSemanticProgram {
    const normalizedEntryFileName = normalizeFileName(path.resolve(entryFileName));
    const entryKey = fileNameKey(normalizedEntryFileName);
    const files = this.sourceCache.loadProgramFromEntry(normalizedEntryFileName);
    const signature = this.createProgramSignature(files);
    const cached = this.programs.get(entryKey);
    if (cached?.signature === signature) {
      return cached.result;
    }

    const result = {
      entryFileName: normalizedEntryFileName,
      files,
      program: bindRsglProgram(files)
    };
    this.programs.set(entryKey, {
      signature,
      dependencyKeys: new Set(files.map(file => fileNameKey(file.fileName))),
      result
    });
    return result;
  }

  private invalidatePrograms(): void {
    this.programs.clear();
  }

  private createProgramSignature(files: RsglSourceFile[]): string {
    return files
      .map(file => `${fileNameKey(file.fileName)}@${this.sourceFileId(file)}`)
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

function fileNameKey(fileName: string): string {
  const normalized = normalizeFileName(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
