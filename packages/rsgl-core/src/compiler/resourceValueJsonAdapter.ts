import type { RsglResourceValueObservation } from "./evaluatedResourceValues";
import {
  createEvaluatedResourceId,
  createEvaluatedTextureVariable,
  evaluatedResourceValueToString,
  hasEvaluatedResourceValueBrand,
  isEvaluatedResourceId,
  isEvaluatedTextureVariable
} from "./evaluatedResourceValues";
import type { JsonRuntimeValueAdapter } from "./jsonValueLowerer";

export type RsglResourceValueObserver = (
  observation: RsglResourceValueObservation
) => void;

const defaultResourceValueJsonAdapter = createResourceValueJsonAdapter();

/**
 * Owns every compiler resource-value runtime tag at the JSON boundary. Valid
 * values become their canonical scalar spelling; malformed tags are rejected
 * instead of leaking implementation objects into emitted JSON.
 */
export function createResourceValueJsonAdapter(
  observe?: RsglResourceValueObserver
): JsonRuntimeValueAdapter {
  return {
    lower(value, context) {
      if (isEvaluatedResourceId(value)) {
        const scalar = evaluatedResourceValueToString(value);
        const normalized = createEvaluatedResourceId(scalar, value.resourceKind, "minecraft");
        if (!normalized
          || normalized.namespace !== value.namespace
          || normalized.path !== value.path) {
          return malformedResourceValue();
        }
        observe?.({
          generatedPath: context.generatedPath,
          valueKind: value.resourceKind,
          range: context.range,
          ...(context.sourceFile ? { sourceFile: context.sourceFile } : {})
        });
        return { kind: "value", value: scalar };
      }
      if (isEvaluatedTextureVariable(value)) {
        if (!createEvaluatedTextureVariable(value.value)) {
          return malformedResourceValue();
        }
        observe?.({
          generatedPath: context.generatedPath,
          valueKind: "textureVariable",
          range: context.range,
          ...(context.sourceFile ? { sourceFile: context.sourceFile } : {})
        });
        return { kind: "value", value: evaluatedResourceValueToString(value) };
      }
      if (hasEvaluatedResourceValueBrand(value)) {
        return malformedResourceValue();
      }
      return undefined;
    }
  };
}

function malformedResourceValue(): ReturnType<JsonRuntimeValueAdapter["lower"]> {
  return {
    kind: "error",
    code: "rsgl.invalidResourceRuntimeValue",
    message: "Malformed compiler resource value cannot be emitted as JSON."
  };
}

/** Prepends the mandatory resource adapter without removing custom domains. */
export function resourceValueJsonAdapters(
  adapters: readonly JsonRuntimeValueAdapter[] | undefined,
  observe?: RsglResourceValueObserver
): readonly JsonRuntimeValueAdapter[] {
  return [
    observe ? createResourceValueJsonAdapter(observe) : defaultResourceValueJsonAdapter,
    ...(adapters ?? [])
  ];
}
