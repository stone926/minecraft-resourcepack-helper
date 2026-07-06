import {
  ExprNode,
  ModelElementStmtNode,
  ModelFaceClauseNode,
  ModelGeometryPropertyNode,
  ModelTextureStmtNode,
  ResourceStatementNode,
  TextRange
} from "../parser";
import { EvaluationContext, evaluateExpression } from "./evaluate";
import { JsonValue } from "./ir";
import { ResourceBodyFragment, ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";

export interface ModelGeometryDslOptions {
  onError?: (code: string, message: string, range: TextRange) => void;
}

type Axis = "x" | "y" | "z";
type FaceDirection = "down" | "up" | "north" | "south" | "west" | "east";

interface FaceField {
  value: JsonValue;
  range: TextRange;
}

interface FaceEntry {
  range: TextRange;
  fields: Map<string, FaceField>;
}

interface CompiledElement {
  element: Record<string, JsonValue>;
  fieldRanges: Map<string, TextRange>;
  faces: Map<FaceDirection, FaceEntry>;
  mirrorAxes: Axis[];
  translate?: number[];
}

const faceDirections: FaceDirection[] = ["down", "up", "north", "south", "west", "east"];
const faceDirectionSet = new Set<string>(faceDirections);
const elementFields = new Set(["rotation", "shade", "light_emission"]);
const faceFields = new Set(["texture", "uv", "cullface", "rotation", "tintindex"]);
const transformFields = new Set(["mirror", "translate"]);
const axisIndexes: Record<Axis, number> = { x: 0, y: 1, z: 2 };
const oppositeFaces: Record<Axis, Partial<Record<FaceDirection, FaceDirection>>> = {
  x: { east: "west", west: "east" },
  y: { up: "down", down: "up" },
  z: { north: "south", south: "north" }
};

export function compileModelGeometryStatement(
  statement: ResourceStatementNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions = {}
): ResourceBodyFragment | undefined {
  if (statement.kind === "ModelTextureStmt") {
    return compileModelTextureStatement(statement, context);
  }
  if (statement.kind !== "ModelElementStmt") {
    return undefined;
  }
  const compiled = compileElement(statement, context, options);
  if (!compiled) {
    return undefined;
  }

  const elements = expandMirroredElements(compiled);
  const mappings: ResourceBodyMapping[] = [
    mapping("/elements", statement.range, context)
  ];
  elements.forEach((element, index) => {
    mappings.push(...elementMappings(element, index, statement.range, context));
  });
  return { content: { elements: elements.map(element => element.element) }, mappings };
}

function compileModelTextureStatement(
  statement: ModelTextureStmtNode,
  context: EvaluationContext
): ResourceBodyFragment {
  const key = statement.key.text;
  return {
    content: {
      textures: {
        [key]: normalizeJsonValue(evaluateExpression(statement.value, context))
      }
    },
    mappings: [
      mapping("/textures", statement.range, context),
      mapping(appendGeneratedPath("/textures", key), statement.value.range, context)
    ]
  };
}

function compileElement(
  statement: ModelElementStmtNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): CompiledElement | null {
  const from = vector3(statement.from, "Model element from", statement.range, context, options);
  const to = vector3(statement.to, "Model element to", statement.range, context, options);
  if (!from || !to) {
    return null;
  }

  const compiled: CompiledElement = {
    element: { from, to },
    fieldRanges: new Map([
      ["from", statement.from?.range ?? statement.range],
      ["to", statement.to?.range ?? statement.range]
    ]),
    faces: new Map(),
    mirrorAxes: []
  };

  for (const property of statement.properties) {
    applyElementProperty(compiled, property, context, options);
  }
  for (const face of statement.faces) {
    applyFaceClause(compiled, face, context, options);
  }

  if (compiled.faces.size > 0) {
    compiled.element.faces = facesToJson(compiled.faces);
  }
  if (compiled.translate) {
    translateElement(compiled.element, compiled.translate);
  }
  return compiled;
}

function applyElementProperty(
  compiled: CompiledElement,
  property: ModelGeometryPropertyNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): void {
  const name = property.name.text;
  if (elementFields.has(name)) {
    compiled.element[name] = normalizeJsonValue(evaluateExpression(property.value, context));
    compiled.fieldRanges.set(name, property.value.range);
    return;
  }
  if (faceFields.has(name)) {
    const field = faceField(property, context);
    for (const direction of faceDirections) {
      setFaceField(compiled.faces, direction, property.range, name, field);
    }
    return;
  }
  if (name === "translate") {
    compiled.translate = vector3(property.value, "Model element translate", property.range, context, options) ?? undefined;
    return;
  }
  if (name === "mirror") {
    compiled.mirrorAxes.push(...mirrorAxes(property.value, context, options));
    return;
  }
  if (transformFields.has(name)) {
    return;
  }
  options.onError?.("rsgl.unknownModelElementProperty", `Unknown model element property '${name}'.`, property.name.range);
}

function applyFaceClause(
  compiled: CompiledElement,
  clause: ModelFaceClauseNode,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): void {
  const targets = clause.target.text === "all"
    ? faceDirections
    : faceDirectionSet.has(clause.target.text)
      ? [clause.target.text as FaceDirection]
      : [];
  if (targets.length === 0) {
    options.onError?.("rsgl.invalidModelFaceTarget", `Invalid model face target '${clause.target.text}'.`, clause.target.range);
    return;
  }

  for (const property of clause.properties) {
    const name = property.name.text;
    if (!faceFields.has(name)) {
      options.onError?.("rsgl.unknownModelFaceProperty", `Unknown model face property '${name}'.`, property.name.range);
      continue;
    }
    const field = faceField(property, context);
    for (const target of targets) {
      setFaceField(compiled.faces, target, clause.range, name, field);
    }
  }
}

function faceField(property: ModelGeometryPropertyNode, context: EvaluationContext): FaceField {
  return {
    value: normalizeJsonValue(evaluateExpression(property.value, context)),
    range: property.value.range
  };
}

function setFaceField(
  faces: Map<FaceDirection, FaceEntry>,
  direction: FaceDirection,
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

function expandMirroredElements(compiled: CompiledElement): CompiledElement[] {
  const axes = uniqueAxes(compiled.mirrorAxes);
  const combinations = mirrorAxisCombinations(axes);
  return combinations.map(combo => mirrorCompiledElement(compiled, combo));
}

function mirrorCompiledElement(compiled: CompiledElement, axes: Axis[]): CompiledElement {
  const element = cloneJsonObject(compiled.element);
  const faces = cloneFaces(compiled.faces);
  for (const axis of axes) {
    mirrorElementOnAxis(element, axis);
    mirrorFacesOnAxis(faces, axis);
  }
  if (faces.size > 0) {
    element.faces = facesToJson(faces);
  }
  return {
    element,
    fieldRanges: compiled.fieldRanges,
    faces,
    mirrorAxes: []
  };
}

function mirrorAxisCombinations(axes: Axis[]): Axis[][] {
  return axes.reduce<Axis[][]>(
    (combinations, axis) => [...combinations, ...combinations.map(combo => [...combo, axis])],
    [[]]
  );
}

function uniqueAxes(axes: Axis[]): Axis[] {
  return axes.filter((axis, index) => axes.indexOf(axis) === index);
}

function mirrorElementOnAxis(element: Record<string, JsonValue>, axis: Axis): void {
  const index = axisIndexes[axis];
  const from = numberVectorValue(element.from);
  const to = numberVectorValue(element.to);
  if (from && to) {
    const nextFrom = [...from];
    const nextTo = [...to];
    nextFrom[index] = 16 - to[index];
    nextTo[index] = 16 - from[index];
    element.from = nextFrom;
    element.to = nextTo;
  }

  const rotation = jsonObject(element.rotation);
  const origin = numberVectorValue(rotation?.origin);
  if (rotation && origin) {
    const nextOrigin = [...origin];
    nextOrigin[index] = 16 - origin[index];
    rotation.origin = nextOrigin;
  }
}

function translateElement(element: Record<string, JsonValue>, offset: number[]): void {
  const from = numberVectorValue(element.from);
  const to = numberVectorValue(element.to);
  if (from) {
    element.from = translateVector(from, offset);
  }
  if (to) {
    element.to = translateVector(to, offset);
  }
  const rotation = jsonObject(element.rotation);
  const origin = numberVectorValue(rotation?.origin);
  if (rotation && origin) {
    rotation.origin = translateVector(origin, offset);
  }
}

function translateVector(vector: number[], offset: number[]): number[] {
  return vector.map((value, index) => value + (offset[index] ?? 0));
}

function mirrorFacesOnAxis(faces: Map<FaceDirection, FaceEntry>, axis: Axis): void {
  const swaps = oppositeFaces[axis];
  const next = new Map<FaceDirection, FaceEntry>();
  for (const [direction, entry] of faces) {
    const target = swaps[direction] ?? direction;
    next.set(target, mirrorFaceEntry(entry, axis));
  }
  faces.clear();
  for (const [direction, entry] of next) {
    faces.set(direction, entry);
  }
}

function mirrorFaceEntry(entry: FaceEntry, axis: Axis): FaceEntry {
  const fields = new Map<string, FaceField>();
  for (const [name, field] of entry.fields) {
    fields.set(name, name === "cullface" && typeof field.value === "string"
      ? { ...field, value: oppositeFaces[axis][field.value as FaceDirection] ?? field.value }
      : field);
  }
  return { range: entry.range, fields };
}

function facesToJson(faces: Map<FaceDirection, FaceEntry>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const direction of faceDirections) {
    const entry = faces.get(direction);
    if (!entry) {
      continue;
    }
    const face: Record<string, JsonValue> = {};
    for (const [name, field] of entry.fields) {
      face[name] = field.value;
    }
    result[direction] = face;
  }
  return result;
}

function elementMappings(
  compiled: CompiledElement,
  index: number,
  elementRange: TextRange,
  context: EvaluationContext
): ResourceBodyMapping[] {
  const elementPath = appendGeneratedPath("/elements", String(index));
  const mappings: ResourceBodyMapping[] = [mapping(elementPath, elementRange, context)];
  for (const [field, range] of compiled.fieldRanges) {
    mappings.push(mapping(appendGeneratedPath(elementPath, field), range, context));
  }
  if (compiled.faces.size > 0) {
    const facesPath = appendGeneratedPath(elementPath, "faces");
    mappings.push(mapping(facesPath, elementRange, context));
    for (const [direction, entry] of compiled.faces) {
      const facePath = appendGeneratedPath(facesPath, direction);
      mappings.push(mapping(facePath, entry.range, context));
      for (const [field, value] of entry.fields) {
        mappings.push(mapping(appendGeneratedPath(facePath, field), value.range, context));
      }
    }
  }
  return mappings;
}

function mirrorAxes(value: ExprNode, context: EvaluationContext, options: ModelGeometryDslOptions): Axis[] {
  const evaluated = normalizeJsonValue(evaluateExpression(value, context));
  const values = Array.isArray(evaluated) ? evaluated : [evaluated];
  const result: Axis[] = [];
  for (const item of values) {
    if (item === "x" || item === "y" || item === "z") {
      result.push(item);
    } else {
      options.onError?.("rsgl.invalidModelElementMirror", "Model element mirror must be 'x', 'y', 'z', or a list of axes.", value.range);
      return [];
    }
  }
  return result;
}

function vector3(
  expression: ExprNode | undefined,
  label: string,
  fallbackRange: TextRange,
  context: EvaluationContext,
  options: ModelGeometryDslOptions
): number[] | null {
  if (!expression) {
    options.onError?.("rsgl.missingModelElementVector", `${label} must be a finite [x, y, z] number vector.`, fallbackRange);
    return null;
  }
  const value = normalizeJsonValue(evaluateExpression(expression, context));
  const vector = numberVectorValue(value);
  if (!vector || vector.length !== 3) {
    options.onError?.("rsgl.invalidModelElementVector", `${label} must be a finite [x, y, z] number vector.`, expression.range);
    return null;
  }
  return vector;
}

function numberVectorValue(value: JsonValue | undefined): number[] | null {
  return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item))
    ? value.map(item => Number(item))
    : null;
}

function cloneFaces(faces: Map<FaceDirection, FaceEntry>): Map<FaceDirection, FaceEntry> {
  const result = new Map<FaceDirection, FaceEntry>();
  for (const [direction, entry] of faces) {
    result.set(direction, { range: entry.range, fields: new Map(entry.fields) });
  }
  return result;
}

function cloneJsonObject(value: Record<string, JsonValue>): Record<string, JsonValue> {
  return JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}

function mapping(generatedPath: string, sourceRange: TextRange, context: EvaluationContext): ResourceBodyMapping {
  return { generatedPath, sourceRange, context };
}

function normalizeJsonValue(value: JsonValue | undefined): JsonValue {
  return value === undefined ? null : value;
}
