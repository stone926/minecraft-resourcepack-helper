import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { checkJsonResourceReference } from "./jsonResourceReferenceValidation";
import { pushUnitDiagnostic, sourceRangeForGeneratedPath } from "./validationDiagnostics";
import {
  requireArray,
  requireObject,
  requirePositiveInteger,
  requireString,
  validateBooleanField
} from "./validationPrimitives";
import type { RsglResourceValidationOptions } from "./validationTypes";
import { appendGeneratedPath } from "./sourcePaths";

export type PostEffectValidationOptions = RsglResourceValidationOptions;

const builtinTargets = new Set([
  "main",
  "minecraft:main",
  "minecraft:depth",
  "minecraft:translucent",
  "minecraft:translucent_depth",
  "minecraft:emissive",
  "minecraft:emissive_depth",
  "minecraft:outline",
  "minecraft:particles",
  "minecraft:particles_depth",
  "minecraft:weather",
  "minecraft:clouds"
]);

const uniformTypes = new Set(["float", "int", "ivec3", "vec2", "vec3", "vec4", "matrix4x4"]);

export function validatePostEffectMetadata(
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const content = requireObject(unit.content, unit, diagnostics, {
    code: "rsgl.invalidPostEffect",
    message: "Post effect resource must be an object."
  });
  if (!content) {
    return;
  }

  const declaredTargets = collectDeclaredTargets(content.targets, unit, diagnostics);
  validatePasses(content.passes, declaredTargets, unit.id?.namespace ?? "minecraft", unit, options, diagnostics);
}

function collectDeclaredTargets(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): Set<string> {
  const targets = new Set(builtinTargets);
  if (value === undefined) {
    return targets;
  }

  const targetMap = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectTargets",
    message: "Post effect 'targets' must be an object."
  });
  if (!targetMap) {
    return targets;
  }

  for (const [name, target] of Object.entries(targetMap)) {
    if (name.length > 0) {
      targets.add(name);
    }
    validateTarget(target, unit, diagnostics);
  }
  return targets;
}

function validateTarget(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const target = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectTarget",
    message: "Post effect targets must be objects."
  });
  if (!target) {
    return;
  }

  validatePositiveIntegerField(target, "width", "rsgl.invalidPostEffectTargetField", "Post effect target", unit, diagnostics);
  validatePositiveIntegerField(target, "height", "rsgl.invalidPostEffectTargetField", "Post effect target", unit, diagnostics);
  validateBooleanField(target, "persistent", "rsgl.invalidPostEffectTargetField", unit, diagnostics, {
    label: "Post effect target"
  });
  validateClearColor(target.clear_color, unit, diagnostics);
}

function validatePasses(
  value: JsonValue | undefined,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const passes = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectPasses",
    message: "Post effect 'passes' must be an array."
  });
  if (!passes) {
    return;
  }

  for (const [passIndex, passValue] of passes.entries()) {
    validatePass(
      passValue,
      declaredTargets,
      namespace,
      unit,
      options,
      diagnostics,
      appendGeneratedPath("/passes", String(passIndex))
    );
  }
}

function validatePass(
  value: JsonValue,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const pass = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectPass",
    message: "Post effect passes must be objects."
  });
  if (!pass) {
    return;
  }

  validateShaderField(pass, "vertex_shader", "shaderVertex", namespace, unit, options, diagnostics, generatedPath);
  validateShaderField(pass, "fragment_shader", "shaderFragment", namespace, unit, options, diagnostics, generatedPath);
  const outputName = stringField(pass, "output", "rsgl.invalidPostEffectPassField", "Post effect pass", unit, diagnostics);
  if (outputName && !declaredTargets.has(outputName)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.postEffectTargetNotFound", `Post effect output target '${outputName}' is not declared in targets.`);
  }

  validateInputs(pass.inputs, outputName, declaredTargets, namespace, unit, options, diagnostics, generatedPath);
  validateUniforms(pass.uniforms, unit, diagnostics);
}

function validateShaderField(
  pass: Record<string, JsonValue>,
  field: "vertex_shader" | "fragment_shader",
  kind: "shaderVertex" | "shaderFragment",
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const shader = stringField(pass, field, "rsgl.invalidPostEffectPassField", "Post effect pass", unit, diagnostics);
  if (shader !== null) {
    checkJsonResourceReference(
      pass,
      field,
      kind,
      unit,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, field)),
      undefined,
      namespace
    );
  }
}

function validateInputs(
  value: JsonValue | undefined,
  outputName: string | null,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  if (value === undefined) {
    return;
  }
  const inputs = requireArray(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectInputs",
    message: "Post effect pass 'inputs' must be an array."
  });
  if (!inputs) {
    return;
  }

  const inputsPath = appendGeneratedPath(generatedPath, "inputs");
  for (const [inputIndex, inputValue] of inputs.entries()) {
    validateInput(
      inputValue,
      outputName,
      declaredTargets,
      namespace,
      unit,
      options,
      diagnostics,
      appendGeneratedPath(inputsPath, String(inputIndex))
    );
  }
}

function validateInput(
  value: JsonValue,
  outputName: string | null,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[],
  generatedPath: string
): void {
  const input = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectInput",
    message: "Post effect inputs must be objects."
  });
  if (!input) {
    return;
  }

  stringField(input, "sampler_name", "rsgl.invalidPostEffectInputField", "Post effect input", unit, diagnostics);
  const targetName = stringField(input, "target", "rsgl.invalidPostEffectInputField", "Post effect input", unit, diagnostics);
  if (targetName && !declaredTargets.has(targetName)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.postEffectTargetNotFound", `Post effect input target '${targetName}' is not declared in targets.`);
  }
  if (targetName && outputName && targetName === outputName) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectTargetFlow", "Post effect pass input target must not be the same as its output target.");
  }

  const location = stringField(input, "location", "rsgl.invalidPostEffectInputField", "Post effect input", unit, diagnostics);
  if (location !== null) {
    checkJsonResourceReference(
      input,
      "location",
      "postEffectTexture",
      unit,
      options,
      diagnostics,
      sourceRangeForGeneratedPath(unit, appendGeneratedPath(generatedPath, "location")),
      undefined,
      namespace
    );
  }
  validatePositiveIntegerField(input, "width", "rsgl.invalidPostEffectInputField", "Post effect input", unit, diagnostics);
  validatePositiveIntegerField(input, "height", "rsgl.invalidPostEffectInputField", "Post effect input", unit, diagnostics);
  validateBooleanField(input, "use_depth_buffer", "rsgl.invalidPostEffectInputField", unit, diagnostics, {
    label: "Post effect input"
  });
  validateBooleanField(input, "bilinear", "rsgl.invalidPostEffectInputField", unit, diagnostics, {
    label: "Post effect input"
  });
}

function validateUniforms(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  const uniforms = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectUniforms",
    message: "Post effect pass 'uniforms' must be an object."
  });
  if (!uniforms) {
    return;
  }

  for (const entries of Object.values(uniforms)) {
    const uniformEntries = requireArray(entries, unit, diagnostics, {
      code: "rsgl.invalidPostEffectUniforms",
      message: "Post effect uniform groups must be arrays."
    });
    if (!uniformEntries) {
      continue;
    }
    for (const entry of uniformEntries) {
      validateUniform(entry, unit, diagnostics);
    }
  }
}

function validateUniform(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const uniform = requireObject(value, unit, diagnostics, {
    code: "rsgl.invalidPostEffectUniform",
    message: "Post effect uniforms must be objects."
  });
  if (!uniform) {
    return;
  }

  stringField(uniform, "name", "rsgl.invalidPostEffectUniformField", "Post effect uniform", unit, diagnostics);
  const type = stringField(uniform, "type", "rsgl.invalidPostEffectUniformField", "Post effect uniform", unit, diagnostics);
  if (type && !uniformTypes.has(type)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectUniformField", `Post effect uniform type '${type}' is not supported.`);
  }
  validateUniformValue(uniform.value, unit, diagnostics);
}

function validateClearColor(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined || Number.isInteger(value)) {
    return;
  }
  if (Array.isArray(value) && value.length === 4 && value.every(item => typeof item === "number" && Number.isFinite(item))) {
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectTargetField", "Post effect target 'clear_color' must be an integer or four-number array.");
}

function validateUniformValue(
  value: JsonValue | undefined,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined || (typeof value === "number" && Number.isFinite(value))) {
    return;
  }
  if (Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item))) {
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectUniformField", "Post effect uniform 'value' must be a finite number or number array.");
}

function stringField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  label: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): string | null {
  const value = object[field];
  if (value === undefined) {
    return null;
  }
  return requireString(value, unit, diagnostics, {
    code,
    message: `${label} '${field}' must be a string.`
  });
}

function validatePositiveIntegerField(
  object: Record<string, JsonValue>,
  field: string,
  code: string,
  label: string,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const value = object[field];
  if (value === undefined) {
    return;
  }
  requirePositiveInteger(value, unit, diagnostics, {
    code,
    message: `${label} '${field}' must be a positive integer.`
  });
}
