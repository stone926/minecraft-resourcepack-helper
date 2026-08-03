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

export interface RsglWorkspaceSemanticCacheOptions extends RsglWorkspaceSourceCacheOptions {
  /** Number of recently closed entry programs retained for preview-tab reopen. */
  maximumRetainedClosedPaths?: number;
}

interface RsglCachedSemanticProgram {
  signature: string;
  dependencyKeys: Set<string>;
  rootDirectoryKey?: string;
  result: RsglWorkspaceSemanticProgram;
}

const defaultSemanticConfigurationFingerprint = resolveRsglCompileConfiguration().semanticFingerprint;
const defaultMaximumRetainedClosedPaths = 32;

export class RsglWorkspaceSemanticCache {
  private readonly sourceFileIds = new WeakMap<RsglSourceFile, number>();
  private readonly programs = new Map<string, RsglCachedSemanticProgram>();
  private readonly retainedClosedPaths = new Map<string, string>();
  private readonly maximumRetainedClosedPaths: number;
  private nextSourceFileId = 1;

  public constructor(
    private readonly sourceCache = new RsglWorkspaceSourceCache(),
    maximumRetainedClosedPaths = defaultMaximumRetainedClosedPaths
  ) {
    this.maximumRetainedClosedPaths = normalizeRetainedClosedPathLimit(maximumRetainedClosedPaths);
  }

  public static create(options: RsglWorkspaceSemanticCacheOptions = {}): RsglWorkspaceSemanticCache {
    return new RsglWorkspaceSemanticCache(
      new RsglWorkspaceSourceCache(options),
      normalizeRetainedClosedPathLimit(options.maximumRetainedClosedPaths)
    );
  }

  public setOpenTextDocumentProvider(provider: RsglOpenTextDocumentProvider | null): void {
    this.sourceCache.setOpenTextDocumentProvider(provider);
    this.retainedClosedPaths.clear();
    this.invalidatePrograms();
  }

  public invalidatePath(fileName: string): void {
    const normalizedFileName = resolveRsglPath(fileName);
    this.retainedClosedPaths.delete(rsglPathKey(normalizedFileName));
    this.sourceCache.invalidatePath(normalizedFileName);
    this.invalidateProgramsForPath(normalizedFileName);
  }

  /**
   * Updates the effective open/disk source without evicting semantic work when
   * a document lifecycle transition leaves its content unchanged.
   */
  public synchronizePath(fileName: string): boolean {
    const normalizedFileName = resolveRsglPath(fileName);
    this.retainedClosedPaths.delete(rsglPathKey(normalizedFileName));
    return this.synchronizeEffectivePath(normalizedFileName);
  }

  /** Retains one unchanged closed entry in a bounded preview-reopen window. */
  public closePath(fileName: string): boolean {
    const normalizedFileName = resolveRsglPath(fileName);
    const changed = this.synchronizeEffectivePath(normalizedFileName);
    const entryProgramKey = semanticProgramKey("entry", normalizedFileName);
    if (!changed && this.programs.has(entryProgramKey)) {
      this.retainClosedPath(normalizedFileName);
    } else {
      this.retainedClosedPaths.delete(rsglPathKey(normalizedFileName));
      this.evictEntryPath(normalizedFileName);
    }
    return changed;
  }

  private synchronizeEffectivePath(normalizedFileName: string): boolean {
    const changed = this.sourceCache.synchronizePath(normalizedFileName);
    if (changed) {
      this.invalidateProgramsForPath(normalizedFileName);
    }
    return changed;
  }

  private retainClosedPath(normalizedFileName: string): void {
    const key = rsglPathKey(normalizedFileName);
    this.retainedClosedPaths.delete(key);
    this.retainedClosedPaths.set(key, normalizedFileName);
    while (this.retainedClosedPaths.size > this.maximumRetainedClosedPaths) {
      const oldest = this.retainedClosedPaths.entries().next().value as [string, string] | undefined;
      if (!oldest) {
        return;
      }
      this.retainedClosedPaths.delete(oldest[0]);
      this.evictEntryPath(oldest[1]);
    }
  }

  private evictEntryPath(normalizedFileName: string): void {
    const key = rsglPathKey(normalizedFileName);
    this.programs.delete(semanticProgramKey("entry", normalizedFileName));
    if (![...this.programs.values()].some(program => program.dependencyKeys.has(key))) {
      this.sourceCache.evictPath(normalizedFileName);
    }
  }

  private invalidateProgramsForPath(normalizedFileName: string): void {
    const key = rsglPathKey(normalizedFileName);
    for (const [programKey, cached] of this.programs) {
      if (
        cached.dependencyKeys.has(key) ||
        (cached.rootDirectoryKey && isPathInsideOrEqual(normalizedFileName, cached.rootDirectoryKey))
      ) {
        this.programs.delete(programKey);
        if (cached.result.sourceKind === "entry") {
          this.retainedClosedPaths.delete(rsglPathKey(cached.result.sourceName));
        }
      }
    }
  }

  public invalidateAll(): void {
    this.sourceCache.invalidateAll();
    this.retainedClosedPaths.clear();
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
    const programKey = semanticProgramKey(sourceKind, sourceName);
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

function normalizeRetainedClosedPathLimit(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : defaultMaximumRetainedClosedPaths;
}

function semanticProgramKey(
  sourceKind: RsglWorkspaceSemanticProgram["sourceKind"],
  sourceName: string
): string {
  return `${sourceKind}:${rsglPathKey(sourceName)}`;
}
