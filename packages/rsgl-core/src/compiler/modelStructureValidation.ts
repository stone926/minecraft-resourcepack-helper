import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import { asObject, isFiniteNumber, requireArray, requireObject } from "./validationPrimitives";

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

  const display = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidModelDisplay",
    message: "Model display must be an object keyed by display context."
  });
  if (!display) {
    return;
  }

  for (const [context, transformValue] of Object.entries(display)) {
    if (context === "__comment") {
      continue;
    }
    if (!displayContexts.has(context)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelDisplayContext", `Model display context '${context}' is not recognized.`, "warning");
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
  const transform = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidModelDisplayTransform",
    message: `Model display '${context}' must be an object.`
  });
  if (!transform) {
    return;
  }

  validateFiniteVector(transform.rotation, 3, `Model display '${context}' rotation`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  const translation = validateFiniteVector(transform.translation, 3, `Model display '${context}' translation`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  if (translation && translation.some(value => value < -80 || value > 80)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.modelDisplayTranslationOutOfRange",
      `Model display '${context}' translation values outside [-80, 80] will be clamped by Minecraft.`,
      "warning"
    );
  }

  const scale = validateFiniteVector(transform.scale, 3, `Model display '${context}' scale`, "rsgl.invalidModelDisplayVector", unit, diagnostics);
  if (scale && scale.some(value => value < 0 || value > 4)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.modelDisplayScaleOutOfRange",
      `Model display '${context}' scale values should be between 0 and 4.`,
      "warning"
    );
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
  const elements = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidModelElements",
    message: "Model elements must be an array."
  });
  if (!elements) {
    return;
  }

  for (const element of elements) {
    const elementObject = requireObject(element, unit, diagnostics, {
      code: "rsgl.invalidModelElement",
      message: "Model element entries must be objects."
    });
    if (!elementObject) {
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
    pushUnitDiagnostic(diagnostics, unit, "rsgl.modelElementCoordinateOutOfRange", `Model element '${name}' coordinates must be between -16 and 32.`, "warning");
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
  const rotation = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidModelElementRotation",
    message: "Model element rotation must be an object."
  });
  if (!rotation) {
    return;
  }

  validateFiniteVector(rotation.origin, 3, "Model element rotation origin", "rsgl.invalidModelElementRotationOrigin", unit, diagnostics);
  if ("axis" in rotation && (typeof rotation.axis !== "string" || !rotationAxes.has(rotation.axis))) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementRotationAxis", "Model element rotation axis must be 'x', 'y', or 'z'.");
  }
  if ("angle" in rotation && !isFiniteNumber(rotation.angle)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementRotationAngle", "Model element rotation angle must be a finite number.");
  }
  for (const axis of ["x", "y", "z"]) {
    if (axis in rotation && !isFiniteNumber(rotation[axis])) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementRotationAngle", `Model element rotation ${axis} angle must be a finite number.`);
    }
  }
  if ("rescale" in rotation && typeof rotation.rescale !== "boolean") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementRescale", "Model element rotation rescale must be a boolean.");
  }
  if (("axis" in rotation) !== ("angle" in rotation)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.incompleteModelElementRotation", "Legacy model element rotation must define axis and angle together.");
  }
}

function validateModelElementFlags(
  element: Record<string, JsonValue>,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if ("shade" in element && typeof element.shade !== "boolean") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementShade", "Model element shade must be a boolean.");
  }
  if ("light_emission" in element && (!Number.isInteger(element.light_emission) || Number(element.light_emission) < 0 || Number(element.light_emission) > 15)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelElementLightEmission", "Model element light_emission must be an integer between 0 and 15.");
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
  const faces = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidModelElementFaces",
    message: "Model element faces must be an object."
  });
  if (!faces) {
    return;
  }

  for (const [name, face] of Object.entries(faces)) {
    if (!faceNames.has(name)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelFaceName", `Model element face '${name}' is not a valid face direction.`, "warning");
    }
    validateModelElementFace(face, unit, diagnostics);
  }
}

function validateModelElementFace(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const faceObject = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidModelFace",
    message: "Model element face entries must be objects."
  });
  if (!faceObject) {
    return;
  }
  if ("texture" in faceObject && (typeof faceObject.texture !== "string" || !faceObject.texture.startsWith("#"))) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelFaceTexture", "Model element face texture must reference a texture variable starting with '#'.");
  }
  if ("rotation" in faceObject && !isValidFaceRotation(faceObject.rotation)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelFaceRotation", "Model element face rotation must be one of 0, 90, 180, or 270.");
  }
  const uv = validateFiniteVector(faceObject.uv, 4, "Model element face uv", "rsgl.invalidModelFaceUv", unit, diagnostics);
  if (uv && uv.some(value => value < 0 || value > 16)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.modelFaceUvOutOfRange", "Model element face uv values should be between 0 and 16.", "warning");
  }
  if ("cullface" in faceObject && (typeof faceObject.cullface !== "string" || !faceNames.has(faceObject.cullface))) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelFaceCullface", "Model element face cullface must be down, up, north, south, west, or east.");
  }
  if ("tintindex" in faceObject && (!Number.isInteger(faceObject.tintindex) || Number(faceObject.tintindex) < -1)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidModelFaceTintIndex", "Model element face tintindex must be an integer greater than or equal to -1.");
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
      pushUnitDiagnostic(diagnostics, unit, code, `${label} must be a finite ${vectorLabel(length)} number vector.`);
    }
    return null;
  }
  const vector = requireArray(value, unit, diagnostics, {
    code,
    message: `${label} must be a finite ${vectorLabel(length)} number vector.`
  });
  if (!vector) {
    return null;
  }
  if (vector.length !== length || vector.some(item => !isFiniteNumber(item))) {
    pushUnitDiagnostic(diagnostics, unit, code, `${label} must be a finite ${vectorLabel(length)} number vector.`);
    return null;
  }
  return vector as number[];
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
