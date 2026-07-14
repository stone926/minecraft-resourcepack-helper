import {
  createQuarterTurnTransform,
  type ModelFaceDirection,
  type ModelVec3
} from "../../../mc-assets/src";
import {
  ExprNode,
  ModelElementStmtNode,
  ModelFaceClauseNode,
  ModelGeometryPropertyNode,
  ModelTextureStmtNode,
  ModelTransformStmtNode,
  ResourceBodyNode,
  ResourceStatementNode,
  TextRange
} from "../parser";
import { EvaluationContext } from "./evaluate";
import { EvaluationItemBudget } from "./evaluationItemBudget";
import { evaluatedRootOrigin } from "./evaluationProvenance";
import { JsonValue } from "./ir";
import { createJsonObject, setJsonObjectProperty } from "./jsonObjectProperties";
import {
  evaluateJsonExpression,
  evaluateJsonExpressionWithResult,
  type JsonValueSinkOptions
} from "./jsonValueLowerer";
import { isJsonObject } from "./jsonValues";
import {
  transformCompilerModelElement,
  type CompilerModelGeometryElement
} from "./modelGeometryTransform";
import { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath, joinGeneratedPath } from "./sourcePaths";

export interface ModelGeometryDslOptions extends JsonValueSinkOptions {
  compileModelBody?: (body: ResourceBodyNode, context: EvaluationContext) => ResourceBodyFragment;
}

interface FaceField {
  value: JsonValue;
  range: TextRange;
  validationOrigin?: ResourceBodyMapping["validationOrigin"];
}

interface FaceEntry {
  range: TextRange;
  fields: Map<string, FaceField>;
}

const faceDirections: readonly ModelFaceDirection[] = ["down", "up", "north", "south", "west", "east"];
const faceDirectionSet = new Set<string>(faceDirections);
const elementFields = new Set(["rotation", "shade", "light_emission"]);
const faceFields = new Set(["texture", "uv", "cullface", "rotation", "tintindex"]);

export function compileModelGeometryStatement(
  statement: ResourceStatementNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions = {}
): ResourceBodyFragment | undefined {
  if (statement.kind === "ModelTextureStmt") {
    return compileModelTextureStatement(statement, context, options);
  }
  if (statement.kind === "ModelTransformStmt") {
    return compileModelTransformStatement(statement, context, options);
  }
  if (statement.kind !== "ModelElementStmt") {
    return undefined;
  }
  const compiled = compileElement(statement, context, options);
  if (!compiled) {
    return undefined;
  }
  return elementFragment(compiled, statement.range, context);
}

function compileModelTextureStatement(
  statement: ModelTextureStmtNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): ResourceBodyFragment | undefined {
  const key = statement.key.text;
  const evaluated = evaluateJsonExpressionWithResult(
    statement.value,
    context,
    options,
    appendGeneratedPath("/textures", key)
  );
  if (!evaluated) {
    return undefined;
  }
  const { value } = evaluated;
  return {
    content: {
      textures: {
        [key]: value
      }
    },
    mappings: [
      mapping("/textures", statement.range, context),
      mapping(
        appendGeneratedPath("/textures", key),
        statement.value.range,
        context,
        evaluatedRootOrigin(evaluated.result)
      )
    ]
  };
}

function compileModelTransformStatement(
  statement: ModelTransformStmtNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): ResourceBodyFragment | undefined {
  if (!statement.axis) {
    context.onEvaluationFailure?.();
    return undefined;
  }
  const angle = evaluateJsonExpression(statement.angle, context, options, "/elements/@transform/angle");
  if (typeof angle !== "number" || !Number.isFinite(angle) || !Number.isInteger(angle / 90)) {
    reportInvalidGeometryRotation(
      options,
      context,
      statement.angle.range,
      "Geometry rotation angle must be an integer multiple of 90 degrees."
    );
    context.onEvaluationFailure?.();
    return undefined;
  }
  const pivot = vector3(
    statement.pivot,
    "Geometry transform pivot",
    statement.pivot.range,
    context,
    options,
    "/elements/@transform/around",
    "rsgl.unsupportedGeometryTransform"
  );
  if (!pivot) {
    context.onEvaluationFailure?.();
    return undefined;
  }
  if (!options.compileModelBody) {
    options.onError?.(
      "rsgl.unsupportedGeometryTransform",
      "The active compiler does not support nested model transform bodies.",
      statement.range,
      context.sourceFile
    );
    context.onEvaluationFailure?.();
    return undefined;
  }

  const body = options.compileModelBody(statement.body, context);
  const sourceElements = body.content.elements;
  if (sourceElements === undefined) {
    return body;
  }
  if (!Array.isArray(sourceElements)) {
    options.onError?.(
      "rsgl.unsupportedGeometryTransform",
      "A model transform body must produce an elements array.",
      statement.body.range,
      context.sourceFile
    );
    context.onEvaluationFailure?.();
    return undefined;
  }
  if (!consumeGeometryExpansion(context, sourceElements.length, statement.range, options)) {
    return undefined;
  }

  const transform = createQuarterTurnTransform(statement.axis, angle / 90, pivot);
  const transformedElements: CompilerModelGeometryElement[] = [];
  for (let index = 0; index < sourceElements.length; index++) {
    const sourceElement = sourceElements[index];
    if (!isJsonObject(sourceElement)) {
      options.onError?.(
        "rsgl.unsupportedGeometryTransform",
        "A model transform body may only produce object-valued model elements.",
        statement.body.range,
        context.sourceFile
      );
      context.onEvaluationFailure?.();
      return undefined;
    }
    const sourceMappings = mappingsForElement(body.mappings ?? [], index);
    if (!sourceMappings.some(candidate => candidate.generatedPath === "")) {
      sourceMappings.unshift(mapping("", statement.range, context));
    }
    const transformed = transformCompilerModelElement(
      { content: sourceElement, mappings: sourceMappings },
      transform,
      transformOptions(statement.range, context, options)
    );
    if (!transformed) {
      context.onEvaluationFailure?.();
      return undefined;
    }
    transformedElements.push(transformed);
  }

  const content = { ...body.content, elements: transformedElements.map(element => element.content) };
  const preservedMappings = (body.mappings ?? []).filter(candidate => !isIndexedElementMapping(candidate.generatedPath));
  if (!preservedMappings.some(candidate => candidate.generatedPath === "/elements")) {
    preservedMappings.push(mapping("/elements", statement.range, context));
  }
  transformedElements.forEach((element, index) => {
    preservedMappings.push(...prefixElementMappings(element.mappings, index));
  });
  return { content, mappings: preservedMappings };
}

function compileElement(
  statement: ModelElementStmtNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): CompilerModelGeometryElement | undefined {
  const from = vector3(statement.from, "Model element from", statement.range, context, options, "/elements/0/from");
  const to = vector3(statement.to, "Model element to", statement.range, context, options, "/elements/0/to");
  if (!from || !to) {
    return undefined;
  }

  const content = createJsonObject();
  content.from = from;
  content.to = to;
  const faces = new Map<ModelFaceDirection, FaceEntry>();
  const element: CompilerModelGeometryElement = {
    content,
    mappings: [
      mapping("", statement.range, context),
      mapping("/from", statement.from?.range ?? statement.range, context),
      mapping("/to", statement.to?.range ?? statement.range, context)
    ]
  };
  for (const property of statement.properties) {
    applyElementProperty(element, faces, property, context, options);
  }
  for (const face of statement.faces) {
    applyFaceClause(faces, face, context, options);
  }
  if (faces.size > 0) {
    content.faces = facesToJson(faces);
    element.mappings.push(mapping("/faces", statement.range, context));
    for (const [direction, entry] of faces) {
      const facePath = appendGeneratedPath("/faces", direction);
      element.mappings.push(mapping(facePath, entry.range, context));
      for (const [name, field] of entry.fields) {
        element.mappings.push(mapping(
          appendGeneratedPath(facePath, name),
          field.range,
          context,
          field.validationOrigin
        ));
      }
    }
  }
  return element;
}

function applyElementProperty(
  element: CompilerModelGeometryElement,
  faces: Map<ModelFaceDirection, FaceEntry>,
  property: ModelGeometryPropertyNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): void {
  const name = property.name.text;
  if (elementFields.has(name)) {
    const value = evaluateJsonExpression(property.value, context, options, appendGeneratedPath("/elements/0", name));
    if (value !== undefined) {
      setJsonObjectProperty(element.content, name, value);
      element.mappings.push(mapping(appendGeneratedPath("", name), property.value.range, context));
    }
    return;
  }
  if (faceFields.has(name)) {
    const field = faceField(
      property,
      context,
      options,
      appendGeneratedPath(appendGeneratedPath("/elements/0/faces", faceDirections[0]), name)
    );
    if (field) {
      for (const direction of faceDirections) {
        setFaceField(faces, direction, property.range, name, field);
      }
    }
    return;
  }
  options.onError?.(
    "rsgl.unknownModelElementProperty",
    `Unknown model element property '${name}'.`,
    property.name.range,
    context.sourceFile
  );
}

function applyFaceClause(
  faces: Map<ModelFaceDirection, FaceEntry>,
  clause: ModelFaceClauseNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): void {
  const targets = clause.target.text === "all"
    ? faceDirections
    : faceDirectionSet.has(clause.target.text)
      ? [clause.target.text as ModelFaceDirection]
      : [];
  if (targets.length === 0) {
    options.onError?.(
      "rsgl.invalidModelFaceTarget",
      `Invalid model face target '${clause.target.text}'.`,
      clause.target.range,
      context.sourceFile
    );
    return;
  }

  for (const property of clause.properties) {
    const name = property.name.text;
    if (!faceFields.has(name)) {
      options.onError?.(
        "rsgl.unknownModelFaceProperty",
        `Unknown model face property '${name}'.`,
        property.name.range,
        context.sourceFile
      );
      continue;
    }
    const field = faceField(
      property,
      context,
      options,
      appendGeneratedPath(appendGeneratedPath("/elements/0/faces", targets[0]), name)
    );
    if (field) {
      for (const target of targets) {
        setFaceField(faces, target, clause.range, name, field);
      }
    }
  }
}

function elementFragment(
  element: CompilerModelGeometryElement,
  sourceRange: TextRange,
  context: EvaluationContext
): ResourceBodyFragment {
  return {
    content: { elements: [element.content] },
    mappings: [
      mapping("/elements", sourceRange, context),
      ...prefixElementMappings(element.mappings, 0)
    ]
  };
}

function prefixElementMappings(mappings: readonly ResourceBodyMapping[], index: number): ResourceBodyMapping[] {
  const elementPath = appendGeneratedPath("/elements", String(index));
  return mappings.map(candidate => ({
    ...candidate,
    generatedPath: joinGeneratedPath(elementPath, candidate.generatedPath)
  }));
}

function mappingsForElement(mappings: readonly ResourceBodyMapping[], index: number): ResourceBodyMapping[] {
  const elementPath = appendGeneratedPath("/elements", String(index));
  return mappings
    .filter(candidate => candidate.generatedPath === elementPath || candidate.generatedPath.startsWith(`${elementPath}/`))
    .map(candidate => ({
      ...candidate,
      generatedPath: candidate.generatedPath.slice(elementPath.length)
    }));
}

function isIndexedElementMapping(generatedPath: string): boolean {
  return /^\/elements\/\d+(?:\/|$)/.test(generatedPath);
}

function transformOptions(
  fallbackRange: TextRange,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
) {
  return {
    fallbackRange,
    context,
    onError: options.onError
  };
}

function consumeGeometryExpansion(
  context: EvaluationContext,
  count: number,
  range: TextRange,
  options: ModelGeometryDslOptions
): boolean {
  context.evaluationItemBudget ??= new EvaluationItemBudget();
  const budget = context.evaluationItemBudget;
  if (budget.tryConsume(count)) {
    return true;
  }
  context.onEvaluationFailure?.();
  options.onError?.(
    "rsgl.geometryTransformExpansionLimit",
    `Geometry transform exceeds maxEvaluationItems=${budget.limit} `
      + `(consumed ${budget.consumed}, requested ${count}).`,
    range,
    context.sourceFile
  );
  return false;
}

function reportInvalidGeometryRotation(
  options: ModelGeometryDslOptions,
  context: EvaluationContext,
  range: TextRange,
  message: string
): void {
  options.onError?.("rsgl.invalidGeometryRotation", message, range, context.sourceFile);
}

function faceField(
  property: ModelGeometryPropertyNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions,
  generatedPath: string
): FaceField | undefined {
  const evaluated = evaluateJsonExpressionWithResult(property.value, context, options, generatedPath);
  return evaluated === undefined
    ? undefined
    : {
        value: evaluated.value,
        range: property.value.range,
        validationOrigin: evaluatedRootOrigin(evaluated.result)
      };
}

function setFaceField(
  faces: Map<ModelFaceDirection, FaceEntry>,
  direction: ModelFaceDirection,
  range: TextRange,
  name: string,
  field: FaceField
): void {
  let entry = faces.get(direction);
  if (!entry) {
    entry = { range, fields: new Map() };
    faces.set(direction, entry);
  }
  entry.fields.set(name, field);
}

function facesToJson(faces: ReadonlyMap<ModelFaceDirection, FaceEntry>): Record<string, JsonValue> {
  const result = createJsonObject();
  for (const direction of faceDirections) {
    const entry = faces.get(direction);
    if (!entry) {
      continue;
    }
    const face = createJsonObject();
    for (const [name, field] of entry.fields) {
      setJsonObjectProperty(face, name, field.value);
    }
    setJsonObjectProperty(result, direction, face);
  }
  return result;
}

function vector3(
  expression: ExprNode | undefined,
  label: string,
  fallbackRange: TextRange,
  context: EvaluationContext,
  options: ModelGeometryDslOptions,
  generatedPath: string,
  diagnosticCode = "rsgl.invalidModelElementVector"
): ModelVec3 | undefined {
  if (!expression) {
    options.onError?.(
      "rsgl.missingModelElementVector",
      `${label} must be a finite [x, y, z] number vector.`,
      fallbackRange,
      context.sourceFile
    );
    return undefined;
  }
  const value = evaluateJsonExpression(expression, context, options, generatedPath);
  if (value === undefined) {
    return undefined;
  }
  const vector = numberVectorValue(value);
  if (!vector) {
    options.onError?.(
      diagnosticCode,
      `${label} must be a finite [x, y, z] number vector.`,
      expression.range,
      context.sourceFile
    );
    return undefined;
  }
  return vector;
}

function numberVectorValue(value: JsonValue): ModelVec3 | undefined {
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item))
    ? [Number(value[0]), Number(value[1]), Number(value[2])]
    : undefined;
}

function mapping(
  generatedPath: string,
  sourceRange: TextRange,
  context: EvaluationContext,
  validationOrigin?: ResourceBodyMapping["validationOrigin"]
): ResourceBodyMapping {
  return { generatedPath, sourceRange, context, validationOrigin };
}
