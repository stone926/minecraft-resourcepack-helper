import {
  compileRsglResourceAnalysis,
  type CompileDependency,
  type RsglProgramCompileOptions,
  type RsglResourceAnalysisResult,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";

export interface RsglResourceAnalysisConfiguration {
  /** Stable identity of every compile and physical-resolution input. */
  cacheKey: string;
  options: Omit<RsglProgramCompileOptions, "semanticProgram">;
  /** Context layers that this filesystem-backed LSP cannot authoritatively inspect. */
  unavailableResolutionScopes?: readonly ("local" | "custom" | "vanilla")[];
}

export interface RsglResourceAnalysisEntry {
  /** Stable only for this cache entry's lifetime; changes after recompilation. */
  cacheIdentity: number;
  semanticProgram: RsglWorkspaceSemanticProgram;
  configurationKey: string;
  analysis: RsglResourceAnalysisResult;
  dependencies: readonly CompileDependency[];
  unavailableResolutionScopes: readonly ("local" | "custom" | "vanilla")[];
}

export interface RsglResourceAnalysisCacheOptions {
  compile?: (
    semanticProgram: RsglWorkspaceSemanticProgram,
    options: RsglProgramCompileOptions
  ) => RsglResourceAnalysisResult;
}

/**
 * One compiler analysis per semantic-program/configuration identity. Navigation,
 * references, and resource snapshots retain the complete result instead of
 * compiling independent projections.
 */
export class RsglResourceAnalysisCache {
  private entries = new WeakMap<
    RsglWorkspaceSemanticProgram,
    Map<string, RsglResourceAnalysisEntry>
  >();
  private readonly compile: NonNullable<RsglResourceAnalysisCacheOptions["compile"]>;
  private nextEntryIdentity = 1;

  public constructor(options: RsglResourceAnalysisCacheOptions = {}) {
    this.compile = options.compile ?? ((semanticProgram, compileOptions) =>
      compileRsglResourceAnalysis(semanticProgram.files, compileOptions));
  }

  public getOrCreate(
    semanticProgram: RsglWorkspaceSemanticProgram,
    configuration: RsglResourceAnalysisConfiguration
  ): RsglResourceAnalysisEntry {
    let byConfiguration = this.entries.get(semanticProgram);
    if (!byConfiguration) {
      byConfiguration = new Map();
      this.entries.set(semanticProgram, byConfiguration);
    }
    const cached = byConfiguration.get(configuration.cacheKey);
    if (cached) {
      return cached;
    }

    const analysis = this.compile(semanticProgram, {
      ...configuration.options,
      semanticProgram: semanticProgram.program
    });
    const entry: RsglResourceAnalysisEntry = {
      cacheIdentity: this.nextEntryIdentity++,
      semanticProgram,
      configurationKey: configuration.cacheKey,
      analysis,
      dependencies: analysis.compileResult.dependencies,
      unavailableResolutionScopes: configuration.unavailableResolutionScopes ?? []
    };
    byConfiguration.set(configuration.cacheKey, entry);
    return entry;
  }

  public invalidateAll(): void {
    this.entries = new WeakMap();
  }
}
