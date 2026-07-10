import { minecraftResourceIdInFolder, qualifyMinecraftResourceId } from "../../../mc-assets/src";
import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { asObject, pushUnitDiagnostic, validateBooleanField } from "./validationShared";

export interface PostEffectValidationOptions {
  resourceExists?: (kind: "shaderVertex" | "shaderFragment" | "texture", id: string) => boolean;
}

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
  const content = asObject(unit.content);
  if (!content) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffect", "Post effect resource must be an object.");
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

  const targetMap = asObject(value);
  if (!targetMap) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectTargets", "Post effect 'targets' must be an object.");
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
  const target = asObject(value);
  if (!target) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectTarget", "Post effect targets must be objects.");
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
  if (!Array.isArray(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectPasses", "Post effect 'passes' must be an array.");
    return;
  }

  for (const passValue of value) {
    validatePass(passValue, declaredTargets, namespace, unit, options, diagnostics);
  }
}

function validatePass(
  value: JsonValue,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const pass = asObject(value);
  if (!pass) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectPass", "Post effect passes must be objects.");
    return;
  }

  validateShaderField(pass, "vertex_shader", "shaderVertex", namespace, unit, options, diagnostics);
  validateShaderField(pass, "fragment_shader", "shaderFragment", namespace, unit, options, diagnostics);
  const outputName = stringField(pass, "output", "rsgl.invalidPostEffectPassField", "Post effect pass", unit, diagnostics);
  if (outputName && !declaredTargets.has(outputName)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.postEffectTargetNotFound", `Post effect output target '${outputName}' is not declared in targets.`);
  }

  validateInputs(pass.inputs, outputName, declaredTargets, namespace, unit, options, diagnostics);
  validateUniforms(pass.uniforms, unit, diagnostics);
}

function validateShaderField(
  pass: Record<string, JsonValue>,
  field: "vertex_shader" | "fragment_shader",
  kind: "shaderVertex" | "shaderFragment",
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const shader = stringField(pass, field, "rsgl.invalidPostEffectPassField", "Post effect pass", unit, diagnostics);
  if (shader) {
    checkResourceExists(kind, qualifyMinecraftResourceId(shader, namespace), unit, options, diagnostics);
  }
}

function validateInputs(
  value: JsonValue | undefined,
  outputName: string | null,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectInputs", "Post effect pass 'inputs' must be an array.");
    return;
  }

  for (const inputValue of value) {
    validateInput(inputValue, outputName, declaredTargets, namespace, unit, options, diagnostics);
  }
}

function validateInput(
  value: JsonValue,
  outputName: string | null,
  declaredTargets: Set<string>,
  namespace: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const input = asObject(value);
  if (!input) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectInput", "Post effect inputs must be objects.");
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
  if (location) {
    checkResourceExists("texture", minecraftResourceIdInFolder(location, namespace, "effect"), unit, options, diagnostics);
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
  const uniforms = asObject(value);
  if (!uniforms) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectUniforms", "Post effect pass 'uniforms' must be an object.");
    return;
  }

  for (const entries of Object.values(uniforms)) {
    if (!Array.isArray(entries)) {
      pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectUniforms", "Post effect uniform groups must be arrays.");
      continue;
    }
    for (const entry of entries) {
      validateUniform(entry, unit, diagnostics);
    }
  }
}

function validateUniform(
  value: JsonValue,
  unit: ResourceUnit,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const uniform = asObject(value);
  if (!uniform) {
    pushUnitDiagnostic(diagnostics, unit, "rsgl.invalidPostEffectUniform", "Post effect uniforms must be objects.");
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
  if (typeof value !== "string") {
    pushUnitDiagnostic(diagnostics, unit, code, `${label} '${field}' must be a string.`);
    return null;
  }
  return value;
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
  if (!Number.isInteger(value) || Number(value) < 1) {
    pushUnitDiagnostic(diagnostics, unit, code, `${label} '${field}' must be a positive integer.`);
  }
}

function checkResourceExists(
  kind: "shaderVertex" | "shaderFragment" | "texture",
  id: string,
  unit: ResourceUnit,
  options: PostEffectValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  if (!options.resourceExists || options.resourceExists(kind, id)) {
    return;
  }
  pushUnitDiagnostic(diagnostics, unit, resourceNotFoundCode(kind), `${resourceLabel(kind)} not found: ${id}`, "warning");
}

function resourceNotFoundCode(kind: "shaderVertex" | "shaderFragment" | "texture"): string {
  if (kind === "shaderVertex") {
    return "rsgl.vertexShaderNotFound";
  }
  if (kind === "shaderFragment") {
    return "rsgl.fragmentShaderNotFound";
  }
  return "rsgl.textureNotFound";
}

function resourceLabel(kind: "shaderVertex" | "shaderFragment" | "texture"): string {
  if (kind === "shaderVertex") {
    return "Vertex shader";
  }
  if (kind === "shaderFragment") {
    return "Fragment shader";
  }
  return "Texture";
}
