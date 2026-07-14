import {
  IDENTITY_SIGNED_PERMUTATION_MATRIX,
  MODEL_FACE_DIRECTIONS,
  signedPermutationDeterminant,
  transformDirection,
  transformDirectedBounds,
  transformPoint,
  transformVector,
  type ModelAxis,
  type ModelFaceDirection,
  type ModelVec3,
  type SignedPermutationMatrix,
  type SignedPermutationTransform,
  type UvRect
} from "../../../mc-assets/src";
import type { TextRange } from "../parser";
import type { EvaluationContext } from "./evaluate";
import type { JsonValue } from "./ir";
import { createJsonObject, setJsonObjectProperty } from "./jsonObjectProperties";
import { cloneJsonObject, isJsonObject } from "./jsonValues";
import type { ResourceBodyMapping } from "./resourceBody";
import { appendGeneratedPath } from "./sourcePaths";
import { transformModelFaceUv } from "./modelGeometryUv";

export interface CompilerModelGeometryElement {
  content: Record<string, JsonValue>;
  /** JSON-pointer mappings relative to this element's root. */
  mappings: ResourceBodyMapping[];
}

export interface CompilerModelGeometryTransformOptions {
  fallbackRange: TextRange;
  context: EvaluationContext;
  onError?: (code: string, message: string, range: TextRange, fileName?: string) => void;
}

const faceDirectionSet = new Set<string>(MODEL_FACE_DIRECTIONS);
const axisNames: readonly ModelAxis[] = ["x", "y", "z"];

/** Transforms one model element and all geometry-dependent face fields atomically. */
export function transformCompilerModelElement(
  source: CompilerModelGeometryElement,
  transform: SignedPermutationTransform,
  options: CompilerModelGeometryTransformOptions
): CompilerModelGeometryElement | undefined {
  if (isIdentityTransform(transform)) {
    return {
      content: cloneJsonObject(source.content),
      mappings: source.mappings.map(mapping => ({ ...mapping }))
    };
  }

  const content = cloneJsonObject(source.content);
  const sourceFrom = modelVector(content.from);
  const sourceTo = modelVector(content.to);
  if (!sourceFrom || !sourceTo) {
    reportUnsupportedGeometry(
      options,
      "A geometry transform requires finite three-component element from/to vectors.",
      mappingRange(source.mappings, "/from") ?? mappingRange(source.mappings, "/to")
    );
    return undefined;
  }

  const targetBounds = transformDirectedBounds(transform, sourceFrom, sourceTo);
  content.from = targetBounds.from;
  content.to = targetBounds.to;
  if (!transformElementRotation(content, source.mappings, transform, options)) {
    return undefined;
  }

  let mappings = source.mappings.map(mapping => ({ ...mapping }));
  const faces = content.faces;
  if (faces !== undefined) {
    if (!isJsonObject(faces)) {
      reportUnsupportedGeometry(
        options,
        "A geometry transform requires the element faces field to be an object.",
        mappingRange(source.mappings, "/faces")
      );
      return undefined;
    }
    const transformedFaces = transformFaces(
      faces,
      mappings,
      sourceFrom,
      sourceTo,
      targetBounds.from,
      targetBounds.to,
      transform,
      options
    );
    if (!transformedFaces) {
      return undefined;
    }
    content.faces = transformedFaces.faces;
    mappings = transformedFaces.mappings;
  }

  if (targetBounds.from.some(outOfModelBounds) || targetBounds.to.some(outOfModelBounds)) {
    options.onError?.(
      "rsgl.geometryTransformOutOfBounds",
      "Geometry transform produced element coordinates outside Minecraft's supported -16..32 range.",
      options.fallbackRange,
      options.context.sourceFile
    );
    return undefined;
  }
  return { content, mappings };
}

function transformElementRotation(
  element: Record<string, JsonValue>,
  mappings: readonly ResourceBodyMapping[],
  transform: SignedPermutationTransform,
  options: CompilerModelGeometryTransformOptions
): boolean {
  if (!("rotation" in element)) {
    return true;
  }
  const range = mappingRange(mappings, "/rotation");
  if (!isJsonObject(element.rotation)) {
    reportUnsupportedGeometry(options, "Element rotation must be an object before geometry can be transformed.", range);
    return false;
  }
  const rotation = cloneJsonObject(element.rotation);
  const origin = modelVector(rotation.origin);
  if (!origin) {
    reportUnsupportedGeometry(options, "Element rotation requires a finite origin before geometry can be transformed.", range);
    return false;
  }
  rotation.origin = transformPoint(transform, origin);

  if (!isIdentityMatrix(transform.matrix)) {
    const axis = rotation.axis;
    const angle = rotation.angle;
    if ((axis !== "x" && axis !== "y" && axis !== "z") || typeof angle !== "number" || !Number.isFinite(angle)) {
      reportUnsupportedGeometry(
        options,
        "Only finite element rotations around the x, y, or z axis can be transformed.",
        range
      );
      return false;
    }
    const axisVector = transformVector(transform.matrix, unitAxisVector(axis));
    const transformedAxis = signedAxisFromVector(axisVector);
    if (!transformedAxis) {
      reportUnsupportedGeometry(options, "Element rotation axis did not map to a Minecraft model axis.", range);
      return false;
    }
    rotation.axis = transformedAxis.axis;
    rotation.angle = normalizeZero(
      signedPermutationDeterminant(transform.matrix) * transformedAxis.sign * angle
    );
  }
  element.rotation = rotation;
  return true;
}

function transformFaces(
  sourceFaces: Record<string, JsonValue>,
  sourceMappings: ResourceBodyMapping[],
  sourceFrom: ModelVec3,
  sourceTo: ModelVec3,
  targetFrom: ModelVec3,
  targetTo: ModelVec3,
  transform: SignedPermutationTransform,
  options: CompilerModelGeometryTransformOptions
): { faces: Record<string, JsonValue>; mappings: ResourceBodyMapping[] } | undefined {
  const transformedByDirection = new Map<ModelFaceDirection, Record<string, JsonValue>>();
  const directionMap = new Map<ModelFaceDirection, ModelFaceDirection>();
  for (const [sourceName, sourceValue] of Object.entries(sourceFaces)) {
    if (!faceDirectionSet.has(sourceName)) {
      options.onError?.(
        "rsgl.invalidFaceDirection",
        `Cannot transform unknown model face direction '${sourceName}'.`,
        mappingRange(sourceMappings, appendGeneratedPath("/faces", sourceName)) ?? options.fallbackRange,
        options.context.sourceFile
      );
      return undefined;
    }
    const sourceDirection = sourceName as ModelFaceDirection;
    if (!isJsonObject(sourceValue)) {
      reportUnsupportedGeometry(
        options,
        `Model face '${sourceName}' must be an object before geometry can be transformed.`,
        mappingRange(sourceMappings, appendGeneratedPath("/faces", sourceName))
      );
      return undefined;
    }
    const targetDirection = transformDirection(transform, sourceDirection);
    const face = transformFace(
      sourceValue,
      sourceDirection,
      targetDirection,
      sourceFrom,
      sourceTo,
      targetFrom,
      targetTo,
      transform,
      sourceMappings,
      options
    );
    if (!face) {
      return undefined;
    }
    transformedByDirection.set(targetDirection, face);
    directionMap.set(sourceDirection, targetDirection);
  }

  const faces = createJsonObject();
  for (const direction of MODEL_FACE_DIRECTIONS) {
    const face = transformedByDirection.get(direction);
    if (face) {
      setJsonObjectProperty(faces, direction, face);
    }
  }
  const mappings = sourceMappings.map(mapping => ({
    ...mapping,
    generatedPath: remapFacePath(mapping.generatedPath, directionMap)
  }));
  addMaterializedFaceMappings(faces, mappings, directionMap, sourceMappings, options);
  return { faces, mappings };
}

function transformFace(
  source: Record<string, JsonValue>,
  sourceDirection: ModelFaceDirection,
  targetDirection: ModelFaceDirection,
  sourceFrom: ModelVec3,
  sourceTo: ModelVec3,
  targetFrom: ModelVec3,
  targetTo: ModelVec3,
  transform: SignedPermutationTransform,
  mappings: readonly ResourceBodyMapping[],
  options: CompilerModelGeometryTransformOptions
): Record<string, JsonValue> | undefined {
  const face = cloneJsonObject(source);
  const sourceFacePath = appendGeneratedPath("/faces", sourceDirection);
  const uvPath = appendGeneratedPath(sourceFacePath, "uv");
  const rotationPath = appendGeneratedPath(sourceFacePath, "rotation");
  const explicitUv = "uv" in source ? uvRect(source.uv) : undefined;
  if ("uv" in source && !explicitUv) {
    reportUnsupportedUv(options, "Face UV must be a finite four-component vector.", mappingRange(mappings, uvPath));
    return undefined;
  }
  const rotation = source.rotation;
  if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation))) {
    reportUnsupportedUv(options, "Face rotation must be 0, 90, 180, or 270.", mappingRange(mappings, rotationPath));
    return undefined;
  }

  const transformedUv = transformModelFaceUv({
    sourceDirection,
    targetDirection,
    sourceFrom,
    sourceTo,
    targetFrom,
    targetTo,
    transform,
    ...(explicitUv ? { explicitUv } : {}),
    ...(typeof rotation === "number" ? { rotation } : {})
  });
  if (!transformedUv.ok) {
    reportUnsupportedUv(
      options,
      transformedUv.reason === "invalidRotation"
        ? "Face rotation must be 0, 90, 180, or 270."
        : "Transformed face UV corners cannot be represented exactly by a Minecraft UV rectangle and quarter rotation.",
      mappingRange(mappings, rotationPath) ?? mappingRange(mappings, uvPath)
    );
    return undefined;
  }
  if (transformedUv.uv) {
    face.uv = transformedUv.uv;
  } else {
    delete face.uv;
  }
  if (transformedUv.rotation !== 0 || "rotation" in source) {
    face.rotation = transformedUv.rotation;
  } else {
    delete face.rotation;
  }

  if ("cullface" in source) {
    if (typeof source.cullface !== "string" || !faceDirectionSet.has(source.cullface)) {
      options.onError?.(
        "rsgl.invalidFaceDirection",
        `Cannot transform unknown cullface direction '${String(source.cullface)}'.`,
        mappingRange(mappings, appendGeneratedPath(sourceFacePath, "cullface")) ?? options.fallbackRange,
        options.context.sourceFile
      );
      return undefined;
    }
    face.cullface = transformDirection(transform, source.cullface as ModelFaceDirection);
  }
  return face;
}

function addMaterializedFaceMappings(
  faces: Record<string, JsonValue>,
  mappings: ResourceBodyMapping[],
  directionMap: ReadonlyMap<ModelFaceDirection, ModelFaceDirection>,
  sourceMappings: readonly ResourceBodyMapping[],
  options: CompilerModelGeometryTransformOptions
): void {
  for (const [sourceDirection, targetDirection] of directionMap) {
    const targetFace = faces[targetDirection];
    if (!isJsonObject(targetFace)) {
      continue;
    }
    const targetFacePath = appendGeneratedPath("/faces", targetDirection);
    const sourceFacePath = appendGeneratedPath("/faces", sourceDirection);
    for (const field of ["uv", "rotation"] as const) {
      if (!(field in targetFace)) {
        continue;
      }
      const targetPath = appendGeneratedPath(targetFacePath, field);
      if (mappings.some(mapping => mapping.generatedPath === targetPath)) {
        continue;
      }
      const sourceMapping = lastMappingAtPath(sourceMappings, sourceFacePath);
      mappings.push({
        generatedPath: targetPath,
        sourceRange: sourceMapping?.sourceRange ?? options.fallbackRange,
        context: sourceMapping?.context ?? options.context
      });
    }
  }
}

function remapFacePath(
  path: string,
  directionMap: ReadonlyMap<ModelFaceDirection, ModelFaceDirection>
): string {
  for (const [sourceDirection, targetDirection] of directionMap) {
    const sourcePrefix = appendGeneratedPath("/faces", sourceDirection);
    if (path === sourcePrefix || path.startsWith(`${sourcePrefix}/`)) {
      return `${appendGeneratedPath("/faces", targetDirection)}${path.slice(sourcePrefix.length)}`;
    }
  }
  return path;
}

function reportUnsupportedGeometry(
  options: CompilerModelGeometryTransformOptions,
  message: string,
  range?: TextRange
): void {
  options.onError?.(
    "rsgl.unsupportedGeometryTransform",
    message,
    range ?? options.fallbackRange,
    options.context.sourceFile
  );
}

function reportUnsupportedUv(
  options: CompilerModelGeometryTransformOptions,
  message: string,
  range?: TextRange
): void {
  options.onError?.(
    "rsgl.unsupportedGeometryUvTransform",
    message,
    range ?? options.fallbackRange,
    options.context.sourceFile
  );
}

function modelVector(value: JsonValue | undefined): ModelVec3 | undefined {
  return Array.isArray(value)
    && value.length === 3
    && value.every(item => typeof item === "number" && Number.isFinite(item))
    ? [Number(value[0]), Number(value[1]), Number(value[2])]
    : undefined;
}

function uvRect(value: JsonValue | undefined): UvRect | undefined {
  return Array.isArray(value)
    && value.length === 4
    && value.every(item => typeof item === "number" && Number.isFinite(item))
    ? [Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])]
    : undefined;
}

function unitAxisVector(axis: ModelAxis): ModelVec3 {
  return axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

function signedAxisFromVector(vector: ModelVec3): { axis: ModelAxis; sign: -1 | 1 } | undefined {
  const index = vector.findIndex(value => value !== 0);
  if (index === -1 || (vector[index] !== -1 && vector[index] !== 1)) {
    return undefined;
  }
  if (vector.some((value, candidate) => candidate !== index && value !== 0)) {
    return undefined;
  }
  return { axis: axisNames[index], sign: vector[index] as -1 | 1 };
}

function isIdentityTransform(transform: SignedPermutationTransform): boolean {
  return isIdentityMatrix(transform.matrix) && transform.translation.every(value => value === 0);
}

function isIdentityMatrix(matrix: SignedPermutationMatrix): boolean {
  return matrix.every((row, rowIndex) =>
    row.every((value, columnIndex) => value === IDENTITY_SIGNED_PERMUTATION_MATRIX[rowIndex][columnIndex])
  );
}

function outOfModelBounds(value: number): boolean {
  return value < -16 || value > 32;
}

function mappingRange(mappings: readonly ResourceBodyMapping[], path: string): TextRange | undefined {
  return lastMappingAtPath(mappings, path)?.sourceRange;
}

function lastMappingAtPath(
  mappings: readonly ResourceBodyMapping[],
  path: string
): ResourceBodyMapping | undefined {
  for (let index = mappings.length - 1; index >= 0; index--) {
    if (mappings[index].generatedPath === path) {
      return mappings[index];
    }
  }
  return undefined;
}

function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}
