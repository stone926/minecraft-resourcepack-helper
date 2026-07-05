import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { RsglResourceValidationOptions } from "./validation";

interface McmetaFrameLayout {
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
}

export function validateMcmetaAnimation(
  unit: ResourceUnit,
  textureId: string | null,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = asObject(unit.content);
  if (!content) {
    return;
  }

  validateMcmetaGui(content.gui, unit, diagnostics);

  if (!Object.hasOwn(content, "animation")) {
    return;
  }

  const animation = asObject(content.animation);
  if (!animation) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaAnimation",
      message: "PNG animation metadata must be an object.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  const frameWidth = validateOptionalPositiveInteger(animation.width, "Animation frame width", "rsgl.invalidMcmetaFrameSize", unit, diagnostics);
  const frameHeight = validateOptionalPositiveInteger(animation.height, "Animation frame height", "rsgl.invalidMcmetaFrameSize", unit, diagnostics);
  validateOptionalPositiveInteger(animation.frametime, "Animation frametime", "rsgl.invalidMcmetaFrameTime", unit, diagnostics);

  if ("interpolate" in animation && typeof animation.interpolate !== "boolean") {
    diagnostics.push({
      code: "rsgl.invalidMcmetaInterpolate",
      message: "Animation interpolate must be a boolean.",
      severity: "error",
      range: unitRange(unit)
    });
  }

  const layout = textureId
    ? getMcmetaFrameLayout(textureId, animation, frameWidth, frameHeight, options, unit, diagnostics)
    : null;
  validateMcmetaFrames(animation.frames, layout, unit, diagnostics);
}

function validateMcmetaGui(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const gui = asObject(value);
  if (!gui) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaGui",
      message: "PNG GUI metadata must be an object.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }
  validateMcmetaGuiScaling(gui.scaling, unit, diagnostics);
}

function validateMcmetaGuiScaling(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const scaling = asObject(value);
  if (!scaling) {
    pushGuiScalingDiagnostic("GUI scaling metadata must be an object.", unit, diagnostics);
    return;
  }
  if (scaling.type !== "stretch" && scaling.type !== "tile" && scaling.type !== "nine_slice") {
    pushGuiScalingDiagnostic("GUI scaling type must be 'stretch', 'tile', or 'nine_slice'.", unit, diagnostics);
    return;
  }
  if (scaling.type === "tile" || scaling.type === "nine_slice") {
    validateRequiredPositiveInteger(scaling, "width", "GUI scaling width", unit, diagnostics);
    validateRequiredPositiveInteger(scaling, "height", "GUI scaling height", unit, diagnostics);
  }
  if (scaling.type === "nine_slice") {
    validateNineSliceBorder(scaling.border, unit, diagnostics);
  }
  if ("stretch_inner" in scaling && typeof scaling.stretch_inner !== "boolean") {
    pushGuiScalingDiagnostic("GUI nine-slice stretch_inner must be a boolean.", unit, diagnostics);
  }
}

function validateNineSliceBorder(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    pushGuiScalingDiagnostic("GUI nine-slice scaling requires a border.", unit, diagnostics);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      pushGuiScalingDiagnostic("GUI nine-slice border must be a non-negative integer.", unit, diagnostics);
    }
    return;
  }
  const border = asObject(value);
  if (!border) {
    pushGuiScalingDiagnostic("GUI nine-slice border must be a non-negative integer or border object.", unit, diagnostics);
    return;
  }
  for (const key of ["left", "top", "right", "bottom"]) {
    const side = border[key];
    if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 0)) {
      pushGuiScalingDiagnostic(`GUI nine-slice border ${key} must be a non-negative integer.`, unit, diagnostics);
    }
  }
}

function getMcmetaFrameLayout(
  textureId: string,
  animation: Record<string, JsonValue>,
  declaredWidth: number | null,
  declaredHeight: number | null,
  options: RsglResourceValidationOptions,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): McmetaFrameLayout | null {
  const metadata = options.textureMetadata?.(textureId);
  if (!metadata || !isPositiveDimension(metadata.width) || !isPositiveDimension(metadata.height)) {
    return null;
  }
  if (("width" in animation && declaredWidth === null) || ("height" in animation && declaredHeight === null)) {
    return null;
  }

  const defaultFrameSize = Math.min(metadata.width, metadata.height);
  const frameWidth = declaredWidth ?? defaultFrameSize;
  const frameHeight = declaredHeight ?? defaultFrameSize;
  if (metadata.width % frameWidth !== 0 || metadata.height % frameHeight !== 0) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaFrameStrip",
      message: `Texture ${textureId} size ${metadata.width}x${metadata.height} must be divisible by animation frame size ${frameWidth}x${frameHeight}.`,
      severity: "error",
      range: unitRange(unit)
    });
    return null;
  }

  return {
    frameCount: (metadata.width / frameWidth) * (metadata.height / frameHeight),
    frameWidth,
    frameHeight
  };
}

function validateMcmetaFrames(
  value: JsonValue | undefined,
  layout: McmetaFrameLayout | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaFrames",
      message: "Animation frames must be an array.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  for (const frame of value) {
    validateMcmetaFrame(frame, layout, unit, diagnostics);
  }
}

function validateMcmetaFrame(
  value: JsonValue,
  layout: McmetaFrameLayout | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (typeof value === "number") {
    validateFrameIndex(value, layout, unit, diagnostics);
    return;
  }

  const frame = asObject(value);
  if (!frame || !Object.hasOwn(frame, "index")) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaFrame",
      message: "Animation frame entries must be a non-negative integer or an object with an index.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  validateFrameIndex(frame.index, layout, unit, diagnostics);
  validateOptionalPositiveInteger(frame.time, "Animation frame time", "rsgl.invalidMcmetaFrameTime", unit, diagnostics);
}

function validateFrameIndex(
  value: JsonValue | undefined,
  layout: McmetaFrameLayout | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    diagnostics.push({
      code: "rsgl.invalidMcmetaFrameIndex",
      message: "Animation frame index must be a non-negative integer.",
      severity: "error",
      range: unitRange(unit)
    });
    return;
  }

  if (layout && value >= layout.frameCount) {
    diagnostics.push({
      code: "rsgl.mcmetaFrameIndexOutOfRange",
      message: `Animation frame index ${value} is outside the ${layout.frameCount} frames available from ${layout.frameWidth}x${layout.frameHeight} tiles.`,
      severity: "error",
      range: unitRange(unit)
    });
  }
}

function validateOptionalPositiveInteger(
  value: JsonValue | undefined,
  label: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): number | null {
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    diagnostics.push({
      code,
      message: `${label} must be a positive integer.`,
      severity: "error",
      range: unitRange(unit)
    });
    return null;
  }
  return value;
}

function validateRequiredPositiveInteger(
  object: Record<string, JsonValue>,
  field: string,
  label: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): number | null {
  if (!Object.hasOwn(object, field)) {
    pushGuiScalingDiagnostic(`${label} is required.`, unit, diagnostics);
    return null;
  }
  return validateOptionalPositiveInteger(object[field], label, "rsgl.invalidMcmetaGuiScaling", unit, diagnostics);
}

function pushGuiScalingDiagnostic(
  message: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  diagnostics.push({
    code: "rsgl.invalidMcmetaGuiScaling",
    message,
    severity: "error",
    range: unitRange(unit)
  });
}

function isPositiveDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function unitRange(unit: ResourceUnit): ResourceUnit["sourceMap"]["mappings"][number]["sourceRange"] {
  return unit.sourceMap.mappings[0].sourceRange;
}

function asObject(value: unknown): Record<string, JsonValue> | null {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : null;
}
