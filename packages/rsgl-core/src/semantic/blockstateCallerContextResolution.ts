import { fileDiagnostic } from "./diagnostics";
import { applyLegacyBlockstateMode, resolveLegacyBlockstateMode } from "./blockstateModeInference";
import type { RsglFileDiagnostic, RsglSemanticModel } from "./types";

/** Finalizes wrapper-less legacy declaration modes after imports/re-exports link. */
export function resolveLinkedLegacyBlockstateCallerContexts(
  models: readonly RsglSemanticModel[]
): RsglFileDiagnostic[] {
  const diagnostics: RsglFileDiagnostic[] = [];
  for (const model of models) {
    for (const record of model.legacyBlockstateRoots ?? []) {
      const selection = resolveLegacyBlockstateMode(record, model.scope);
      applyLegacyBlockstateMode(record, selection);
      if (!selection.conflict || model.diagnostics.some(diagnostic =>
        diagnostic.code === "rsgl.blockstateModeConflict"
        && diagnostic.range.start === record.range.start
        && diagnostic.range.end === record.range.end
      )) {
        continue;
      }
      diagnostics.push(fileDiagnostic(
        model.fileName,
        "rsgl.blockstateModeConflict",
        "A legacy blockstate body contains both variants and multipart evidence after imports were resolved; select one mode in the declaration header.",
        record.range
      ));
    }
  }
  return diagnostics;
}
