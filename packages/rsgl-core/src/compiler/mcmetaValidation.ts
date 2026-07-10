import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { appendGeneratedPath } from "./sourcePaths";
import { asObject, unitRange, type RsglResourceValidationOptions } from "./validationShared";

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

  const animation = asObject(content.animation);
  if (!animation) {
    pushMcmetaDiagnostic("rsgl.invalidMcmetaAnimation", "PNG animation metadata must be an object.", unit, diagnostics, "/animation");
    return;
  }

  const frameWidth = validateOptionalPositiveInteger(animation.width, "Animation frame width", "rsgl.invalidMcmetaFrameSize", unit, diagnostics, "/animation/width");
  const frameHeight = validateOptionalPositiveInteger(animation.height, "Animation frame height", "rsgl.invalidMcmetaFrameSize", unit, diagnostics, "/animation/height");
  validateOptionalPositiveInteger(animation.frametime, "Animation frametime", "rsgl.invalidMcmetaFrameTime", unit, diagnostics, "/animation/frametime");

  if ("interpolate" in animation && typeof animation.interpolate !== "boolean") {
    pushMcmetaDiagnostic("rsgl.invalidMcmetaInterpolate", "Animation interpolate must be a boolean.", unit, diagnostics, "/animation/interpolate");
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
  const texture = asObject(value);
  if (!texture) {
    pushMcmetaDiagnostic(
      "rsgl.invalidMcmetaTexture",
      "PNG texture metadata must be an object.",
      unit,
      diagnostics,
      "/texture"
    );
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
    pushMcmetaDiagnostic(
      "rsgl.invalidMcmetaAlphaCutoffBias",
      "Texture alpha_cutoff_bias must be a finite number.",
      unit,
      diagnostics,
      "/texture/alpha_cutoff_bias"
    );
    return;
  }
  if (options.targetPackFormat && options.targetPackFormat.major < alphaCutoffBiasPackFormat) {
    pushMcmetaDiagnostic(
      "rsgl.unsupportedMcmetaAlphaCutoffBias",
      "Texture alpha_cutoff_bias requires pack format 75.0 or newer.",
      unit,
      diagnostics,
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
  const gui = asObject(value);
  if (!gui) {
    pushMcmetaDiagnostic("rsgl.invalidMcmetaGui", "PNG GUI metadata must be an object.", unit, diagnostics, "/gui");
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
    pushGuiScalingDiagnostic("GUI scaling metadata must be an object.", unit, diagnostics, "/gui/scaling");
    return;
  }
  if (scaling.type !== "stretch" && scaling.type !== "tile" && scaling.type !== "nine_slice") {
    pushGuiScalingDiagnostic("GUI scaling type must be 'stretch', 'tile', or 'nine_slice'.", unit, diagnostics, "/gui/scaling/type");
    return;
  }
  if (scaling.type === "tile" || scaling.type === "nine_slice") {
    validateRequiredPositiveInteger(scaling, "width", "GUI scaling width", unit, diagnostics, "/gui/scaling/width");
    validateRequiredPositiveInteger(scaling, "height", "GUI scaling height", unit, diagnostics, "/gui/scaling/height");
  }
  if (scaling.type === "nine_slice") {
    validateNineSliceBorder(scaling.border, unit, diagnostics, "/gui/scaling/border");
  }
  if ("stretch_inner" in scaling && typeof scaling.stretch_inner !== "boolean") {
    pushGuiScalingDiagnostic("GUI nine-slice stretch_inner must be a boolean.", unit, diagnostics, "/gui/scaling/stretch_inner");
  }
}

function validateNineSliceBorder(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value === undefined) {
    pushGuiScalingDiagnostic("GUI nine-slice scaling requires a border.", unit, diagnostics, generatedPath);
    return;
  }
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      pushGuiScalingDiagnostic("GUI nine-slice border must be a non-negative integer.", unit, diagnostics, generatedPath);
    }
    return;
  }
  const border = asObject(value);
  if (!border) {
    pushGuiScalingDiagnostic("GUI nine-slice border must be a non-negative integer or border object.", unit, diagnostics, generatedPath);
    return;
  }
  for (const key of ["left", "top", "right", "bottom"]) {
    const side = border[key];
    if (side !== undefined && (typeof side !== "number" || !Number.isInteger(side) || side < 0)) {
      pushGuiScalingDiagnostic(`GUI nine-slice border ${key} must be a non-negative integer.`, unit, diagnostics, appendGeneratedPath(generatedPath, key));
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
    pushMcmetaDiagnostic(
      "rsgl.invalidMcmetaFrameStrip",
      `Texture ${textureId} size ${metadata.width}x${metadata.height} must be divisible by animation frame size ${frameWidth}x${frameHeight}.`,
      unit,
      diagnostics,
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
  if (!Array.isArray(value)) {
    pushMcmetaDiagnostic("rsgl.invalidMcmetaFrames", "Animation frames must be an array.", unit, diagnostics, generatedPath);
    return;
  }

  for (const [index, frame] of value.entries()) {
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
    pushMcmetaDiagnostic(
      "rsgl.invalidMcmetaFrame",
      "Animation frame entries must be a non-negative integer or an object with an index.",
      unit,
      diagnostics,
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
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    pushMcmetaDiagnostic("rsgl.invalidMcmetaFrameIndex", "Animation frame index must be a non-negative integer.", unit, diagnostics, generatedPath);
    return;
  }

  if (layout && value >= layout.frameCount) {
    pushMcmetaDiagnostic(
      "rsgl.mcmetaFrameIndexOutOfRange",
      `Animation frame index ${value} is outside the ${layout.frameCount} frames available from ${layout.frameWidth}x${layout.frameHeight} tiles.`,
      unit,
      diagnostics,
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
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    pushMcmetaDiagnostic(code, `${label} must be a positive integer.`, unit, diagnostics, generatedPath);
    return null;
  }
  return value;
}

function validateOptionalBoolean(
  value: JsonValue | undefined,
  label: string,
  code: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value !== undefined && typeof value !== "boolean") {
    pushMcmetaDiagnostic(code, `${label} must be a boolean.`, unit, diagnostics, generatedPath);
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
    pushGuiScalingDiagnostic(`${label} is required.`, unit, diagnostics, generatedPath);
    return null;
  }
  return validateOptionalPositiveInteger(object[field], label, "rsgl.invalidMcmetaGuiScaling", unit, diagnostics, generatedPath);
}

function pushGuiScalingDiagnostic(
  message: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  pushMcmetaDiagnostic("rsgl.invalidMcmetaGuiScaling", message, unit, diagnostics, generatedPath);
}

function pushMcmetaDiagnostic(
  code: string,
  message: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath?: string
): void {
  diagnostics.push({
    code,
    message,
    severity: "error",
    range: generatedPath ? sourceRangeForGeneratedPath(unit, generatedPath) : unitRange(unit)
  });
}

function sourceRangeForGeneratedPath(unit: ResourceUnit, generatedPath: string): RsglCompileDiagnostic["range"] {
  for (const path of generatedPathFallbacks(generatedPath)) {
    const range = unit.sourceMap.mappings.find(mapping => mapping.generatedPath === path)?.sourceRange;
    if (range) {
      return range;
    }
  }
  return unitRange(unit);
}

function generatedPathFallbacks(generatedPath: string): string[] {
  const paths: string[] = [];
  let current = generatedPath;
  while (current) {
    paths.push(current);
    const slash = current.lastIndexOf("/");
    current = slash > 0 ? current.slice(0, slash) : "";
  }
  paths.push("");
  return paths;
}

function isPositiveDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
