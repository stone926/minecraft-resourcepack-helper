import {
  compileRsglFile,
  emitRsglFiles,
  type RsglCompileDiagnostic,
  type RsglEmitOptions,
  writeRsglFiles,
  type RsglWritePlan,
  type RsglWritePlanOptions
} from "./compiler";
import type { RsglResourceValidationOptions } from "./compiler";

export interface RsglBuildOptions extends RsglResourceValidationOptions, RsglEmitOptions, RsglWritePlanOptions {
  outputRoot: string;
}

export interface RsglBuildResult {
  plan?: RsglWritePlan;
  diagnostics: RsglCompileDiagnostic[];
}

export function buildRsglResourcePack(entryFileName: string, options: RsglBuildOptions): RsglBuildResult {
  const result = compileRsglFile(entryFileName, options);
  const blockingDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (blockingDiagnostics.length > 0) {
    return {
      diagnostics: result.diagnostics
    };
  }

  return {
    diagnostics: result.diagnostics,
    plan: writeRsglFiles(emitRsglFiles(result.units, {
      ...options,
      sourceMaps: options.sourceMaps ?? true,
      manifest: options.manifest ?? true
    }), options.outputRoot, options)
  };
}
