import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  DiagnosticSeverity,
  type Diagnostic
} from "vscode-languageserver/node";
import {
  compileRsglModule,
  compileRsglProgram,
  getRsglProjectConfigWatchPaths,
  parseRsgl,
  resolveRsglCompileConfiguration,
  RsglProjectConfigError,
  type CompileDependency,
  type RsglCompileConfigurationOptions,
  type RsglDiagnostic,
  type RsglResourceValidationOptions,
  type RsglWorkspaceSemanticProgram,
  type RsglWorkspaceValidationCache
} from "../../rsgl-core/src";
import {
  workspaceValidationOptionsFor,
  type RsglValidationSettings
} from "./serverCoreSettings";
import {
  clampOffset,
  type RsglLspDocument
} from "./serverCoreDocuments";

/** Injected collaborators for the document validation pipeline. */
export interface RsglDocumentValidationDeps {
  loadProgramFromEntry(
    fileName: string,
    semanticConfigurationFingerprint?: string
  ): RsglWorkspaceSemanticProgram;
  onDependencies?: (dependencies: readonly CompileDependency[]) => void;
  onProjectConfigWatchPaths?: (paths: readonly string[]) => void;
  validationCache?: RsglWorkspaceValidationCache;
  settings: RsglValidationSettings;
}

/** Compiles the document program and returns diagnostics scoped to its file. */
export function computeDocumentDiagnostics(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentValidationDeps
): Diagnostic[] {
  const currentFileKey = normalizePathKey(path.resolve(fileName));
  deps.onProjectConfigWatchPaths?.(getRsglProjectConfigWatchPaths(fileName, "file"));
  let validationOptions: RsglResourceValidationOptions & RsglCompileConfigurationOptions;
  try {
    validationOptions = workspaceValidationOptionsFor(fileName, deps.settings, deps.validationCache);
  } catch (error) {
    return [toLspDiagnostic(document, {
      code: projectConfigurationDiagnosticCode(error),
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      range: { start: 0, end: 1 }
    })];
  }
  const semanticConfigurationFingerprint = resolveRsglCompileConfiguration(
    validationOptions
  ).semanticFingerprint;
  const semanticProgram = deps.loadProgramFromEntry(fileName, semanticConfigurationFingerprint);
  if (semanticProgram.files.length > 0) {
    const result = compileRsglProgram(semanticProgram.files, {
      entryFileName: fileName,
      semanticProgram: semanticProgram.program,
      ...validationOptions
    });
    deps.onDependencies?.(result.dependencies);
    return result.diagnostics
      .filter(diagnostic =>
        !diagnostic.fileName
        || normalizePathKey(path.resolve(diagnostic.fileName)) === currentFileKey
      )
      .map(diagnostic => toLspDiagnostic(document, diagnostic));
  }

  const parsed = parseRsgl(document.getText());
  const result = compileRsglModule(parsed, {
    fileName,
    ...validationOptions
  });
  deps.onDependencies?.(result.dependencies);
  return result.diagnostics.map(diagnostic => toLspDiagnostic(document, diagnostic));
}

function projectConfigurationDiagnosticCode(error: unknown): string {
  const topLevelProperty = error instanceof RsglProjectConfigError
    ? topLevelConfigProperty(error.relativeFieldPath)
    : undefined;
  if (
    topLevelProperty === "namespace"
    || topLevelProperty === "target"
    || topLevelProperty === "maxEvaluationItems"
    || topLevelProperty === "maxItemModelDepth"
  ) {
    return "rsgl.invalidProjectConfiguration";
  }
  return "rsgl.invalidExternConfiguration";
}

function topLevelConfigProperty(fieldPath: string | undefined): string | undefined {
  if (!fieldPath) {
    return undefined;
  }
  const separators = [fieldPath.indexOf("."), fieldPath.indexOf("[")]
    .filter(index => index >= 0);
  const end = separators.length > 0 ? Math.min(...separators) : fieldPath.length;
  return fieldPath.slice(0, end);
}

/** Converts an RSGL diagnostic to an LSP diagnostic, clamping document offsets. */
export function toLspDiagnostic(
  document: RsglLspDocument,
  diagnostic: RsglDiagnostic
): Diagnostic {
  const start = clampOffset(document, diagnostic.range.start);
  const end = Math.max(start + 1, clampOffset(document, diagnostic.range.end));
  return {
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end)
    },
    severity: toLspSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: "RSGL",
    message: diagnostic.message
  };
}

/** Maps an RSGL severity onto the LSP diagnostic severity scale. */
export function toLspSeverity(severity: RsglDiagnostic["severity"]): DiagnosticSeverity {
  if (severity === "warning") {
    return DiagnosticSeverity.Warning;
  }
  if (severity === "info") {
    return DiagnosticSeverity.Information;
  }
  return DiagnosticSeverity.Error;
}
