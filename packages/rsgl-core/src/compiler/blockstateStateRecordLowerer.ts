import {
  staticPropertyKeyName,
  type ExprNode,
  type ObjectExprNode,
  type TextRange
} from "../parser";
import {
  blockstateSelectorMessages,
  blockstateStateRecordMessages
} from "../diagnosticMessages";
import {
  evaluateExpressionResult,
  type EvaluationOrigin,
  type EvaluationResult,
  originForEvaluationPath,
  rangeForEvaluationPath
} from "./evaluate";
import {
  createJsonValueLoweringHost,
  type JsonValueSinkOptions,
  lowerJsonEvaluationResult
} from "./jsonValueLowerer";
import {
  createJsonObject,
  jsonObjectEntries,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";
import type { RsglCompileContext } from "./templateExpansion";

export type BlockstateStateRecordLoweringRole = "selector" | "multipart";

export interface BlockstateStateRecordLoweringHost extends JsonValueSinkOptions {
  onError: NonNullable<JsonValueSinkOptions["onError"]>;
}

export interface LoweredBlockstateStateRecord {
  readonly value: Record<string, string>;
  readonly evaluation: EvaluationResult;
  readonly origin?: EvaluationOrigin;
}

interface StateRecordLoweringPolicy {
  readonly duplicateKeyCode: string;
  readonly duplicateKeyMessage: string;
  readonly invalidKeyCode: string;
  readonly invalidKeyMessage: string;
  readonly mustBeObjectCode: string;
  readonly mustBeObjectMessage: string;
  readonly emptyCode: string;
  readonly emptyMessage: string;
  readonly invalidValueCode: string;
  readonly invalidValueMessage: string;
  readonly rejectRawConditionEncoding: boolean;
}

const selectorPolicy: StateRecordLoweringPolicy = {
  duplicateKeyCode: "rsgl.duplicateBlockstateSelectorProperty",
  duplicateKeyMessage: "A blockstate selector property resolves to a duplicate canonical key.",
  invalidKeyCode: "rsgl.invalidBlockstateSelectorKey",
  invalidKeyMessage: blockstateSelectorMessages.computedKeyMustBeScalar,
  mustBeObjectCode: "rsgl.invalidBlockstateSelector",
  mustBeObjectMessage: "A blockstate variants selector must evaluate to an object.",
  emptyCode: "rsgl.emptyBlockstateSelectorUseWildcard",
  emptyMessage: blockstateSelectorMessages.emptySelectorUseWildcard,
  invalidValueCode: "rsgl.invalidBlockstateSelectorValue",
  invalidValueMessage: blockstateStateRecordMessages.selectorValueMustBeScalar,
  rejectRawConditionEncoding: false
};

const multipartPolicy: StateRecordLoweringPolicy = {
  duplicateKeyCode: "rsgl.duplicateMultipartStateRecordProperty",
  duplicateKeyMessage: "A multipart state record property resolves to a duplicate canonical key.",
  invalidKeyCode: "rsgl.invalidMultipartStateRecordKey",
  invalidKeyMessage: blockstateStateRecordMessages.multipartComputedKeyMustBeScalar,
  mustBeObjectCode: "rsgl.multipartStateRecordMustBeObject",
  mustBeObjectMessage: blockstateStateRecordMessages.multipartMustBeObject,
  emptyCode: "rsgl.emptyMultipartStateRecordUseAlways",
  emptyMessage: blockstateStateRecordMessages.emptyMultipartUseAlways,
  invalidValueCode: "rsgl.invalidMultipartStateRecordValue",
  invalidValueMessage: blockstateStateRecordMessages.multipartValueMustBeScalar,
  rejectRawConditionEncoding: true
};

/** Evaluates, validates, and canonicalizes a blockstate state record once. */
export function lowerBlockstateStateRecord(
  expression: ExprNode,
  context: RsglCompileContext,
  host: BlockstateStateRecordLoweringHost,
  role: BlockstateStateRecordLoweringRole
): LoweredBlockstateStateRecord | undefined {
  const policy = role === "selector" ? selectorPolicy : multipartPolicy;
  const result = evaluateExpressionResult(expression, context);
  const keyIssue = result.valueIssues.find(issue =>
    issue.kind === "duplicateObjectKey"
    || issue.kind === "stateRecordDuplicateObjectKey"
    || issue.kind === "invalidObjectKey"
  );
  if (keyIssue) {
    const duplicate = keyIssue.kind !== "invalidObjectKey";
    host.onError(
      duplicate ? policy.duplicateKeyCode : policy.invalidKeyCode,
      duplicate ? policy.duplicateKeyMessage : policy.invalidKeyMessage,
      keyIssue.sourceRange,
      keyIssue.sourceFile
    );
    return undefined;
  }

  const value = lowerJsonEvaluationResult(
    result,
    expression.range,
    createJsonValueLoweringHost(context, host)
  );
  if (value === undefined) {
    return undefined;
  }
  if (!isJsonObject(value)) {
    host.onError(
      policy.mustBeObjectCode,
      policy.mustBeObjectMessage,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }

  const entries = jsonObjectEntries(value);
  if (entries.length === 0) {
    host.onError(
      policy.emptyCode,
      policy.emptyMessage,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }

  const canonical = createJsonObject<string>(Object.getPrototypeOf(value));
  for (const [key, item] of entries) {
    const generatedPath = appendGeneratedPath("", key);
    const range = rangeForEvaluationPath(result.pathRanges, generatedPath) ?? expression.range;
    const origin = originForEvaluationPath(result.pathOrigins, generatedPath);
    const fileName = origin?.sourceFile ?? context.sourceFile;
    if (!isBlockstateStateValue(item)) {
      host.onError(
        policy.invalidValueCode,
        policy.invalidValueMessage,
        range,
        fileName
      );
      return undefined;
    }
    if (policy.rejectRawConditionEncoding && (key === "OR" || key === "AND")) {
      const keySource = inlineStateRecordKeySource(
        expression,
        key,
        range,
        fileName,
        context.sourceFile
      );
      host.onError(
        "rsgl.rawMultipartStateRecordLogicalKey",
        blockstateStateRecordMessages.multipartRawLogicalKey,
        keySource.range,
        keySource.sourceFile
      );
      return undefined;
    }
    const text = String(item);
    if (
      policy.rejectRawConditionEncoding
      && (text.includes("|") || text.startsWith("!"))
    ) {
      const valueSource = inlineStateRecordValueSource(
        expression,
        range,
        fileName,
        context.sourceFile
      );
      host.onError(
        "rsgl.rawMultipartStateRecordValue",
        blockstateStateRecordMessages.multipartRawEncodedValue,
        valueSource.range,
        valueSource.sourceFile
      );
      return undefined;
    }
    setJsonObjectProperty(canonical, key, text);
  }

  const origin = originForEvaluationPath(result.pathOrigins, "") ?? result.origin;
  return {
    value: canonical,
    evaluation: result,
    ...(origin ? { origin } : {})
  };
}

function isBlockstateStateValue(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function inlineStateRecordKeySource(
  expression: ExprNode,
  key: string,
  valueRange: TextRange,
  valueSourceFile: string | undefined,
  callerSourceFile: string | undefined
): { range: TextRange; sourceFile: string | undefined } {
  if (expression.kind !== "ObjectExpr") {
    return { range: expression.range, sourceFile: callerSourceFile };
  }

  const staticOwner = expression.properties.find(property =>
    property.kind === "ObjectProperty" && staticPropertyKeyName(property.key) === key
  );
  if (staticOwner?.kind === "ObjectProperty") {
    return { range: staticOwner.key.range, sourceFile: callerSourceFile };
  }

  if (valueSourceFile === callerSourceFile) {
    const dynamicOwner = directPropertyOwningRange(expression, valueRange);
    if (dynamicOwner) {
      return { range: dynamicOwner.key.range, sourceFile: callerSourceFile };
    }
  }
  return { range: expression.range, sourceFile: callerSourceFile };
}

function inlineStateRecordValueSource(
  expression: ExprNode,
  valueRange: TextRange,
  valueSourceFile: string | undefined,
  callerSourceFile: string | undefined
): { range: TextRange; sourceFile: string | undefined } {
  if (expression.kind === "ObjectExpr" && valueSourceFile === callerSourceFile) {
    const directOwner = directPropertyOwningRange(expression, valueRange);
    if (directOwner) {
      return { range: valueRange, sourceFile: valueSourceFile };
    }
  }
  return { range: expression.range, sourceFile: callerSourceFile };
}

function directPropertyOwningRange(
  expression: ObjectExprNode,
  range: TextRange
): Extract<ObjectExprNode["properties"][number], { kind: "ObjectProperty" }> | undefined {
  return expression.properties.find((property): property is Extract<
    ObjectExprNode["properties"][number],
    { kind: "ObjectProperty" }
  > => property.kind === "ObjectProperty"
    && property.value.range.start <= range.start
    && property.value.range.end >= range.end);
}
