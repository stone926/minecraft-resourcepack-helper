import type { TextRange } from "../parser";
import { rsglPathKey } from "../pathIdentity";
import type { CompileDependency } from "./base/types";
import type {
  ResourceUnit,
  RsglCompileDiagnostic,
  RsglCompileResult,
  RsglMapping,
  RsglSourceMap,
  RsglValidationReferenceOrigin
} from "./ir";
import type { RsglCompileContext } from "./templateExpansion";

export interface CompilerOutputAccumulatorOptions {
  readonly fileName: string;
  readonly onDependency?: (dependency: CompileDependency) => void;
}

/**
 * Owns the mutable output of one compiler run. Keeping diagnostics,
 * dependencies, units, and source maps behind one collaborator makes their
 * ordering and de-duplication rules explicit and independent of lowering.
 */
export class CompilerOutputAccumulator {
  public readonly units: ResourceUnit[] = [];
  public readonly diagnostics: RsglCompileDiagnostic[] = [];
  public readonly dependencies: CompileDependency[] = [];

  private readonly dependencyKeys = new Set<string>();

  public constructor(private readonly options: CompilerOutputAccumulatorOptions) {}

  public result(): RsglCompileResult {
    return {
      units: this.units,
      diagnostics: this.diagnostics,
      dependencies: this.dependencies
    };
  }

  public pushUnit(unit: ResourceUnit | null): void {
    if (unit) {
      this.units.push(unit);
    }
  }

  public addDiagnostic(diagnostic: RsglCompileDiagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  public error(code: string, message: string, range: TextRange, fileName?: string): void {
    this.diagnostics.push({
      code,
      message,
      range,
      severity: "error",
      ...(fileName ? { fileName } : {})
    });
  }

  public warning(code: string, message: string, range: TextRange, fileName?: string): void {
    this.diagnostics.push({
      code,
      message,
      range,
      severity: "warning",
      ...(fileName ? { fileName } : {})
    });
  }

  public recordDependency(dependency: CompileDependency): void {
    const key = compileDependencyKey(dependency);
    if (this.dependencyKeys.has(key)) {
      return;
    }
    this.dependencyKeys.add(key);
    this.dependencies.push(dependency);
    this.options.onDependency?.(dependency);
  }

  public sourceMap(
    outputPath: string,
    node: { range: TextRange },
    context: RsglCompileContext,
    mappings: RsglMapping[] = []
  ): RsglSourceMap {
    return {
      generatedFile: outputPath,
      mappings: [
        this.sourceMapping("", node.range, context),
        ...mappings
      ]
    };
  }

  public sourceMapping(
    generatedPath: string,
    sourceRange: TextRange,
    context: Pick<RsglCompileContext, "sourceFile" | "mappingReason" | "expansionStack">
  ): RsglMapping {
    return {
      generatedPath,
      sourceFile: context.sourceFile ?? this.options.fileName,
      sourceRange,
      reason: context.mappingReason ?? "direct",
      expansionStack: context.expansionStack ?? []
    };
  }

  /**
   * Validation origins are compiler-only mapping metadata. Move them to the
   * validation payload before a unit becomes observable to callers.
   */
  public detachValidationOrigins(unit: ResourceUnit): RsglValidationReferenceOrigin[] {
    const origins: RsglValidationReferenceOrigin[] = [];
    const mappings = unit.sourceMap.mappings.flatMap(mapping => {
      if (!mapping.validationOrigin) {
        return mapping.validationOnly ? [] : [mapping];
      }
      const { validationOrigin, validationOnly, ...publicMapping } = mapping;
      // The mapping path is authoritative after sugar/backend transforms;
      // validationOrigin may still describe the pre-transform value path.
      origins.push({ ...validationOrigin, generatedPath: mapping.generatedPath });
      return validationOnly ? [] : [publicMapping];
    });
    if (origins.length > 0) {
      unit.sourceMap = { ...unit.sourceMap, mappings };
    }
    return origins;
  }
}

function compileDependencyKey(dependency: CompileDependency): string {
  const normalizedPath = rsglPathKey(dependency.path);
  const normalizedSource = rsglPathKey(dependency.sourceFile);
  return [
    normalizedPath,
    dependency.reason,
    dependency.globPattern ?? "",
    normalizedSource,
    dependency.sourceRange.start,
    dependency.sourceRange.end
  ].join("\0");
}
