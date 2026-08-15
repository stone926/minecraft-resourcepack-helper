import type { TextRange } from "../parser";
import {
  collectionBuiltinNamesForLayer,
  getCollectionBuiltinDescriptor,
  type RsglCollectionEvalHandler
} from "../builtinRegistry";
import { normalizeFlatDepth } from "../flatDepth";
import type {
  EvaluationResult,
  EvaluationValue,
  EvaluationValueIssue,
  LambdaValue
} from "./evaluationTypes";
import { normalizeJsonValue } from "./evaluationJsonValues";
import {
  MAX_EVALUATION_ITEMS_PER_ALLOCATION,
  type EvaluationItemBudget
} from "./evaluationItemBudget";
import { evaluationScalarText } from "./evaluatedResourceValues";
import type { JsonValue } from "./ir";
import {
  createJsonObject,
  jsonObjectEntries,
  jsonObjectKeys,
  setJsonObjectProperty
} from "./jsonObjectProperties";
import { isJsonObject } from "./jsonValues";
import { appendGeneratedPath } from "./sourcePaths";

export interface CollectionBuiltinArgument {
  name?: string;
  value: EvaluationValue;
  range: TextRange;
  result?: EvaluationResult;
  sourceFile?: string;
}

export interface CollectionLambdaArgument {
  value: EvaluationValue;
  range: TextRange;
  result?: EvaluationResult;
  selectedPath?: string;
  sourceFile?: string;
}

export interface CollectionLambdaResult {
  value: EvaluationValue;
  result?: EvaluationResult;
  sourceFile?: string;
}

export interface CollectionTraceSource {
  result: EvaluationResult;
  selectedPath?: string;
  sourceFile?: string;
  /** Retain provenance but do not inherit issues from a selected value. */
  omitValueIssues?: boolean;
}

export interface CollectionTracePath {
  outputPath: string;
  source: CollectionTraceSource;
}

/** Path ownership captured by the same evaluation that produced the value. */
export interface CollectionEvaluationTrace {
  paths: CollectionTracePath[];
  /** Contextual state-record collisions ignored by ordinary object sinks. */
  stateRecordKeyIssues?: EvaluationValueIssue[];
}

export interface CollectionBuiltinHost {
  budget: EvaluationItemBudget;
  isLambda(value: EvaluationValue): value is LambdaValue;
  invokeLambda(lambda: LambdaValue, argument: CollectionLambdaArgument): CollectionLambdaResult;
  reportError(code: string, message: string, range: TextRange): void;
  markFailure(): void;
}

export type CollectionBuiltinEvaluation =
  | { handled: false }
  | {
      handled: true;
      value: EvaluationValue;
      trace?: CollectionEvaluationTrace;
    };

const collectionBuiltinNames = new Set(collectionBuiltinNamesForLayer("eval"));

export function isCollectionRuntimeBuiltinName(name: string): boolean {
  return collectionBuiltinNames.has(name);
}

type CollectionBuiltinEvaluator = (
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
) => CollectionBuiltinEvaluation;

/**
 * Runtime handlers keyed by the registry's `eval` handler keys.
 * The registry (../builtinRegistry.ts) decides which builtin routes here.
 */
const collectionEvaluationHandlers = {
  asList: evaluateAsList,
  length: evaluateLength,
  map: evaluateMap,
  filter: evaluateFilter,
  flatMap: evaluateFlatMap,
  flat: evaluateFlat,
  concat: evaluateConcat,
  join: evaluateJoin,
  entries: evaluateEntries,
  keys: evaluateKeys,
  values: evaluateValues,
  mergeObjects: evaluateMergeObjects,
  product: evaluateProduct
} satisfies Record<RsglCollectionEvalHandler, CollectionBuiltinEvaluator>;

export function evaluateCollectionBuiltin(
  name: string,
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const handlerKey = getCollectionBuiltinDescriptor(name)?.eval;
  if (!handlerKey) {
    return { handled: false };
  }
  return collectionEvaluationHandlers[handlerKey](args, range, host);
}

function evaluateAsList(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const valueArg = argument(args, "value", 0);
  if (!valueArg || valueArg.value === undefined) {
    host.markFailure();
    return handledFailure();
  }

  const source = traceSource(valueArg);
  if (Array.isArray(valueArg.value)) {
    return tracedValue(valueArg.value, source ? [{ outputPath: "", source }] : []);
  }
  if (valueArg.value !== null && evaluationScalarText(valueArg.value) === null) {
    host.reportError(
      "rsgl.collectionExpected",
      `asList expected a List, Range, or scalar value for value, got ${runtimeValueKind(valueArg.value)}.`,
      valueArg.range
    );
    host.markFailure();
    return handledFailure();
  }
  if (!consumeItems(host, 1, range, "asList")) {
    return handledFailure();
  }
  return tracedValue(
    [normalizeJsonValue(valueArg.value)],
    source ? [{ outputPath: "/0", source }] : []
  );
}

function evaluateLength(
  args: readonly CollectionBuiltinArgument[],
  _range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const source = sourceArg ? listArgument(sourceArg, "length", "source", host) : undefined;
  if (!sourceArg || !source) {
    host.markFailure();
    return handledFailure();
  }
  return { handled: true, value: source.length };
}

function evaluateMap(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const mapperArg = argument(args, "mapper", 1);
  const source = sourceArg ? listArgument(sourceArg, "map", "source", host) : undefined;
  const mapper = mapperArg?.value;
  if (!sourceArg || !mapperArg || !source || !host.isLambda(mapper)) {
    host.markFailure();
    return handledFailure();
  }
  if (!consumeItems(host, source.length, range, "map")) {
    return handledFailure();
  }

  const value = new Array<JsonValue>(source.length);
  const paths: CollectionTracePath[] = [];
  for (let index = 0; index < source.length; index += 1) {
    const selectedPath = appendGeneratedPath("", String(index));
    const mapped = host.invokeLambda(mapper, {
      value: source[index] as EvaluationValue,
      range: sourceArg.range,
      result: sourceArg.result,
      selectedPath,
      sourceFile: sourceArg.sourceFile
    });
    if (mapped.value === undefined) {
      host.markFailure();
      return handledFailure();
    }
    value[index] = normalizeJsonValue(mapped.value);
    if (mapped.result) {
      paths.push({
        outputPath: selectedPath,
        source: {
          result: mapped.result,
          sourceFile: mapped.sourceFile
        }
      });
    }
  }
  return tracedValue(value, paths);
}

function evaluateFilter(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const predicateArg = argument(args, "predicate", 1);
  const source = sourceArg ? listArgument(sourceArg, "filter", "source", host) : undefined;
  const predicate = predicateArg?.value;
  if (!sourceArg || !predicateArg || !source || !host.isLambda(predicate)) {
    host.markFailure();
    return handledFailure();
  }
  // filter is O(n) even when it emits no items, so input length is the stable
  // work unit and is checked before any predicate executes.
  if (!consumeItems(host, source.length, range, "filter")) {
    return handledFailure();
  }

  const value: JsonValue[] = [];
  const paths: CollectionTracePath[] = [];
  for (let sourceIndex = 0; sourceIndex < source.length; sourceIndex += 1) {
    const selectedPath = appendGeneratedPath("", String(sourceIndex));
    const selected = host.invokeLambda(predicate, {
      value: source[sourceIndex] as EvaluationValue,
      range: sourceArg.range,
      result: sourceArg.result,
      selectedPath,
      sourceFile: sourceArg.sourceFile
    });
    if (selected.value === undefined) {
      host.markFailure();
      return handledFailure();
    }
    if (typeof selected.value !== "boolean") {
      host.reportError(
        "rsgl.predicateMustReturnBoolean",
        `filter predicate must return Boolean, got ${runtimeValueKind(selected.value)}.`,
        predicateArg.range
      );
      host.markFailure();
      return handledFailure();
    }
    if (!selected.value) {
      continue;
    }
    const outputIndex = value.length;
    value.push(normalizeJsonValue(source[sourceIndex]));
    const sourceTrace = traceSource(sourceArg, selectedPath);
    if (sourceTrace) {
      paths.push({
        outputPath: appendGeneratedPath("", String(outputIndex)),
        source: sourceTrace
      });
    }
  }
  return tracedValue(value, paths);
}

function evaluateFlatMap(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const mapperArg = argument(args, "mapper", 1);
  const source = sourceArg ? listArgument(sourceArg, "flatMap", "source", host) : undefined;
  const mapper = mapperArg?.value;
  if (!sourceArg || !mapperArg || !source || !host.isLambda(mapper)) {
    host.markFailure();
    return handledFailure();
  }

  const chunks: Array<{
    value: readonly JsonValue[];
    result?: EvaluationResult;
    sourceFile?: string;
  }> = [];
  let totalLength = 0;
  for (let index = 0; index < source.length; index += 1) {
    const selectedPath = appendGeneratedPath("", String(index));
    const mapped = host.invokeLambda(mapper, {
      value: source[index] as EvaluationValue,
      range: sourceArg.range,
      result: sourceArg.result,
      selectedPath,
      sourceFile: sourceArg.sourceFile
    });
    if (mapped.value === undefined) {
      host.markFailure();
      return handledFailure();
    }
    if (!Array.isArray(mapped.value)) {
      host.reportError(
        "rsgl.mapperReturnTypeMismatch",
        `flatMap mapper must return a List or Range, got ${runtimeValueKind(mapped.value)}.`,
        mapperArg.range
      );
      host.markFailure();
      return handledFailure();
    }
    const nextLength = checkedLengthSum(totalLength, mapped.value.length);
    if (nextLength === null || !host.budget.canConsume(nextLength)) {
      reportExpansionLimit(host, range, "flatMap", nextLength ?? Number.POSITIVE_INFINITY);
      return handledFailure();
    }
    totalLength = nextLength;
    chunks.push({
      value: mapped.value,
      result: mapped.result,
      sourceFile: mapped.sourceFile
    });
  }

  if (!consumeItems(host, totalLength, range, "flatMap")) {
    return handledFailure();
  }
  const value = new Array<JsonValue>(totalLength);
  const paths: CollectionTracePath[] = [];
  let outputIndex = 0;
  for (const chunk of chunks) {
    for (let chunkIndex = 0; chunkIndex < chunk.value.length; chunkIndex += 1) {
      value[outputIndex] = normalizeJsonValue(chunk.value[chunkIndex]);
      if (chunk.result) {
        paths.push({
          outputPath: appendGeneratedPath("", String(outputIndex)),
          source: {
            result: chunk.result,
            selectedPath: appendGeneratedPath("", String(chunkIndex)),
            sourceFile: chunk.sourceFile
          }
        });
      }
      outputIndex += 1;
    }
  }
  return tracedValue(value, paths);
}

interface FlatTraversalFrame {
  source: readonly JsonValue[];
  length: number;
  index: number;
  depth: number;
  sourcePath?: FlatTraversalPath;
}

interface FlatTraversalPath {
  parent?: FlatTraversalPath;
  index: number;
}

function evaluateFlat(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const source = sourceArg ? listArgument(sourceArg, "flat", "source", host) : undefined;
  const depthArg = argument(args, "depth", 1);
  if (!sourceArg || !source || (depthArg && typeof depthArg.value !== "number")) {
    host.markFailure();
    return handledFailure();
  }

  const depth = depthArg ? normalizeFlatDepth(depthArg.value as number) : Number.POSITIVE_INFINITY;
  const value: JsonValue[] = [];
  const paths: CollectionTracePath[] = [];
  const active = new Set<readonly JsonValue[]>([source]);
  const stack: FlatTraversalFrame[] = [{
    source,
    length: source.length,
    index: 0,
    depth
  }];

  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (frame.index >= frame.length) {
      active.delete(frame.source);
      stack.pop();
      continue;
    }

    const sourceIndex = frame.index;
    frame.index += 1;
    // RSGL source Lists are dense, but injected evaluator values can be sparse.
    // Array.flat skips missing indices at every level it visits.
    if (!(sourceIndex in frame.source)) {
      continue;
    }

    const item = frame.source[sourceIndex];
    const itemPath = sourceArg.result
      ? { parent: frame.sourcePath, index: sourceIndex }
      : undefined;
    if (frame.depth > 0 && Array.isArray(item)) {
      const nestedDepth = frame.depth === Number.POSITIVE_INFINITY
        ? frame.depth
        : frame.depth - 1;
      // Cyclic arrays are not valid RSGL/JSON values. Reject them before a
      // large finite depth can allocate an unbounded chain of traversal frames.
      if (active.has(item)) {
        host.reportError(
          "rsgl.collectionExpansionLimit",
          "Collection operation 'flat' cannot flatten a cyclic List.",
          range
        );
        host.markFailure();
        return handledFailure();
      }
      active.add(item);
      stack.push({
        source: item,
        length: item.length,
        index: 0,
        depth: nestedDepth,
        sourcePath: itemPath
      });
      continue;
    }

    const nextLength = checkedLengthSum(value.length, 1);
    if (nextLength === null || nextLength > MAX_EVALUATION_ITEMS_PER_ALLOCATION) {
      reportExpansionLimit(host, range, "flat", nextLength ?? Number.POSITIVE_INFINITY);
      return handledFailure();
    }
    if (!consumeItems(host, 1, range, "flat")) {
      return handledFailure();
    }
    const outputIndex = value.length;
    value.push(normalizeJsonValue(item));
    const sourceTrace = itemPath
      ? traceSource(sourceArg, flatTraversalPathText(itemPath))
      : undefined;
    if (sourceTrace) {
      paths.push({
        outputPath: appendGeneratedPath("", String(outputIndex)),
        source: sourceTrace
      });
    }
  }

  return tracedValue(value, paths);
}

function flatTraversalPathText(path: FlatTraversalPath): string {
  const indexes: number[] = [];
  let current: FlatTraversalPath | undefined = path;
  while (current) {
    indexes.push(current.index);
    current = current.parent;
  }
  let result = "";
  for (let index = indexes.length - 1; index >= 0; index -= 1) {
    result = appendGeneratedPath(result, String(indexes[index]));
  }
  return result;
}

function evaluateConcat(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sources: Array<{ arg: CollectionBuiltinArgument; value: readonly JsonValue[] }> = [];
  let totalLength = 0;
  for (const arg of args) {
    const value = listArgument(arg, "concat", "source", host);
    if (!value) {
      host.markFailure();
      return handledFailure();
    }
    const nextLength = checkedLengthSum(totalLength, value.length);
    if (nextLength === null || !host.budget.canConsume(nextLength)) {
      reportExpansionLimit(host, range, "concat", nextLength ?? Number.POSITIVE_INFINITY);
      return handledFailure();
    }
    totalLength = nextLength;
    sources.push({ arg, value });
  }
  if (!consumeItems(host, totalLength, range, "concat")) {
    return handledFailure();
  }

  const value = new Array<JsonValue>(totalLength);
  const paths: CollectionTracePath[] = [];
  let outputIndex = 0;
  for (const source of sources) {
    for (let sourceIndex = 0; sourceIndex < source.value.length; sourceIndex += 1) {
      value[outputIndex] = normalizeJsonValue(source.value[sourceIndex]);
      const sourceTrace = traceSource(
        source.arg,
        appendGeneratedPath("", String(sourceIndex))
      );
      if (sourceTrace) {
        paths.push({
          outputPath: appendGeneratedPath("", String(outputIndex)),
          source: sourceTrace
        });
      }
      outputIndex += 1;
    }
  }
  return tracedValue(value, paths);
}

function evaluateJoin(
  args: readonly CollectionBuiltinArgument[],
  _range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const separatorArg = argument(args, "separator", 1);
  const source = sourceArg ? listArgument(sourceArg, "join", "source", host) : undefined;
  if (!sourceArg || !separatorArg || !source || typeof separatorArg.value !== "string") {
    host.markFailure();
    return handledFailure();
  }
  const invalidIndex = source.findIndex(value => typeof value !== "string");
  if (invalidIndex >= 0) {
    host.reportError(
      "rsgl.collectionExpected",
      `join expected every source item to be String, but item ${invalidIndex} is ${runtimeValueKind(source[invalidIndex])}.`,
      sourceArg.range
    );
    host.markFailure();
    return handledFailure();
  }
  // join traverses an existing collection but emits one scalar. The shared
  // item budget accounts for collection expansion, so no item is consumed.
  return { handled: true, value: source.join(separatorArg.value) };
}

function evaluateEntries(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const objectArg = argument(args, "object", 0);
  const object = objectArg ? objectArgument(objectArg, "entries", host) : undefined;
  if (!objectArg || !object) {
    host.markFailure();
    return handledFailure();
  }
  const keys = jsonObjectKeys(object);
  if (!consumeItems(host, keys.length, range, "entries")) {
    return handledFailure();
  }
  const value = new Array<JsonValue>(keys.length);
  const paths: CollectionTracePath[] = [];
  keys.forEach((key, index) => {
    const entry = createJsonObject();
    setJsonObjectProperty(entry, "key", key);
    setJsonObjectProperty(entry, "value", normalizeJsonValue(object[key]));
    value[index] = entry;
    const source = traceSource(objectArg, appendGeneratedPath("", key));
    if (!source) {
      return;
    }
    const basePath = appendGeneratedPath("", String(index));
    paths.push(
      {
        outputPath: appendGeneratedPath(basePath, "key"),
        source: { ...source, omitValueIssues: true }
      },
      { outputPath: appendGeneratedPath(basePath, "value"), source }
    );
  });
  return tracedValue(value, paths);
}

function evaluateKeys(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const objectArg = argument(args, "object", 0);
  const object = objectArg ? objectArgument(objectArg, "keys", host) : undefined;
  if (!objectArg || !object) {
    host.markFailure();
    return handledFailure();
  }
  const value = jsonObjectKeys(object);
  if (!consumeItems(host, value.length, range, "keys")) {
    return handledFailure();
  }
  return tracedValue(value, value.flatMap((key, index) => {
    const source = traceSource(objectArg, appendGeneratedPath("", key), true);
    return source
      ? [{ outputPath: appendGeneratedPath("", String(index)), source }]
      : [];
  }));
}

function evaluateValues(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const objectArg = argument(args, "object", 0);
  const object = objectArg ? objectArgument(objectArg, "values", host) : undefined;
  if (!objectArg || !object) {
    host.markFailure();
    return handledFailure();
  }
  const keys = jsonObjectKeys(object);
  if (!consumeItems(host, keys.length, range, "values")) {
    return handledFailure();
  }
  const value = keys.map(key => normalizeJsonValue(object[key]));
  return tracedValue(value, keys.flatMap((key, index) => {
    const source = traceSource(objectArg, appendGeneratedPath("", key));
    return source
      ? [{ outputPath: appendGeneratedPath("", String(index)), source }]
      : [];
  }));
}

function evaluateMergeObjects(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const objects: Array<{
    arg: CollectionBuiltinArgument;
    keys: string[];
    value: Record<string, JsonValue>;
  }> = [];
  let visitedEntries = 0;
  for (const arg of args) {
    const value = objectArgument(arg, "mergeObjects", host);
    if (!value) {
      host.markFailure();
      return handledFailure();
    }
    const keys = jsonObjectKeys(value);
    const nextCount = checkedLengthSum(visitedEntries, keys.length);
    if (nextCount === null || !host.budget.canConsume(nextCount)) {
      reportExpansionLimit(host, range, "mergeObjects", nextCount ?? Number.POSITIVE_INFINITY);
      return handledFailure();
    }
    visitedEntries = nextCount;
    objects.push({ arg, keys, value });
  }
  if (!consumeItems(host, visitedEntries, range, "mergeObjects")) {
    return handledFailure();
  }

  const value = createJsonObject();
  const pathOwners = new Map<string, CollectionTraceSource>();
  for (const object of objects) {
    for (const key of object.keys) {
      setJsonObjectProperty(value, key, normalizeJsonValue(object.value[key]));
      const source = traceSource(object.arg, appendGeneratedPath("", key));
      if (source) {
        pathOwners.set(key, source);
      } else {
        pathOwners.delete(key);
      }
    }
  }
  return tracedValue(value, Array.from(pathOwners, ([key, source]) => ({
    outputPath: appendGeneratedPath("", key),
    source
  })));
}

function evaluateProduct(
  args: readonly CollectionBuiltinArgument[],
  range: TextRange,
  host: CollectionBuiltinHost
): CollectionBuiltinEvaluation {
  const sourceArg = argument(args, "source", 0);
  const source = sourceArg ? objectArgument(sourceArg, "product", host) : undefined;
  if (!sourceArg || !source) {
    host.markFailure();
    return handledFailure();
  }
  const dimensions = jsonObjectEntries(source).map(([key, rawValue]) => ({
    key,
    values: Array.isArray(rawValue) ? rawValue : [rawValue],
    wasList: Array.isArray(rawValue)
  }));
  if (dimensions.some(dimension => dimension.values.length === 0)) {
    return tracedValue([], []);
  }

  let resultCount = 1;
  for (const dimension of dimensions) {
    if (
      dimension.values.length > 0
      && resultCount > Math.floor(host.budget.remaining / dimension.values.length)
    ) {
      reportExpansionLimit(host, range, "product", Number.POSITIVE_INFINITY);
      return handledFailure();
    }
    resultCount *= dimension.values.length;
  }
  if (!consumeItems(host, resultCount, range, "product")) {
    return handledFailure();
  }

  let value: Array<Record<string, JsonValue>> = [createJsonObject()];
  for (const dimension of dimensions) {
    const next = new Array<Record<string, JsonValue>>(value.length * dimension.values.length);
    let nextIndex = 0;
    for (const partial of value) {
      for (const item of dimension.values) {
        const productItem = createJsonObject();
        for (const key of jsonObjectKeys(partial)) {
          setJsonObjectProperty(productItem, key, partial[key]);
        }
        setJsonObjectProperty(productItem, dimension.key, normalizeJsonValue(item));
        next[nextIndex] = productItem;
        nextIndex += 1;
      }
    }
    value = next;
  }

  const paths: CollectionTracePath[] = [];
  if (sourceArg.result) {
    for (let resultIndex = 0; resultIndex < value.length; resultIndex += 1) {
      let stride = value.length;
      for (const dimension of dimensions) {
        stride /= dimension.values.length;
        const itemIndex = Math.floor(resultIndex / stride) % dimension.values.length;
        let selectedPath = appendGeneratedPath("", dimension.key);
        if (dimension.wasList) {
          selectedPath = appendGeneratedPath(selectedPath, String(itemIndex));
        }
        paths.push({
          outputPath: appendGeneratedPath(
            appendGeneratedPath("", String(resultIndex)),
            dimension.key
          ),
          source: {
            result: sourceArg.result,
            selectedPath,
            sourceFile: sourceArg.sourceFile
          }
        });
      }
    }
  }
  return tracedValue(value, paths);
}

function argument(
  args: readonly CollectionBuiltinArgument[],
  name: string,
  positionalIndex: number
): CollectionBuiltinArgument | undefined {
  return args.find(arg => arg.name === name)
    ?? args.filter(arg => !arg.name)[positionalIndex];
}

function listArgument(
  arg: CollectionBuiltinArgument,
  operation: string,
  role: string,
  host: CollectionBuiltinHost
): readonly JsonValue[] | undefined {
  if (Array.isArray(arg.value)) {
    return arg.value;
  }
  if (arg.value === undefined) {
    return undefined;
  }
  host.reportError(
    "rsgl.collectionExpected",
    `${operation} expected a List or Range for ${role}, got ${runtimeValueKind(arg.value)}.`,
    arg.range
  );
  return undefined;
}

function objectArgument(
  arg: CollectionBuiltinArgument,
  operation: string,
  host: CollectionBuiltinHost
): Record<string, JsonValue> | undefined {
  if (isJsonObject(arg.value)) {
    return arg.value;
  }
  if (arg.value === undefined) {
    return undefined;
  }
  host.reportError(
    "rsgl.collectionExpected",
    `${operation} expected an Object value, got ${runtimeValueKind(arg.value)}.`,
    arg.range
  );
  return undefined;
}

function traceSource(
  arg: CollectionBuiltinArgument,
  selectedPath?: string,
  omitValueIssues = false
): CollectionTraceSource | undefined {
  return arg.result
    ? {
        result: arg.result,
        ...(selectedPath === undefined ? {} : { selectedPath }),
        ...(omitValueIssues ? { omitValueIssues: true } : {}),
        sourceFile: arg.sourceFile
      }
    : undefined;
}

function consumeItems(
  host: CollectionBuiltinHost,
  count: number,
  range: TextRange,
  operation: string
): boolean {
  if (host.budget.tryConsume(count)) {
    return true;
  }
  reportExpansionLimit(host, range, operation, count);
  return false;
}

function reportExpansionLimit(
  host: CollectionBuiltinHost,
  range: TextRange,
  operation: string,
  requested: number
): void {
  const requestedText = Number.isSafeInteger(requested)
    ? String(requested)
    : `more than ${host.budget.remaining}`;
  host.reportError(
    "rsgl.collectionExpansionLimit",
    `Collection operation '${operation}' exceeds maxEvaluationItems=${host.budget.limit} `
      + `(consumed ${host.budget.consumed}, requested ${requestedText}).`,
    range
  );
  host.markFailure();
}

function checkedLengthSum(left: number, right: number): number | null {
  const sum = left + right;
  return Number.isSafeInteger(sum) ? sum : null;
}

function runtimeValueKind(value: EvaluationValue): string {
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

function handledFailure(): CollectionBuiltinEvaluation {
  return { handled: true, value: undefined };
}

function tracedValue(
  value: EvaluationValue,
  paths: CollectionTracePath[]
): CollectionBuiltinEvaluation {
  return {
    handled: true,
    value,
    trace: { paths }
  };
}
