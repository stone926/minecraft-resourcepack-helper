import type { TextRange } from "../parser";
import type { EvaluationContext } from "./evaluate";
import {
  fragmentMergeEngine,
  genericFragmentMergePolicy,
  mappingTargetsAppliedContent,
  offsetFragmentMappingPath,
  type FragmentMergeMode,
  type MergeResult
} from "./fragmentMerge";
import type { JsonValue } from "./ir";
import { isJsonObject } from "./jsonValues";
import type { ResourceBodyCompileOptions, ResourceBodyFragment } from "./resourceBody";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";

/** Applies one generic resource-body fragment and emits only its effective diagnostics and mappings. */
export function applyResourceBodyFragment(
  result: Record<string, JsonValue>,
  fragment: ResourceBodyFragment,
  mode: FragmentMergeMode,
  sourceRange: TextRange,
  context: EvaluationContext,
  options: ResourceBodyCompileOptions,
  path: string,
  fallbackMappingsDeep = false
): void {
  const mergeResult = fragmentMergeEngine.apply(
    result,
    { content: fragment.content, mode, sourceRange },
    options.mergePolicy ?? genericFragmentMergePolicy,
    path
  );
  for (const diagnostic of mergeResult.diagnostics) {
    options.onError?.(diagnostic.code, diagnostic.message, diagnostic.range);
  }
  emitFragmentMappings(
    options,
    path,
    fragment,
    mergeResult,
    sourceRange,
    context,
    fallbackMappingsDeep
  );
}

export function emitResourceBodyMapping(
  options: ResourceBodyCompileOptions,
  generatedPath: string,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  options.onMapping?.({ generatedPath, sourceRange, context });
}

function emitFragmentMappings(
  options: ResourceBodyCompileOptions,
  path: string,
  fragment: ResourceBodyFragment,
  mergeResult: MergeResult,
  fallbackRange: TextRange,
  fallbackContext: EvaluationContext,
  fallbackMappingsDeep: boolean
): void {
  if (fragment.mappings?.length) {
    for (const mapping of fragment.mappings) {
      if (!mappingTargetsAppliedContent(mapping.generatedPath, mergeResult.applied)) {
        continue;
      }
      emitResourceBodyMapping(
        options,
        offsetFragmentMappingPath(joinGeneratedPath(path, mapping.generatedPath), mergeResult.arrayOffsets),
        mapping.sourceRange,
        mapping.context
      );
    }
    return;
  }
  if (fallbackMappingsDeep) {
    emitObjectMappingsDeep(
      options,
      path,
      mergeResult.applied,
      fallbackRange,
      fallbackContext,
      mergeResult.arrayOffsets
    );
  } else {
    emitObjectMappings(options, path, mergeResult.applied, fallbackRange, fallbackContext);
  }
}

function emitObjectMappings(
  options: ResourceBodyCompileOptions,
  path: string,
  value: Record<string, JsonValue>,
  sourceRange: TextRange,
  context: EvaluationContext
): void {
  for (const key of Object.keys(value)) {
    emitResourceBodyMapping(options, appendGeneratedPath(path, key), sourceRange, context);
  }
}

function emitObjectMappingsDeep(
  options: ResourceBodyCompileOptions,
  path: string,
  value: Record<string, JsonValue>,
  sourceRange: TextRange,
  context: EvaluationContext,
  arrayOffsets: ReadonlyMap<string, number>
): void {
  for (const [key, item] of Object.entries(value)) {
    emitValueMappingsDeep(options, appendGeneratedPath(path, key), item, sourceRange, context, arrayOffsets);
  }
}

function emitValueMappingsDeep(
  options: ResourceBodyCompileOptions,
  path: string,
  value: JsonValue,
  sourceRange: TextRange,
  context: EvaluationContext,
  arrayOffsets: ReadonlyMap<string, number>
): void {
  emitResourceBodyMapping(options, offsetFragmentMappingPath(path, arrayOffsets), sourceRange, context);
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      emitValueMappingsDeep(
        options,
        appendGeneratedPath(path, String(index)),
        item,
        sourceRange,
        context,
        arrayOffsets
      );
    });
  } else if (isJsonObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      emitValueMappingsDeep(options, appendGeneratedPath(path, key), item, sourceRange, context, arrayOffsets);
    }
  }
}
