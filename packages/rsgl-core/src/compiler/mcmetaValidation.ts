import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { pushUnitDiagnostic } from "./validationDiagnostics";
import {
  asObject,
  isNonNegativeInteger,
  isPositiveInteger,
  requireArray,
  requireBoolean,
  requireEnum,
  requireObject,
  requirePositiveInteger
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";

interface McmetaFrameLayout {
  frameCount: number;
  frameWidth: number;
  frameHeight: number;
}

const alphaCutoffBiasPackFormat = 75;

export function validateMcmetaMetadata(
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
  validateMcmetaTexture(content.texture, unit, options, diagnostics);

  if (!Object.hasOwn(content, "animation")) {
    return;
  }

  const animation = requireObject(content.animation, unit, diagnostics, {
    code: "rsgl.invalidMcmetaAnimation",
    message: "PNG animation metadata must be an object.",
    generatedPath: "/animation"
  });
  if (!animation) {
    return;
  }

  const frameWidth = validateOptionalPositiveInteger(animation.width, "Animation frame width", "rsgl.invalidMcmetaFrameSize", unit, diagnostics, "/animation/width");
  const frameHeight = validateOptionalPositiveInteger(animation.height, "Animation frame height", "rsgl.invalidMcmetaFrameSize", unit, diagnostics, "/animation/height");
  validateOptionalPositiveInteger(animation.frametime, "Animation frametime", "rsgl.invalidMcmetaFrameTime", unit, diagnostics, "/animation/frametime");

  if ("interpolate" in animation && typeof animation.interpolate !== "boolean") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaInterpolate", "Animation interpolate must be a boolean.", "error", "/animation/interpolate");
  }

  const layout = textureId
    ? getMcmetaFrameLayout(textureId, animation, frameWidth, frameHeight, options, unit, diagnostics)
    : null;
  validateMcmetaFrames(animation.frames, layout, unit, diagnostics, "/animation/frames");
}

function validateMcmetaTexture(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const texture = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidMcmetaTexture",
    message: "PNG texture metadata must be an object.",
    generatedPath: "/texture"
  });
  if (!texture) {
    return;
  }

  validateOptionalBoolean(texture.blur, "Texture blur", "rsgl.invalidMcmetaTextureField", unit, diagnostics, "/texture/blur");
  validateOptionalBoolean(texture.clamp, "Texture clamp", "rsgl.invalidMcmetaTextureField", unit, diagnostics, "/texture/clamp");
  validateAlphaCutoffBias(texture, unit, options, diagnostics);
}

function validateAlphaCutoffBias(
  texture: Record<string, JsonValue>,
  unit: ResourceUnit,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!Object.hasOwn(texture, "alpha_cutoff_bias")) {
    return;
  }
  if (typeof texture.alpha_cutoff_bias !== "number" || !Number.isFinite(texture.alpha_cutoff_bias)) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidMcmetaAlphaCutoffBias",
      "Texture alpha_cutoff_bias must be a finite number.",
      "error",
      "/texture/alpha_cutoff_bias"
    );
    return;
  }
  if (options.targetPackFormat && options.targetPackFormat.major < alphaCutoffBiasPackFormat) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.unsupportedMcmetaAlphaCutoffBias",
      "Texture alpha_cutoff_bias requires pack format 75.0 or newer.",
      "error",
      "/texture/alpha_cutoff_bias"
    );
  }
}

function validateMcmetaGui(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const gui = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidMcmetaGui",
    message: "PNG GUI metadata must be an object.",
    generatedPath: "/gui"
  });
  if (!gui) {
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
  const scaling = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidMcmetaGuiScaling",
    message: "GUI scaling metadata must be an object.",
    generatedPath: "/gui/scaling"
  });
  if (!scaling) {
    return;
  }
  const scalingType = requireEnum(scaling.type, ["stretch", "tile", "nine_slice"], unit, diagnostics, {
    code: "rsgl.invalidMcmetaGuiScaling",
    message: "GUI scaling type must be 'stretch', 'tile', or 'nine_slice'.",
    generatedPath: "/gui/scaling/type"
  });
  if (!scalingType) {
    return;
  }
  if (scalingType === "tile" || scalingType === "nine_slice") {
    validateRequiredPositiveInteger(scaling, "width", "GUI scaling width", unit, diagnostics, "/gui/scaling/width");
    validateRequiredPositiveInteger(scaling, "height", "GUI scaling height", unit, diagnostics, "/gui/scaling/height");
  }
  if (scalingType === "nine_slice") {
    validateNineSliceBorder(scaling.border, unit, diagnostics, "/gui/scaling/border");
  }
  if ("stretch_inner" in scaling && typeof scaling.stretch_inner !== "boolean") {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaGuiScaling", "GUI nine-slice stretch_inner must be a boolean.", "error", "/gui/scaling/stretch_inner");
  }
}

function validateNineSliceBorder(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value === undefined) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaGuiScaling", "GUI nine-slice scaling requires a border.", "error", generatedPath);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaGuiScaling", "GUI nine-slice border must be a non-negative integer.", "error", generatedPath);
    }
    return;
  }
  const border = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidMcmetaGuiScaling",
    message: "GUI nine-slice border must be a non-negative integer or border object.",
    generatedPath
  });
  if (!border) {
    return;
  }
  for (const key of ["left", "top", "right", "bottom"]) {
    const side = border[key];
    if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 0)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaGuiScaling", `GUI nine-slice border ${key} must be a non-negative integer.`, "error", appendGeneratedPath(generatedPath, key));
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
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidMcmetaFrameStrip",
      `Texture ${textureId} size ${metadata.width}x${metadata.height} must be divisible by animation frame size ${frameWidth}x${frameHeight}.`,
      "error",
      "/animation"
    );
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
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value === undefined) {
    return;
  }
  const frames = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidMcmetaFrames",
    message: "Animation frames must be an array.",
    generatedPath
  });
  if (!frames) {
    return;
  }

  for (const [index, frame] of frames.entries()) {
    validateMcmetaFrame(frame, layout, unit, diagnostics, appendGeneratedPath(generatedPath, String(index)));
  }
}

function validateMcmetaFrame(
  value: JsonValue,
  layout: McmetaFrameLayout | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (typeof value === "number") {
    validateFrameIndex(value, layout, unit, diagnostics, generatedPath);
    return;
  }

  const frame = asObject(value);
  if (!frame || !Object.hasOwn(frame, "index")) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.invalidMcmetaFrame",
      "Animation frame entries must be a non-negative integer or an object with an index.",
      "error",
      generatedPath
    );
    return;
  }

  validateFrameIndex(frame.index, layout, unit, diagnostics, appendGeneratedPath(generatedPath, "index"));
  validateOptionalPositiveInteger(frame.time, "Animation frame time", "rsgl.invalidMcmetaFrameTime", unit, diagnostics, appendGeneratedPath(generatedPath, "time"));
}

function validateFrameIndex(
  value: JsonValue | undefined,
  layout: McmetaFrameLayout | null,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (!isNonNegativeInteger(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaFrameIndex", "Animation frame index must be a non-negative integer.", "error", generatedPath);
    return;
  }

  if (layout && value >= layout.frameCount) {
    pushUnitDiagnostic(
      diagnostics,
      unit,
      "rsgl.mcmetaFrameIndexOutOfRange",
      `Animation frame index ${value} is outside the ${layout.frameCount} frames available from ${layout.frameWidth}x${layout.frameHeight} tiles.`,
      "error",
      generatedPath
    );
  }
}

function validateOptionalPositiveInteger(
  value: JsonValue | undefined,
  label: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): number | null {
  if (value === undefined) {
    return null;
  }
  return requirePositiveInteger(value, unit, diagnostics, {
    code,
    message: `${label} must be a positive integer.`,
    generatedPath
  });
}

function validateOptionalBoolean(
  value: JsonValue | undefined,
  label: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value !== undefined) {
    requireBoolean(value, unit, diagnostics, { code, message: `${label} must be a boolean.`, generatedPath });
  }
}

function validateRequiredPositiveInteger(
  object: Record<string, JsonValue>,
  field: string,
  label: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): number | null {
  if (!Object.hasOwn(object, field)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidMcmetaGuiScaling", `${label} is required.`, "error", generatedPath);
    return null;
  }
  return validateOptionalPositiveInteger(object[field], label, "rsgl.invalidMcmetaGuiScaling", unit, diagnostics, generatedPath);
}

function isPositiveDimension(value: number): boolean {
  return isPositiveInteger(value);
}
