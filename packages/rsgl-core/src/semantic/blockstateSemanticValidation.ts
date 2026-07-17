import type { ExprNode, RsglDiagnostic } from "../parser";
import { checkBlockstateModelSpec } from "./blockstateModelSpecChecker";
import { checkBlockstateSelector } from "./blockstateSelectorChecker";
import { fileDiagnostic } from "./diagnostics";
import { checkBlockstatePredicate } from "./expressionChecker";
import { scopeWithLinkedGlobalFallback } from "./linkedScope";
import type {
  RsglFileDiagnostic,
  RsglSemanticModel,
  RsglType
} from "./types";

const provisionalModelSpecDiagnosticCodes = new Set([
  "rsgl.invalidBlockstateModelOption",
  "rsgl.invalidBlockstateModelOptionsSpread",
  "rsgl.unknownBlockstateModelField",
  "rsgl.duplicateBlockstateModelField",
  "rsgl.blockstateWeightInvalidContext",
  "rsgl.invalidBlockstateUvlock",
  "rsgl.invalidBlockstateRotation"
]);

const provisionalContextualExpressionDiagnosticCodes = new Set([
  "rsgl.blockstateSelectorMustBeObject",
  "rsgl.invalidBlockstateSelectorValue",
  "rsgl.invalidBlockstateSelectorKey",
  "rsgl.duplicateBlockstateSelectorProperty",
  "rsgl.emptyBlockstateSelectorUseWildcard",
  "rsgl.invalidBlockstatePredicate",
  "rsgl.invalidBlockstatePredicateProperty",
  "rsgl.invalidBlockstatePredicateValue",
  "rsgl.invalidBlockstatePredicateMembership",
  "rsgl.emptyBlockstatePredicateMembership",
  "rsgl.invalidBlockstatePredicateComparison",
  "rsgl.blockstateEnumLiteralShadowed"
]);

/** Rechecks ModelSpec, selector, and predicate sites after import linking. */
export function validateResolvedProgramBlockstateSemantics(
  models: readonly RsglSemanticModel[]
): RsglFileDiagnostic[] {
  const result: RsglFileDiagnostic[] = [];

  for (const model of models) {
    const resolvedExpectedTypes = model.resolvedExpectedTypes instanceof Map
      ? model.resolvedExpectedTypes
      : new Map(model.resolvedExpectedTypes);
    model.resolvedExpectedTypes = resolvedExpectedTypes;
    model.diagnostics = model.diagnostics.filter(diagnostic =>
      !provisionalModelSpecDiagnosticCodes.has(diagnostic.code)
      && !provisionalContextualExpressionDiagnosticCodes.has(diagnostic.code)
    );
    const known = new Set(model.diagnostics.map(diagnosticKey));

    for (const record of model.blockstateModelSpecRecords ?? []) {
      const diagnostics: RsglDiagnostic[] = [];
      checkBlockstateModelSpec(
        {
          diagnostics,
          references: [],
          recordResolvedExpectedType: (expression, expectedType) => {
            resolvedExpectedTypes.set(expression, expectedType);
          },
          defineIdentifier: () => undefined
        },
        record.node,
        scopeWithLinkedGlobalFallback(record.scope, model.scope)
      );
      appendNewDiagnostics(result, known, diagnostics, model.fileName);
    }

    for (const record of model.blockstateContextualExpressionRecords ?? []) {
      const diagnostics: RsglDiagnostic[] = [];
      const context = {
        diagnostics,
        references: [],
        recordResolvedExpectedType: (expression: ExprNode, expectedType: RsglType) => {
          resolvedExpectedTypes.set(expression, expectedType);
        },
        defineIdentifier: () => undefined
      };
      const scope = scopeWithLinkedGlobalFallback(record.scope, model.scope);
      if (record.kind === "selector") {
        checkBlockstateSelector(context, record.expression, scope);
      } else {
        checkBlockstatePredicate(context, record.expression, scope);
      }
      appendNewDiagnostics(result, known, diagnostics, model.fileName);
    }
  }

  return result;
}

function appendNewDiagnostics(
  output: RsglFileDiagnostic[],
  known: Set<string>,
  diagnostics: readonly RsglDiagnostic[],
  fileName: string
): void {
  for (const item of diagnostics) {
    const key = diagnosticKey(item);
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    output.push(fileDiagnostic(
      fileName,
      item.code,
      item.message,
      item.range,
      item.severity
    ));
  }
}

function diagnosticKey(
  item: Pick<RsglDiagnostic, "code" | "message" | "range" | "severity">
): string {
  return [
    item.code,
    item.message,
    item.range.start,
    item.range.end,
    item.severity
  ].join("\0");
}
