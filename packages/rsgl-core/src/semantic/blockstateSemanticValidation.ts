import type { RsglDiagnostic } from "../parser";
import {
  blockstateApplyExpectationForNode,
  checkBlockstateApplySite
} from "./blockstateApplyChecker";
import {
  checkBlockstateCondition,
  checkBlockstateSelector
} from "./blockstateSelectorChecker";
import { fileDiagnostic } from "./diagnostics";
import { scopeWithLinkedGlobalFallback } from "./linkedScope";
import type {
  RsglBlockstateApplyFact,
  RsglBlockstateApplySiteNode,
  RsglFileDiagnostic,
  RsglSemanticModel
} from "./types";

const provisionalBlockstateApplyDiagnosticCodes = new Set([
  "rsgl.invalidBlockstateApplyHead",
  "rsgl.nestedBlockstateModelList",
  "rsgl.emptyBlockstateModelList",
  "rsgl.unknownBlockstateModelField",
  "rsgl.duplicateBlockstateModelField",
  "rsgl.missingBlockstateModel",
  "rsgl.invalidBlockstateUvlock",
  "rsgl.invalidRandomWeight",
  "rsgl.invalidBlockstateRotation"
]);

const provisionalContextualExpressionDiagnosticCodes = new Set([
  "rsgl.blockstateSelectorMustBeObject",
  "rsgl.invalidBlockstateSelectorValue",
  "rsgl.invalidBlockstateSelectorKey",
  "rsgl.duplicateBlockstateSelectorProperty",
  "rsgl.invalidBlockstateCondition",
  "rsgl.invalidBlockstateWhen",
  "rsgl.invalidBlockstateLogicalCondition",
  "rsgl.mixedBlockstateWhenCondition"
]);

/**
 * Rechecks apply heads after import/export linking has replaced provisional
 * Any/import symbols with their final types. It also refreshes the immutable
 * per-node policy that runtime lowering consumes.
 */
export function validateResolvedProgramBlockstateSemantics(
  models: readonly RsglSemanticModel[]
): RsglFileDiagnostic[] {
  const result: RsglFileDiagnostic[] = [];

  for (const model of models) {
    const resolvedExpectedTypes = model.resolvedExpectedTypes instanceof Map
      ? model.resolvedExpectedTypes
      : new Map(model.resolvedExpectedTypes);
    model.resolvedExpectedTypes = resolvedExpectedTypes;
    // Apply-site diagnostics are provisional until import-all/re-export linking
    // has populated the final global scope. Every code in this set is produced
    // by a recorded site and is regenerated below from the linked program.
    model.diagnostics = model.diagnostics.filter(diagnostic =>
      !provisionalBlockstateApplyDiagnosticCodes.has(diagnostic.code)
      && !provisionalContextualExpressionDiagnosticCodes.has(diagnostic.code)
    );
    const facts = new Map<RsglBlockstateApplySiteNode, RsglBlockstateApplyFact>(
      model.blockstateApplyFacts
    );
    const known = new Set(model.diagnostics.map(diagnosticKey));

    for (const record of model.blockstateApplyRecords ?? []) {
      const diagnostics: RsglDiagnostic[] = [];
      checkBlockstateApplySite(
        {
          diagnostics,
          references: [],
          // This linked recheck is authoritative. Replacing a provisional
          // fact is essential for bare import-all values whose first-pass type
          // was Unknown but whose final type may be explicit Json.
          recordResolvedExpectedType: (expression, expectedType) => {
            resolvedExpectedTypes.set(expression, expectedType);
          },
          defineIdentifier: () => undefined
        },
        record.node,
        scopeWithLinkedGlobalFallback(record.scope, model.scope),
        blockstateApplyExpectationForNode(record.node),
        (node, _scope, fact) => facts.set(node, fact)
      );
      for (const item of diagnostics) {
        const key = diagnosticKey(item);
        if (known.has(key)) {
          continue;
        }
        known.add(key);
        result.push(fileDiagnostic(
          model.fileName,
          item.code,
          item.message,
          item.range,
          item.severity
        ));
      }
    }
    for (const record of model.blockstateContextualExpressionRecords ?? []) {
      const diagnostics: RsglDiagnostic[] = [];
      const context = {
        diagnostics,
        references: [],
        defineIdentifier: () => undefined
      };
      const scope = scopeWithLinkedGlobalFallback(record.scope, model.scope);
      if (record.kind === "selector") {
        checkBlockstateSelector(context, record.expression, record.selectorSyntax, scope);
      } else {
        checkBlockstateCondition(context, record.expression, scope);
      }
      for (const item of diagnostics) {
        const key = diagnosticKey(item);
        if (known.has(key)) {
          continue;
        }
        known.add(key);
        result.push(fileDiagnostic(
          model.fileName,
          item.code,
          item.message,
          item.range,
          item.severity
        ));
      }
    }
    model.blockstateApplyFacts = facts;
  }

  return result;
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
