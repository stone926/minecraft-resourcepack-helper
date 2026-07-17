import { resolveRsglCompileConfiguration } from "./compiler/compileConfiguration";
import {
  isRsglPathInsideOrEqual,
  resolveRsglPath,
  rsglPathKey
} from "./pathIdentity";
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

export interface RsglWorkspaceSemanticLoadOptions {
  semanticConfigurationFingerprint?: string;
}

interface RsglCachedSemanticProgram {
  signature: string;
  dependencyKeys: Set<string>;
  rootDirectoryKey?: string;
  result: RsglWorkspaceSemanticProgram;
}

const defaultSemanticConfigurationFingerprint = resolveRsglCompileConfiguration().semanticFingerprint;

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
    const normalizedFileName = resolveRsglPath(fileName);
    const key = rsglPathKey(normalizedFileName);
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

  public loadProgramFromEntry(
    entryFileName: string,
    options: RsglWorkspaceSemanticLoadOptions = {}
  ): RsglWorkspaceSemanticProgram {
    const normalizedEntryFileName = resolveRsglPath(entryFileName);
    const files = this.sourceCache.loadProgramFromEntry(normalizedEntryFileName);
    return this.loadProgram("entry", normalizedEntryFileName, files, {
      entryFileName: normalizedEntryFileName,
      semanticConfigurationFingerprint: options.semanticConfigurationFingerprint
        ?? defaultSemanticConfigurationFingerprint
    });
  }

  public loadProgramFromDirectory(
    rootDirectory: string,
    options: RsglWorkspaceSemanticLoadOptions = {}
  ): RsglWorkspaceSemanticProgram {
    const normalizedRootDirectory = resolveRsglPath(rootDirectory);
    const files = this.sourceCache.loadProgramFromDirectory(normalizedRootDirectory);
    return this.loadProgram("directory", normalizedRootDirectory, files, {
      rootDirectory: normalizedRootDirectory,
      rootDirectoryKey: rsglPathKey(normalizedRootDirectory),
      semanticConfigurationFingerprint: options.semanticConfigurationFingerprint
        ?? defaultSemanticConfigurationFingerprint
    });
  }

  private invalidatePrograms(): void {
    this.programs.clear();
  }

  private loadProgram(
    sourceKind: RsglWorkspaceSemanticProgram["sourceKind"],
    sourceName: string,
    files: RsglSourceFile[],
    options: {
      entryFileName?: string;
      rootDirectory?: string;
      rootDirectoryKey?: string;
      semanticConfigurationFingerprint: string;
    }
  ): RsglWorkspaceSemanticProgram {
    const programKey = `${sourceKind}:${rsglPathKey(sourceName)}`;
    const signature = this.createProgramSignature(files, options.semanticConfigurationFingerprint);
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
      program: bindRsglProgram(files, {
        semanticConfigurationFingerprint: options.semanticConfigurationFingerprint
      })
    };
    this.programs.set(programKey, {
      signature,
      dependencyKeys: new Set(files.map(file => rsglPathKey(file.fileName))),
      rootDirectoryKey: options.rootDirectoryKey,
      result
    });
    return result;
  }

  private createProgramSignature(
    files: RsglSourceFile[],
    semanticConfigurationFingerprint: string
  ): string {
    return [
      `config:${semanticConfigurationFingerprint.length}:${semanticConfigurationFingerprint}`,
      ...files.map(file => `${rsglPathKey(file.fileName)}@${this.sourceFileId(file)}`)
    ].join("|");
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

function isPathInsideOrEqual(fileName: string, directoryKey: string): boolean {
  return isRsglPathInsideOrEqual(fileName, directoryKey);
}
