import {
  createRsglWritePlan,
  compileRsglFile,
  emitRsglFiles,
  type RsglEmittedFile,
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
  const compiled = compileRsglBuildFiles(entryFileName, options);
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics
    };
  }

  return {
    diagnostics: compiled.diagnostics,
    plan: writeRsglFiles(compiled.files, options.outputRoot, options)
  };
}

export interface RsglBuildPreviewResult extends RsglBuildResult {
  preview?: string;
}

export interface RsglBuildPreviewFormatOptions {
  entryFileName?: string;
}

export function previewRsglResourcePackBuild(entryFileName: string, options: RsglBuildOptions): RsglBuildPreviewResult {
  const compiled = compileRsglBuildFiles(entryFileName, options);
  if (!compiled.files) {
    return {
      diagnostics: compiled.diagnostics
    };
  }

  const plan = createRsglWritePlan(compiled.files, options.outputRoot, {
    ...options,
    includePreviousContent: true
  });
  return {
    diagnostics: compiled.diagnostics,
    plan,
    preview: formatRsglBuildPreview(plan, { entryFileName })
  };
}

export function formatRsglBuildPreview(
  plan: RsglWritePlan,
  options: RsglBuildPreviewFormatOptions = {}
): string {
  const lines = [
    "# RSGL Build Preview",
    "",
    ...(options.entryFileName ? [`Entry: ${options.entryFileName}`] : []),
    `Output root: ${plan.outputRoot}`,
    `Summary: ${plan.summary.create} create, ${plan.summary.update} update, ${plan.summary.unchanged} unchanged`,
    "",
    "## Planned Changes",
    ""
  ];
  const changedEntries = plan.entries.filter(entry => entry.status !== "unchanged");
  if (changedEntries.length === 0) {
    lines.push("No file changes.");
  } else {
    for (const entry of changedEntries) {
      const diff = entry.diff ? ` (+${entry.diff.addedLines} -${entry.diff.removedLines})` : "";
      lines.push(`- ${entry.status}: ${entry.outputPath}${diff}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function compileRsglBuildFiles(
  entryFileName: string,
  options: RsglBuildOptions
): { diagnostics: RsglCompileDiagnostic[]; files?: RsglEmittedFile[] } {
  const result = compileRsglFile(entryFileName, options);
  const blockingDiagnostics = result.diagnostics.filter(diagnostic => diagnostic.severity === "error");
  if (blockingDiagnostics.length > 0) {
    return {
      diagnostics: result.diagnostics
    };
  }

  return {
    diagnostics: result.diagnostics,
    files: emitRsglFiles(result.units, {
      ...options,
      sourceMaps: options.sourceMaps ?? true,
      manifest: options.manifest ?? true
    })
  };
}
