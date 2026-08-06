import {
  ArgumentNode,
  CallExprNode,
  ExprNode,
  ObjectExprNode,
  RsglNode
} from "../parser";
import {
  bindRsglArguments,
  RsglArgumentAssignment,
  RsglArgumentBinding
} from "../arguments";
import {
  collectionBuiltinNamesForLayer,
  getCollectionBuiltinDescriptor,
  type RsglCollectionInferHandler
} from "../builtinRegistry";
import { diagnostic } from "./diagnostics";
import type { RsglExpressionCheckContext } from "./expressionCheckContext";
import { checkLambdaExpression } from "./lambdaTyping";
import { inferProductType, RsglProductSourceIssue } from "./productTypeInference";
import {
  expectedObjectType,
  mergeObjectTypeAlternatives,
  optionalObjectProjection,
  recordProjectionElements
} from "./collectionRecordTypes";
import {
  combineRsglTypes,
  inferListType
} from "./typeNormalization";
import { formatType, isAssignable } from "./typeRelations";
import { inferredUnionBudgetOptions } from "./unionBudget";
import {
  anyType,
  booleanType,
  jsonType,
  neverType,
  numberType,
  RsglParameterSymbol,
  RsglScope,
  RsglSignature,
  RsglType,
  stringType,
  unknownType
} from "./types";

const collectionBuiltinNames = new Set(collectionBuiltinNamesForLayer("infer"));

export interface RsglCollectionCheckHost {
  checkExpression(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope
  ): RsglType;
  checkExpressionForExpectedType(
    context: RsglExpressionCheckContext,
    expression: ExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
  checkAssignable(
    context: RsglExpressionCheckContext,
    expected: RsglType,
    actual: RsglType,
    node: RsglNode
  ): void;
  checkContextualObjectExpression(
    context: RsglExpressionCheckContext,
    expression: ObjectExprNode,
    scope: RsglScope,
    expectedType: RsglType
  ): RsglType;
}

export function isCollectionBuiltinName(name: string): boolean {
  return collectionBuiltinNames.has(name);
}

type CollectionInferenceHandler = (
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
) => RsglType;

/**
 * Inference handlers keyed by the registry's `infer` handler keys.
 * The registry (../builtinRegistry.ts) decides which builtin routes here.
 */
const collectionInferenceHandlers = {
  asList: (session, expectedReturnType) => checkAsList(session, expectedReturnType),
  length: session => checkLength(session),
  map: (session, expectedReturnType) => checkMap(session, expectedReturnType),
  filter: (session, expectedReturnType) => checkFilter(session, expectedReturnType),
  flatMap: (session, expectedReturnType) => checkFlatMap(session, expectedReturnType),
  concat: (session, expectedReturnType) => checkConcat(session, expectedReturnType),
  join: session => checkJoin(session),
  entries: session => checkRecordProjection(session, "entries"),
  keys: session => checkRecordProjection(session, "keys"),
  values: session => checkRecordProjection(session, "values"),
  mergeObjects: (session, expectedReturnType) => checkMergeObjects(session, expectedReturnType),
  has: session => checkHas(session),
  product: session => checkProduct(session)
} satisfies Record<RsglCollectionInferHandler, CollectionInferenceHandler>;

/**
 * Checks collection builtins whose result depends on argument structure.
 * The central signature still owns arity/rest binding; this module owns only
 * builtin-specific generic instantiation and structural result construction.
 */
export function checkCollectionBuiltinCall(
  context: RsglExpressionCheckContext,
  expression: CallExprNode,
  scope: RsglScope,
  signature: RsglSignature,
  host: RsglCollectionCheckHost,
  expectedReturnType?: RsglType
): RsglType {
  const name = expression.callee.kind === "IdentifierExpr"
    ? expression.callee.name.text
    : "";
  const session = new CollectionArgumentSession(context, expression, scope, signature, host);
  const handlerKey = getCollectionBuiltinDescriptor(name)?.infer;
  const result = handlerKey
    ? collectionInferenceHandlers[handlerKey](session, expectedReturnType)
    : signature.returnType;

  session.finish();
  return result;
}

class CollectionArgumentSession {
  public readonly binding: RsglArgumentBinding<RsglParameterSymbol>;
  private readonly checked = new Set<ArgumentNode>();

  public constructor(
    public readonly context: RsglExpressionCheckContext,
    public readonly expression: CallExprNode,
    public readonly scope: RsglScope,
    signature: RsglSignature,
    public readonly host: RsglCollectionCheckHost
  ) {
    this.binding = bindRsglArguments(signature.parameters, expression.args, {
      callRange: expression.range
    });
    context.diagnostics.push(...this.binding.diagnostics);
  }

  public primary(name: string): RsglArgumentAssignment<RsglParameterSymbol> | undefined {
    return this.binding.primaryAssignments.find(assignment => assignment.parameter.name === name);
  }

  public rest(name: string): RsglArgumentAssignment<RsglParameterSymbol>[] {
    return this.binding.restAssignments.filter(assignment =>
      assignment.parameter.name === name && !assignment.duplicate
    );
  }

  public check(
    assignment: RsglArgumentAssignment<RsglParameterSymbol>,
    expectedType?: RsglType
  ): RsglType {
    this.checked.add(assignment.arg);
    return expectedType
      ? this.host.checkExpressionForExpectedType(
        this.context,
        assignment.arg.value,
        this.scope,
        expectedType
      )
      : this.host.checkExpression(this.context, assignment.arg.value, this.scope);
  }

  public checkExpected(
    assignment: RsglArgumentAssignment<RsglParameterSymbol>,
    expectedType: RsglType
  ): RsglType {
    const actualType = this.check(assignment, expectedType);
    this.host.checkAssignable(this.context, expectedType, comparableType(actualType), assignment.arg.value);
    return actualType;
  }

  public markChecked(assignment: RsglArgumentAssignment<RsglParameterSymbol>): void {
    this.checked.add(assignment.arg);
  }

  public finish(): void {
    for (const assignment of this.binding.assignments) {
      if (!this.checked.has(assignment.arg)) {
        this.check(assignment);
      }
    }
    for (const arg of this.binding.unmatchedArgs) {
      if (!this.checked.has(arg)) {
        this.checked.add(arg);
        this.host.checkExpression(this.context, arg.value, this.scope);
      }
    }
  }
}

function checkAsList(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const expectedElement = expectedListElement(expectedReturnType);
  const value = session.primary("value");
  if (!value) {
    return listOf(expectedElement ?? unknownType);
  }

  const actualType = expectedElement
    ? session.checkExpected(value, asListInputOf(expectedElement))
    : session.check(value);
  if (!isPotentialAsListInput(actualType)) {
    reportCollectionExpected(
      session,
      value.arg.value,
      "a List, Range, or scalar value",
      actualType
    );
  }
  const inferredElement = asListElementType(session, actualType);
  return listOf(expectedElement ?? inferredElement);
}

function checkLength(session: CollectionArgumentSession): RsglType {
  const source = session.primary("source");
  if (source) {
    checkIterableArgument(session, source);
  }
  return numberType;
}

function checkMap(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const diagnosticStart = session.context.diagnostics.length;
  const source = session.primary("source");
  const sourceElement = source
    ? checkIterableArgument(session, source)
    : unknownType;
  const expectedElement = expectedListElement(expectedReturnType);
  const mapper = session.primary("mapper");
  const mapperReturn = mapper
    ? checkUnaryMapper(session, mapper, sourceElement, expectedElement, "map")
    : unknownType;
  const resultElement = expectedElement ?? mapperReturn;
  if (
    !isInferableType(resultElement)
    && session.binding.diagnostics.length === 0
    && session.context.diagnostics.length === diagnosticStart
  ) {
    reportCannotInfer(session, "map result element type");
  }
  return listOf(inferredOrUnknown(resultElement));
}

function checkFilter(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const expectedElement = expectedListElement(expectedReturnType);
  const source = session.primary("source");
  const sourceElement = source
    ? checkIterableArgument(session, source, expectedElement)
    : unknownType;
  const resultElement = expectedElement ?? sourceElement;
  const predicate = session.primary("predicate");
  if (predicate) {
    checkUnaryMapper(session, predicate, resultElement, booleanType, "filter");
  }
  return listOf(resultElement);
}

function checkFlatMap(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const diagnosticStart = session.context.diagnostics.length;
  const source = session.primary("source");
  const sourceElement = source
    ? checkIterableArgument(session, source)
    : unknownType;
  const expectedElement = expectedListElement(expectedReturnType);
  const mapper = session.primary("mapper");
  const mapperDiagnosticStart = session.context.diagnostics.length;
  const mapperReturn = mapper
    ? checkUnaryMapper(
      session,
      mapper,
      sourceElement,
      expectedElement ? iterableOf(expectedElement) : undefined,
      "flatMap"
    )
    : unknownType;
  const inferredElement = mapper
    ? iterableElementType(
      session,
      mapperReturn,
      mapper.arg.value,
      true,
      "mapper",
      session.context.diagnostics.length === mapperDiagnosticStart
    )
    : unknownType;
  const resultElement = expectedElement ?? inferredElement;
  if (
    !isInferableType(resultElement)
    && session.binding.diagnostics.length === 0
    && session.context.diagnostics.length === diagnosticStart
  ) {
    reportCannotInfer(session, "flatMap result element type");
  }
  return listOf(inferredOrUnknown(resultElement));
}

function checkConcat(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const diagnosticStart = session.context.diagnostics.length;
  const expectedElement = expectedListElement(expectedReturnType);
  const sources = session.rest("sources");
  const inferredElements = sources.map(source =>
    checkIterableArgument(session, source, expectedElement)
  );
  const inferredElement = combineInformativeTypes(session, inferredElements);
  const resultElement = expectedElement ?? inferredElement;
  if (
    !isInferableType(resultElement)
    && session.binding.diagnostics.length === 0
    && session.context.diagnostics.length === diagnosticStart
  ) {
    reportCannotInfer(session, "concat element type");
  }
  return listOf(resultElement.kind === "Unknown" && inferredElements.every(isNeverType)
    ? neverType
    : resultElement);
}

function checkJoin(session: CollectionArgumentSession): RsglType {
  const source = session.primary("source");
  if (source) {
    const diagnosticStart = session.context.diagnostics.length;
    const actualType = session.check(source, listOf(stringType));
    if (
      !isDynamicType(actualType)
      && !isAssignable(listOf(stringType), actualType)
      && session.context.diagnostics.length === diagnosticStart
    ) {
      reportCollectionExpected(session, source.arg.value, "List<String>", actualType);
    }
  }
  const separator = session.primary("separator");
  if (separator) {
    session.checkExpected(separator, stringType);
  }
  return stringType;
}

function checkRecordProjection(
  session: CollectionArgumentSession,
  operation: "entries" | "keys" | "values"
): RsglType {
  const object = session.primary("object");
  if (!object) {
    return listOf(unknownType);
  }
  const type = session.check(object);
  const records = recordArms(session, type, object.arg.value);
  if (records === undefined) {
    return listOf(unknownType);
  }
  if (records.length === 0) {
    return listOf(type.kind === "Any" ? anyType : unknownType);
  }
  const elementTypes = records.flatMap(record => recordProjectionElements(record, operation));
  return inferListType(
    elementTypes,
    inferredUnionBudgetOptions(session.context.diagnostics, session.expression.range)
  );
}

function checkMergeObjects(
  session: CollectionArgumentSession,
  expectedReturnType: RsglType | undefined
): RsglType {
  const expectedRecord = expectedObjectType(expectedReturnType);
  const objects = session.rest("objects");
  let alternatives: RsglType[] = [{ kind: "Object", properties: new Map(), open: false }];
  let hasDynamicInput = false;
  const unionBudget = inferredUnionBudgetOptions(
    session.context.diagnostics,
    session.expression.range
  );
  const expectedProjection = expectedRecord
    ? optionalObjectProjection(expectedRecord)
    : undefined;

  for (const object of objects) {
    let actualType: RsglType;
    if (expectedProjection && object.arg.value.kind === "ObjectExpr") {
      session.markChecked(object);
      actualType = session.host.checkContextualObjectExpression(
        session.context,
        object.arg.value,
        session.scope,
        expectedProjection
      );
    } else {
      actualType = session.check(object, expectedProjection);
    }
    const records = recordArms(session, actualType, object.arg.value);
    if (records === undefined) {
      continue;
    }
    if (records.length === 0) {
      hasDynamicInput = true;
      continue;
    }
    alternatives = mergeObjectTypeAlternatives({
      context: session.context,
      range: session.expression.range
    }, alternatives, records);
  }

  if (objects.length === 0) {
    if (!expectedRecord && session.binding.diagnostics.length === 0) {
      reportCannotInfer(session, "mergeObjects result type");
    }
    return { kind: "Object", properties: new Map(), open: false };
  }
  if (hasDynamicInput) {
    return expectedRecord ?? { kind: "Object", properties: new Map(), indexType: anyType, open: true };
  }
  return combineRsglTypes(
    alternatives,
    false,
    unionBudget
  );
}

function checkHas(session: CollectionArgumentSession): RsglType {
  const object = session.primary("object");
  if (object) {
    const actualType = session.check(object);
    recordArms(session, actualType, object.arg.value, true);
  }
  const key = session.primary("key");
  if (key) {
    session.checkExpected(key, stringType);
  }
  return booleanType;
}

function checkProduct(session: CollectionArgumentSession): RsglType {
  const source = session.primary("source");
  if (!source) {
    return listOf(jsonType);
  }
  const sourceType = session.check(source, jsonType);
  const product = inferProductType(
    sourceType,
    inferredUnionBudgetOptions(session.context.diagnostics, session.expression.range)
  );
  reportProductSourceIssues(session, product.issues);
  return product.type;
}

function reportProductSourceIssues(
  session: CollectionArgumentSession,
  issues: readonly RsglProductSourceIssue[]
): void {
  for (const issue of issues) {
    const subject = issue.propertyName
      ? `Product dimension '${issue.propertyName}'`
      : "Product source";
    session.context.diagnostics.push(diagnostic(
      "rsgl.productSourceNotIterable",
      `${subject} must be a List or Range, got ${formatType(issue.actualType)}.`,
      issue.declarationRange ?? session.expression.range
    ));
  }
}

function checkIterableArgument(
  session: CollectionArgumentSession,
  assignment: RsglArgumentAssignment<RsglParameterSymbol>,
  contextualElement?: RsglType
): RsglType {
  const expectedElement = contextualElement;
  const expectedType = expectedElement ? iterableOf(expectedElement) : undefined;
  const diagnosticStart = session.context.diagnostics.length;
  const actualType = session.check(assignment, expectedType);
  let mismatchOwned = session.context.diagnostics.length > diagnosticStart;
  if (
    expectedType
    && expectedElement
    && !isDynamicType(actualType)
    && !isAssignable(expectedType, actualType)
  ) {
    if (!mismatchOwned) {
      reportCollectionExpected(
        session,
        assignment.arg.value,
        `Iterable<${formatType(expectedElement)}>`,
        actualType
      );
    }
    mismatchOwned = true;
  }
  return iterableElementType(
    session,
    actualType,
    assignment.arg.value,
    true,
    "source",
    !mismatchOwned
  );
}

function checkUnaryMapper(
  session: CollectionArgumentSession,
  assignment: RsglArgumentAssignment<RsglParameterSymbol>,
  parameterType: RsglType,
  expectedReturnType: RsglType | undefined,
  operation: "map" | "filter" | "flatMap"
): RsglType {
  const expression = assignment.arg.value;
  const expectedFunction: RsglType = {
    kind: "Function",
    parameters: [parameterType],
    ...(expectedReturnType ? { returnType: expectedReturnType } : {})
  };
  const diagnosticStart = session.context.diagnostics.length;
  let actualType: RsglType;

  if (expression.kind === "LambdaExpr") {
    session.markChecked(assignment);
    actualType = checkLambdaExpression(
      session.context,
      expression,
      session.scope,
      expectedFunction,
      (body, bodyScope, expectedBodyType) => expectedBodyType
        ? session.host.checkExpressionForExpectedType(
          session.context,
          body,
          bodyScope,
          expectedBodyType
        )
        : session.host.checkExpression(session.context, body, bodyScope),
      {
        returnMismatchCode: operation === "filter"
          ? "rsgl.predicateMustReturnBoolean"
          : "rsgl.mapperReturnTypeMismatch",
        returnMismatchMessage: (expected, actual) => operation === "filter"
          ? `filter predicate must return Boolean, got ${formatType(actual)}.`
          : `${operation} mapper must return ${formatType(expected)}, got ${formatType(actual)}.`,
        preserveActualReturnType: true
      }
    );
  } else {
    actualType = session.check(assignment);
  }

  if (actualType.kind === "Unknown" || actualType.kind === "Any") {
    return actualType;
  }
  if (actualType.kind !== "Function") {
    if (session.context.diagnostics.length === diagnosticStart) {
      reportMapperMismatch(session, operation, expression, expectedReturnType, actualType);
    }
    return unknownType;
  }
  if (actualType.parameters && actualType.parameters.length !== 1) {
    if (session.context.diagnostics.length === diagnosticStart) {
      session.context.diagnostics.push(diagnostic(
        "rsgl.lambdaArityMismatch",
        `Expected 1 lambda parameter, got ${actualType.parameters.length}.`,
        expression.range
      ));
    }
  } else if (
    actualType.parameters?.[0]
    && !isDynamicType(parameterType)
    && !isAssignable(actualType.parameters[0], parameterType)
  ) {
    session.context.diagnostics.push(diagnostic(
      "rsgl.mapperReturnTypeMismatch",
      `${operation} mapper cannot accept ${formatType(parameterType)} values.`,
      expression.range
    ));
  }
  const actualReturnType = actualType.returnType ?? unknownType;
  if (
    expectedReturnType
    && !isDynamicType(actualReturnType)
    && !isAssignable(expectedReturnType, actualReturnType)
    && session.context.diagnostics.length === diagnosticStart
  ) {
    reportMapperMismatch(session, operation, expression, expectedReturnType, actualReturnType);
  }
  return actualReturnType;
}

function iterableElementType(
  session: CollectionArgumentSession,
  type: RsglType,
  node: RsglNode,
  allowRange: boolean,
  role: "source" | "mapper",
  reportMismatch = true
): RsglType {
  if (type.kind === "List") {
    return type.elementType ?? unknownType;
  }
  if (type.kind === "Range" && allowRange) {
    return numberType;
  }
  if (type.kind === "Union") {
    const elements: RsglType[] = [];
    let invalid = false;
    for (const option of type.options ?? []) {
      if (option.kind === "List") {
        elements.push(option.elementType ?? unknownType);
      } else if (option.kind === "Range" && allowRange) {
        elements.push(numberType);
      } else if (!isDynamicType(option) && option.kind !== "Never") {
        invalid = true;
      }
    }
    if (invalid && reportMismatch) {
      reportIterableMismatch(session, role, node, type);
    }
    return combineInformativeTypes(session, elements);
  }
  if (isDynamicType(type)) {
    return type;
  }
  if (type.kind === "Never") {
    return neverType;
  }
  if (reportMismatch) {
    reportIterableMismatch(session, role, node, type);
  }
  return unknownType;
}

function recordArms(
  session: CollectionArgumentSession,
  type: RsglType,
  node: RsglNode,
  allowAbsent = false
): RsglType[] | undefined {
  if (type.kind === "Object") {
    return [type];
  }
  if (isDynamicType(type)) {
    return [];
  }
  if (type.kind === "Union") {
    const records: RsglType[] = [];
    let invalid = false;
    for (const option of type.options ?? []) {
      if (option.kind === "Object") {
        records.push(option);
      } else if (
        allowAbsent
        && (option.kind === "Null" || option.kind === "Missing" || option.kind === "Never")
      ) {
        continue;
      } else if (!isDynamicType(option) && option.kind !== "Never") {
        invalid = true;
      }
    }
    if (!invalid) {
      return records;
    }
  }
  reportCollectionExpected(session, node, "Object record", type);
  return undefined;
}

function expectedListElement(type: RsglType | undefined): RsglType | undefined {
  if (type?.kind === "List") {
    return type.elementType ?? unknownType;
  }
  if (type?.kind !== "Union") {
    return undefined;
  }
  const lists = (type.options ?? []).filter(option => option.kind === "List");
  return lists.length === 1 ? lists[0].elementType ?? unknownType : undefined;
}

function asListElementType(
  session: CollectionArgumentSession,
  type: RsglType
): RsglType {
  if (type.kind === "List") {
    return normalizeNestedAsListType(session, type.elementType ?? unknownType);
  }
  if (type.kind === "Range") {
    return numberType;
  }
  if (type.kind !== "Union") {
    return type;
  }
  return normalizeNestedAsListType(session, combineRsglTypes(
    (type.options ?? []).map(option => asListElementType(session, option)),
    false,
    inferredUnionBudgetOptions(session.context.diagnostics, session.expression.range)
  ));
}

/**
 * Keeps nested collection structure while coalescing homogeneous List union
 * branches into one List whose element type is the union of each branch.
 * This is intentionally scoped to asList: general unions retain their branch
 * correlation elsewhere in the type system.
 */
function normalizeNestedAsListType(
  session: CollectionArgumentSession,
  type: RsglType
): RsglType {
  if (type.kind === "List") {
    return {
      ...type,
      elementType: normalizeNestedAsListType(session, type.elementType ?? unknownType)
    };
  }
  if (type.kind !== "Union") {
    return type;
  }

  const options = (type.options ?? []).map(option => normalizeNestedAsListType(session, option));
  const unionBudget = inferredUnionBudgetOptions(
    session.context.diagnostics,
    session.expression.range
  );
  if (options.length > 0 && options.every(option => option.kind === "List")) {
    return listOf(normalizeNestedAsListType(session, combineRsglTypes(
      options.map(option => option.elementType ?? unknownType),
      false,
      unionBudget
    )));
  }
  return combineRsglTypes(options, false, unionBudget);
}

function asListInputOf(elementType: RsglType): RsglType {
  const options = [elementType, listOf(elementType)];
  if (isAssignable(elementType, numberType)) {
    options.push({ kind: "Range", elementType: numberType });
  }
  return combineRsglTypes(options);
}

function isPotentialAsListInput(type: RsglType): boolean {
  if (type.kind === "Union") {
    return (type.options ?? []).every(isPotentialAsListInput);
  }
  return type.kind === "List"
    || type.kind === "Range"
    || type.kind === "String"
    || type.kind === "Number"
    || type.kind === "Boolean"
    || type.kind === "Null"
    || type.kind === "Path"
    || type.kind === "ResourceId"
    || type.kind === "ModelId"
    || type.kind === "TextureId"
    || type.kind === "TextureVariable"
    || type.kind === "TextureRef"
    || type.kind === "Any"
    || type.kind === "Unknown"
    || type.kind === "TypeParameter"
    || type.kind === "Json"
    || type.kind === "Never";
}

function iterableOf(elementType: RsglType): RsglType {
  const options: RsglType[] = [listOf(elementType)];
  if (isAssignable(elementType, numberType)) {
    options.push({ kind: "Range", elementType: numberType });
  }
  return options.length === 1 ? options[0] : { kind: "Union", options };
}

function listOf(elementType: RsglType): RsglType {
  return { kind: "List", elementType };
}

function combineInformativeTypes(
  session: CollectionArgumentSession,
  types: readonly RsglType[]
): RsglType {
  const informative = types.filter(type => type.kind !== "Never");
  return informative.length === 0
    ? neverType
    : combineRsglTypes(
      informative,
      false,
      inferredUnionBudgetOptions(session.context.diagnostics, session.expression.range)
    );
}

function comparableType(type: RsglType): RsglType {
  return type.kind === "Unknown" ? anyType : type;
}

function isDynamicType(type: RsglType): boolean {
  return type.kind === "Unknown" || type.kind === "Any" || type.kind === "TypeParameter";
}

function isInferableType(type: RsglType): boolean {
  return type.kind !== "Unknown" && type.kind !== "Never" && type.kind !== "TypeParameter";
}

function inferredOrUnknown(type: RsglType): RsglType {
  return isInferableType(type) ? type : unknownType;
}

function isNeverType(type: RsglType): boolean {
  return type.kind === "Never";
}

function reportCannotInfer(session: CollectionArgumentSession, subject: string): void {
  session.context.diagnostics.push(diagnostic(
    "rsgl.cannotInferCollectionType",
    `Cannot infer ${subject}; add a contextual List type or a typed collection argument.`,
    session.expression.range
  ));
}

function reportIterableMismatch(
  session: CollectionArgumentSession,
  role: "source" | "mapper",
  node: RsglNode,
  actualType: RsglType
): void {
  if (role === "mapper") {
    session.context.diagnostics.push(diagnostic(
      "rsgl.mapperReturnTypeMismatch",
      `flatMap mapper must return a List or Range, got ${formatType(actualType)}.`,
      node.range
    ));
    return;
  }
  reportCollectionExpected(session, node, "List or Range", actualType);
}

function reportMapperMismatch(
  session: CollectionArgumentSession,
  operation: "map" | "filter" | "flatMap",
  node: RsglNode,
  expectedType: RsglType | undefined,
  actualType: RsglType
): void {
  const code = operation === "filter"
    ? "rsgl.predicateMustReturnBoolean"
    : "rsgl.mapperReturnTypeMismatch";
  const expected = operation === "filter"
    ? "Boolean"
    : expectedType ? formatType(expectedType) : "a value";
  session.context.diagnostics.push(diagnostic(
    code,
    `${operation} mapper must return ${expected}, got ${formatType(actualType)}.`,
    node.range
  ));
}

function reportCollectionExpected(
  session: CollectionArgumentSession,
  node: RsglNode,
  expected: string,
  actualType: RsglType
): void {
  session.context.diagnostics.push(diagnostic(
    "rsgl.collectionExpected",
    `Expected ${expected}, got ${formatType(actualType)}.`,
    node.range
  ));
}
