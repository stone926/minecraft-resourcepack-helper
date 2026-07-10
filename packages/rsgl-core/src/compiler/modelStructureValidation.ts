import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { asObject, unitRange } from "./validationShared";

const displayContexts = new Set([
  "thirdperson_righthand",
  "thirdperson_lefthand",
  "firstperson_righthand",
  "firstperson_lefthand",
  "gui",
  "head",
  "ground",
  "fixed",
  "on_shelf"
]);

const faceNames = new Set(["down", "up", "north", "south", "west", "east"]);
const rotationAxes = new Set(["x", "y", "z"]);

export function validateModelStructure(
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  validateModelDisplay(content.display, unit, diagnostics);
  validateModelElements(content.elements, unit, diagnostics);
}

function validateModelDisplay(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }

  const display = asObject(value);
  if (!display) {
    diagnostics.push({
      code: "rsgl.invalidModelDisplay",
      message: "Model display must be an object keyed by display context.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  for (const [context, transformValue] of Object.entries(display)) {
    if (context === "__comment") {
      continue;
    }
    if (!displayContexts.has(context)) {
      diagnostics.push({
        code: "rsgl.invalidModelDisplayContext",
        message: `Model display context '${context}' is not recognized.`,
        severity: "warning",
        range: unitRange(unit)
      });
      continue;
    }
    validateModelDisplayTransform(context, transformValue, unit, diagnostics);
  }
}

function validateModelDisplayTransform(
  context: string,
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const transform = asObject(value);
  if (!transform) {
    diagnostics.push({
      code: "rsgl.invalidModelDisplayTransform",
      message: `Model display '${context}' must be an object.`,
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  validateFiniteVector(transform.rotation, 3, `Model display '${context}' rotation`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  const translation = validateFiniteVector(transform.translation, 3, `Model display '${context}' translation`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  if (translation && translation.some(value => value < -80 || value > 80)) {
    diagnostics.push({
      code: "rsgl.modelDisplayTranslationOutOfRange",
      message: `Model display '${context}' translation values outside [-80, 80] will be clamped by Minecraft.`,
      severity: "warning",
      range: unitRange(unit)
    });
  }

  const scale = validateFiniteVector(transform.scale, 3, `Model display '${context}' scale`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  if (scale && scale.some(value => value < 0 || value > 4)) {
    diagnostics.push({
      code: "rsgl.modelDisplayScaleOutOfRange",
      message: `Model display '${context}' scale values should be between 0 and 4.`,
      severity: "warning",
      range: unitRange(unit)
    });
  }
}

function validateModelElements(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: "rsgl.invalidModelElements",
      message: "Model elements must be an array.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  for (const element of value) {
    const elementObject = asObject(element);
    if (!elementObject) {
      diagnostics.push({
        code: "rsgl.invalidModelElement",
        message: "Model element entries must be objects.",
        severity: "error",
        range: unitRange(unit)
      });
      continue;
    }
    validateModelElementVector(elementObject.from, "from", unit, diagnostics);
    validateModelElementVector(elementObject.to, "to", unit, diagnostics);
    validateModelElementRotation(elementObject.rotation, unit, diagnostics);
    validateModelElementFlags(elementObject, unit, diagnostics);
    validateModelElementFaces(elementObject.faces, unit, diagnostics);
  }
}

function validateModelElementVector(
  value: JsonValue | undefined,
  name: "from" | "to",
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const vector = validateFiniteVector(value, 3, `Model element '${name}'`, "rsgl.invalidModelElementVector", unit, diagnostics, true);
  if (!vector) {
    return;
  }
  if (vector.some(item => item < -16 || item > 32)) {
    diagnostics.push({
      code: "rsgl.modelElementCoordinateOutOfRange",
      message: `Model element '${name}' coordinates must be between -16 and 32.`,
      severity: "warning",
      range: unitRange(unit)
    });
  }
}

function validateModelElementRotation(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const rotation = asObject(value);
  if (!rotation) {
    diagnostics.push({
      code: "rsgl.invalidModelElementRotation",
      message: "Model element rotation must be an object.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  validateFiniteVector(rotation.origin, 3, "Model element rotation origin", "rsgl.invalidModelElementRotationOrigin", unit, diagnostics);
  if ("axis" in rotation && (typeof rotation.axis !== "string" || !rotationAxes.has(rotation.axis))) {
    diagnostics.push({
      code: "rsgl.invalidModelElementRotationAxis",
      message: "Model element rotation axis must be 'x', 'y', or 'z'.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  if ("angle" in rotation && !isFiniteNumber(rotation.angle)) {
    diagnostics.push({
      code: "rsgl.invalidModelElementRotationAngle",
      message: "Model element rotation angle must be a finite number.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  for (const axis of ["x", "y", "z"]) {
    if (axis in rotation && !isFiniteNumber(rotation[axis])) {
      diagnostics.push({
        code: "rsgl.invalidModelElementRotationAngle",
        message: `Model element rotation ${axis} angle must be a finite number.`,
        severity: "error",
        range: unitRange(unit)
      });
    }
  }
  if ("rescale" in rotation && typeof rotation.rescale !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidModelElementRescale",
      message: "Model element rotation rescale must be a boolean.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  if (("axis" in rotation) !== ("angle" in rotation)) {
    diagnostics.push({
      code: "rsgl.incompleteModelElementRotation",
      message: "Legacy model element rotation must define axis and angle together.",
      severity: "error",
      range: unitRange(unit)
    });
  }
}

function validateModelElementFlags(
  element: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if ("shade" in element && typeof element.shade !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidModelElementShade",
      message: "Model element shade must be a boolean.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  if ("light_emission" in element && (!Number.isInteger(element.light_emission) || Number(element.light_emission) < 0 || Number(element.light_emission) > 15)) {
    diagnostics.push({
      code: "rsgl.invalidModelElementLightEmission",
      message: "Model element light_emission must be an integer between 0 and 15.",
      severity: "error",
      range: unitRange(unit)
    });
  }
}

function validateModelElementFaces(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const faces = asObject(value);
  if (!faces) {
    diagnostics.push({
      code: "rsgl.invalidModelElementFaces",
      message: "Model element faces must be an object.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  for (const [name, face] of Object.entries(faces)) {
    if (!faceNames.has(name)) {
      diagnostics.push({
        code: "rsgl.invalidModelFaceName",
        message: `Model element face '${name}' is not a valid face direction.`,
        severity: "warning",
        range: unitRange(unit)
      });
    }
    validateModelElementFace(face, unit, diagnostics);
  }
}

function validateModelElementFace(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const faceObject = asObject(value);
  if (!faceObject) {
    diagnostics.push({
      code: "rsgl.invalidModelFace",
      message: "Model element face entries must be objects.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }
  if ("texture" in faceObject && (typeof faceObject.texture !== "string" || !faceObject.texture.startsWith("#"))) {
    diagnostics.push({
      code: "rsgl.invalidModelFaceTexture",
      message: "Model element face texture must reference a texture variable starting with '#'.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  if ("rotation" in faceObject && !isValidFaceRotation(faceObject.rotation)) {
    diagnostics.push({
      code: "rsgl.invalidModelFaceRotation",
      message: "Model element face rotation must be one of 0, 90, 180, or 270.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  const uv = validateFiniteVector(faceObject.uv, 4, "Model element face uv", "rsgl.invalidModelFaceUv", unit, diagnostics);
  if (uv && uv.some(value => value < 0 || value > 16)) {
    diagnostics.push({
      code: "rsgl.modelFaceUvOutOfRange",
      message: "Model element face uv values should be between 0 and 16.",
      severity: "warning",
      range: unitRange(unit)
    });
  }
  if ("cullface" in faceObject && (typeof faceObject.cullface !== "string" || !faceNames.has(faceObject.cullface))) {
    diagnostics.push({
      code: "rsgl.invalidModelFaceCullface",
      message: "Model element face cullface must be down, up, north, south, west, or east.",
      severity: "error",
      range: unitRange(unit)
    });
  }
  if ("tintindex" in faceObject && (!Number.isInteger(faceObject.tintindex) || Number(faceObject.tintindex) < -1)) {
    diagnostics.push({
      code: "rsgl.invalidModelFaceTintIndex",
      message: "Model element face tintindex must be an integer greater than or equal to -1.",
      severity: "error",
      range: unitRange(unit)
    });
  }
}

function validateFiniteVector(
  value: JsonValue | undefined,
  length: number,
  label: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  required = false
): number[] | null {
  if (value === undefined) {
    if (required) {
      diagnostics.push({
        code,
        message: `${label} must be a finite ${vectorLabel(length)} number vector.`,
        severity: "error",
        range: unitRange(unit)
      });
    }
    return null;
  }
  if (!Array.isArray(value) || value.length !== length || value.some(item => !isFiniteNumber(item))) {
    diagnostics.push({
      code,
      message: `${label} must be a finite ${vectorLabel(length)} number vector.`,
      severity: "error",
      range: unitRange(unit)
    });
    return null;
  }
  return value as number[];
}

function vectorLabel(length: number): string {
  if (length === 3) {
    return "[x, y, z]";
  }
  if (length === 4) {
    return "[x1, y1, x2, y2]";
  }
  return `[${Array.from({ length }, (_, index) => index + 1).join(", ")}]`;
}

function isValidFaceRotation(value: JsonValue | undefined): boolean {
  return value === 0 || value === 90 || value === 180 || value === 270;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
