import { JsonValue, ResourceUnit, RsglCompileDiagnostic } from "./ir";
import { validateModelStructure } from "./modelStructureValidation";
import { appendGeneratedPath } from "./sourcePaths";
import {
  asObject,
  checkResourceExists,
  isObject,
  isVirtualBuiltinModelId,
  sourceRangeForGeneratedPath,
  visitJsonWithPath,
  type RsglResourceValidationOptions
} from "./validationShared";
import { qualifyMinecraftResourceId, tryParseMinecraftResourceId } from "../../../mc-assets/src";

type TextureVariableResolution =
  | { kind: "resolved"; texture: string }
  | { kind: "missing" }
  | { kind: "cycle" };

export interface ModelDocument {
  id: string;
  namespace: string;
  content: Record<string, JsonValue>;
}

export function validateModelUnit(
  unit: ResourceUnit,
  generatedModels: Map<string, ResourceUnit>,
  modelResolver: (id: string) => ModelDocument | undefined,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  validateModelParentChain(unit, modelResolver, generatedModels, options, diagnostics);

  const content = asObject(unit.content);
  const textures = asObject(content?.textures);
  if (textures) {
    for (const [key, value] of Object.entries(textures)) {
      const texturePath = appendGeneratedPath("/textures", key);
      if (typeof value === "string" && !value.startsWith("#")) {
        checkResourceExists("texture", value, unit, generatedModels, options, diagnostics, sourceRangeForGeneratedPath(unit, texturePath));
      } else if (isObject(value) && typeof value.sprite === "string" && !value.sprite.startsWith("#")) {
        checkResourceExists(
          "texture",
          value.sprite,
          unit,
          generatedModels,
          options,
          diagnostics,
          sourceRangeForGeneratedPath(unit, appendGeneratedPath(texturePath, "sprite"))
        );
      }
    }
  }

  validateModelTextureVariables(unit, modelResolver, generatedModels, options, diagnostics);
  validateModelStructure(unit, diagnostics);
}

export function createModelResolver(
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions
): (id: string) => ModelDocument | undefined {
  const generatedDocuments = new Map<string, ModelDocument>();
  const externalDocuments = new Map<string, ModelDocument | null>();

  return id => {
    if (isVirtualBuiltinModelId(id)) {
      return undefined;
    }

    const generated = generatedModels.get(id);
    if (generated) {
      let document = generatedDocuments.get(id);
      if (!document) {
        document = modelDocumentFromUnit(generated);
        if (!document) {
          return undefined;
        }
        generatedDocuments.set(id, document);
      }
      return document;
    }

    if (!options.resourceContent) {
      return undefined;
    }
    if (!externalDocuments.has(id)) {
      const content = options.resourceContent("model", id);
      const contentObject = asObject(content);
      externalDocuments.set(id, contentObject ? modelDocumentFromContent(id, contentObject) : null);
    }
    return externalDocuments.get(id) ?? undefined;
  };
}

function validateModelParentChain(
  unit: ResourceUnit,
  modelResolver: (id: string) => ModelDocument | undefined,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const seen = new Set<string>();
  let current: ModelDocument | undefined = root;
  while (current) {
    if (seen.has(current.id)) {
      diagnostics.push({
        code: "rsgl.modelParentCycle",
        message: `Model parent chain contains a cycle at ${current.id}.`,
        severity: "error",
        range: unit.sourceMap.mappings[0].sourceRange
      });
      return;
    }
    seen.add(current.id);

    const parent = current.content.parent;
    if (typeof parent !== "string") {
      return;
    }
    const parentId = qualifyMinecraftResourceId(parent, current.namespace);
    if (isVirtualBuiltinModelId(parentId)) {
      return;
    }
    current = modelResolver(parentId);
    if (!current) {
      checkResourceExists("model", parentId, unit, generatedModels, options, diagnostics);
    }
  }
}

function validateModelTextureVariables(
  unit: ResourceUnit,
  modelResolver: (id: string) => ModelDocument | undefined,
  generatedModels: Map<string, ResourceUnit>,
  options: RsglResourceValidationOptions,
  diagnostics: RsglCompileDiagnostic[]
): void {
  const root = modelDocumentFromUnit(unit);
  if (!root) {
    return;
  }

  const checked = new Set<string>();
  visitJsonWithPath(unit.content as JsonValue, (value, generatedPath) => {
    const reference = textureVariableReference(value);
    if (!reference || checked.has(reference)) {
      return;
    }
    checked.add(reference);

    const range = sourceRangeForGeneratedPath(unit, generatedPath);
    const resolution = resolveTextureVariable(root, reference, modelResolver, new Set());
    if (resolution.kind === "missing") {
      diagnostics.push({
        code: "rsgl.unresolvedTextureVariable",
        message: `Texture variable '#${reference}' is not defined in the model parent chain.`,
        severity: "warning",
        range
      });
    } else if (resolution.kind === "cycle") {
      diagnostics.push({
        code: "rsgl.textureVariableCycle",
        message: `Texture variable '#${reference}' resolves through a cycle.`,
        severity: "error",
        range
      });
    } else {
      checkResourceExists("texture", resolution.texture, unit, generatedModels, options, diagnostics, range);
    }
  });
}

function modelDocumentFromUnit(unit: ResourceUnit): ModelDocument | undefined {
  const id = modelKey(unit);
  const content = asObject(unit.content);
  return id && content ? modelDocumentFromContent(id, content) : undefined;
}

function modelDocumentFromContent(id: string, content: Record<string, JsonValue>): ModelDocument {
  return {
    id,
    namespace: tryParseMinecraftResourceId(id, "minecraft")?.namespace ?? "minecraft",
    content
  };
}

function resolveTextureVariable(
  model: ModelDocument,
  name: string,
  modelResolver: (id: string) => ModelDocument | undefined,
  seen: Set<string>
): TextureVariableResolution {
  const resolutionKey = `${model.id}#${name}`;
  if (seen.has(resolutionKey)) {
    return { kind: "cycle" };
  }
  seen.add(resolutionKey);

  const content = model.content;
  const textures = asObject(content.textures);
  if (textures && Object.hasOwn(textures, name)) {
    return resolveTextureValue(textures[name], model, modelResolver, seen);
  }

  const parent = content.parent;
  const parentModel = typeof parent === "string"
    ? modelResolver(qualifyMinecraftResourceId(parent, model.namespace))
    : undefined;
  return parentModel ? resolveTextureVariable(parentModel, name, modelResolver, seen) : { kind: "missing" };
}

function resolveTextureValue(
  value: JsonValue | undefined,
  model: ModelDocument,
  modelResolver: (id: string) => ModelDocument | undefined,
  seen: Set<string>
): TextureVariableResolution {
  if (typeof value === "string") {
    return value.startsWith("#")
      ? resolveTextureVariable(model, value.slice(1), modelResolver, seen)
      : { kind: "resolved", texture: value };
  }

  const object = asObject(value);
  if (typeof object?.sprite === "string") {
    return object.sprite.startsWith("#")
      ? resolveTextureVariable(model, object.sprite.slice(1), modelResolver, seen)
      : { kind: "resolved", texture: object.sprite };
  }

  return { kind: "missing" };
}

function textureVariableReference(value: JsonValue): string | null {
  return typeof value === "string" && value.startsWith("#") && value.length > 1
    ? value.slice(1)
    : null;
}

function modelKey(unit: ResourceUnit): string | null {
  return unit.id ? `${unit.id.namespace}:${unit.id.path}` : null;
}
