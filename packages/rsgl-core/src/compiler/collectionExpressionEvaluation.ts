import type { ListElementNode, ObjectEntryNode, ObjectPropertyNode } from "../parser";
import type { CollectionEvaluationTrace } from "./collectionBuiltins";
import { consumeEvaluationItems } from "./evaluationItemAccounting";
import { reportInvalidSpread } from "./evaluationErrors";
import { normalizeJsonValue } from "./evaluationJsonValues";
import type { EvaluationRuntimeHost } from "./evaluationRuntimeHost";
import type { EvaluationContext, EvaluationValue } from "./evaluationTypes";
import { evaluationScalarText } from "./evaluatedResourceValues";
import {
  createJsonObject,
  jsonObjectKeys,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

export function evaluateListExpression(
  elements: readonly ListElementNode[],
  context: EvaluationContext,
  host: EvaluationRuntimeHost
): EvaluationValue {
  const result = [];
  const paths: CollectionEvaluationTrace["paths"] = [];
  let requiresOwnershipTrace = false;
  for (const element of elements) {
    if (element.kind !== "ListSpread") {
      const value = host.evaluateExpression(element, context);
      const child = context.evaluationTrace?.latestChildResult(element);
      const outputPath = appendGeneratedPath("", String(result.length));
      result.push(normalizeJsonValue(value));
      if (child) {
        paths.push({
          outputPath,
          source: { result: child, sourceFile: context.sourceFile }
        });
      }
      continue;
    }

    requiresOwnershipTrace = true;
    const spreadValue = host.evaluateExpression(element.expression, context);
    const child = context.evaluationTrace?.latestChildResult(element.expression);
    if (spreadValue === undefined) {
      return undefined;
    }
    if (!Array.isArray(spreadValue)) {
      reportInvalidSpread(
        context,
        "rsgl.invalidListSpread",
        `List spread requires a List value, got ${runtimeEvaluationValueKind(spreadValue)}.`,
        element.range
      );
      return undefined;
    }
    if (!consumeEvaluationItems(context, spreadValue.length, element.range, "list spread")) {
      return undefined;
    }
    const offset = result.length;
    for (let index = 0; index < spreadValue.length; index += 1) {
      result.push(normalizeJsonValue(spreadValue[index]));
      if (child) {
        paths.push({
          outputPath: appendGeneratedPath("", String(offset + index)),
          source: {
            result: child,
            selectedPath: appendGeneratedPath("", String(index)),
            sourceFile: context.sourceFile
          }
        });
      }
    }
  }
  if (requiresOwnershipTrace) {
    context.evaluationTrace?.recordCollectionTrace({ paths });
  }
  return result;
}

export function evaluateObjectEntries(
  entries: readonly ObjectEntryNode[],
  context: EvaluationContext,
  host: EvaluationRuntimeHost
): EvaluationValue {
  const result = createJsonObject();
  const pathOwners = new Map<string, CollectionEvaluationTrace["paths"][number]["source"]>();
  let requiresOwnershipTrace = false;
  for (const entry of entries) {
    if (entry.kind === "ObjectSpread") {
      requiresOwnershipTrace = true;
      const spreadValue = host.evaluateExpression(entry.expression, context);
      const child = context.evaluationTrace?.latestChildResult(entry.expression);
      if (spreadValue === undefined) {
        return undefined;
      }
      if (!isJsonObject(spreadValue)) {
        reportInvalidSpread(
          context,
          "rsgl.invalidObjectSpread",
          `Object spread requires an Object value, got ${runtimeEvaluationValueKind(spreadValue)}.`,
          entry.range
        );
        return undefined;
      }
      const keys = jsonObjectKeys(spreadValue);
      if (!consumeEvaluationItems(context, keys.length, entry.range, "object spread")) {
        return undefined;
      }
      for (const key of keys) {
        setJsonObjectProperty(result, key, normalizeJsonValue(spreadValue[key]));
        if (child) {
          pathOwners.set(key, {
            result: child,
            selectedPath: appendGeneratedPath("", key),
            sourceFile: context.sourceFile
          });
        } else {
          pathOwners.delete(key);
        }
      }
      continue;
    }

    const key = propertyKeyToString(entry, context, host);
    const value = host.evaluateExpression(entry.value, context);
    const child = context.evaluationTrace?.latestChildResult(entry.value);
    if (key !== null) {
      requiresOwnershipTrace ||= pathOwners.has(key);
      setJsonObjectProperty(result, key, normalizeJsonValue(value));
      if (child) {
        pathOwners.set(key, { result: child, sourceFile: context.sourceFile });
      } else {
        pathOwners.delete(key);
      }
    }
  }
  if (requiresOwnershipTrace) {
    context.evaluationTrace?.recordCollectionTrace({
      paths: Array.from(pathOwners, ([key, source]) => ({
        outputPath: appendGeneratedPath("", key),
        source
      }))
    });
  }
  return result;
}

function runtimeEvaluationValueKind(value: EvaluationValue): string {
  if (value === undefined) {
    return "Undefined";
  }
  if (value === null) {
    return "Null";
  }
  if (Array.isArray(value)) {
    return "List";
  }
  switch (typeof value) {
    case "boolean":
      return "Boolean";
    case "number":
      return "Number";
    case "string":
      return "String";
    default:
      return "Object";
  }
}

function propertyKeyToString(
  property: ObjectPropertyNode,
  context: EvaluationContext,
  host: EvaluationRuntimeHost
): string | null {
  if (property.key.kind === "Identifier") {
    return property.key.text;
  }
  if (property.key.kind === "StringLiteral") {
    return property.key.value;
  }
  if (property.key.kind === "NumberLiteral") {
    return property.key.raw;
  }
  return evaluationScalarText(host.evaluateExpression(property.key.expression, context));
}
