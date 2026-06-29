import type { Position } from "vscode";
import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers, parseJsonAst, stringValue } from "./jsonAst";
import { AstLocation, isInArea } from "./locationChecker";

export interface ResourceReference {
  value: string;
  valueNode: ResourceReferenceValueNode;
  target: string;
  source: string;
  extension: string | null;
  kind: ResourceReferenceKind;
  relationship?: ResourceReferenceRelationship;
}

export interface ResourceReferenceValueNode {
  loc?: AstLocation | null;
  valueLoc?: AstLocation | null;
}

type ResourceReferenceKind = "model" | "texture" | "textureDirectory" | "font" | "fontFile" | "shader" | "sound";
export type ResourceReferenceRelationship = "modelParent";

export interface ResourceReferenceDocument {
  languageId: string;
  fileName: string;
  version?: number;
  getText(): string;
}

type ResourceReferenceDocumentKind =
  | "blockstates"
  | "modelsBlock"
  | "modelsItem"
  | "models"
  | "particles"
  | "items"
  | "atlases"
  | "equipment"
  | "font"
  | "waypointStyle"
  | "postEffect"
  | "sounds"
  | "shaderCore"
  | "shaderPost";

interface CachedResourceReferences {
  fileName: string;
  version: number;
  references: ResourceReference[];
}

const resourceReferenceDocumentPatterns: Array<{
  kind: ResourceReferenceDocumentKind;
  pattern: RegExp;
}> = [
  { kind: "blockstates", pattern: /[\\/]blockstates[\\/].+\.json$/i },
  { kind: "modelsBlock", pattern: /[\\/]models[\\/]block[\\/].+\.json$/i },
  { kind: "modelsItem", pattern: /[\\/]models[\\/]item[\\/].+\.json$/i },
  { kind: "models", pattern: /[\\/]models[\\/].+\.json$/i },
  { kind: "particles", pattern: /[\\/]particles[\\/].+\.json$/i },
  { kind: "items", pattern: /[\\/]items[\\/].+\.json$/i },
  { kind: "atlases", pattern: /[\\/]atlases[\\/].+\.json$/i },
  { kind: "equipment", pattern: /[\\/]equipment[\\/].+\.json$/i },
  { kind: "font", pattern: /[\\/]font[\\/].+\.json$/i },
  { kind: "waypointStyle", pattern: /[\\/]waypoint_style[\\/].+\.json$/i },
  { kind: "postEffect", pattern: /[\\/]post_effect[\\/].+\.json$/i },
  { kind: "sounds", pattern: /[\\/]assets[\\/][^\\/]+[\\/]sounds\.json$/i },
  { kind: "shaderCore", pattern: /[\\/]shaders[\\/]core[\\/].+\.(?:vsh|fsh)$/i },
  { kind: "shaderPost", pattern: /[\\/]shaders[\\/]post[\\/].+\.(?:vsh|fsh)$/i }
];

const resourceReferenceCache = new WeakMap<ResourceReferenceDocument, CachedResourceReferences>();

export function getResourceReferences(document: ResourceReferenceDocument): ResourceReference[] {
  const documentKind = getResourceReferenceDocumentKind(document.fileName);
  if (!documentKind) {
    return [];
  }

  if (document.languageId !== "json" && !isShaderDocumentKind(documentKind)) {
    return [];
  }

  const cachedReferences = getCachedResourceReferences(document);
  if (cachedReferences) {
    return cachedReferences;
  }

  if (isShaderDocumentKind(documentKind)) {
    const references = getShaderReferences(document.getText(), getShaderDocumentSource(documentKind));
    setCachedResourceReferences(document, references);
    return references;
  }

  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return [];
  }

  const references = getReferencesForDocumentKind(ast, documentKind);
  setCachedResourceReferences(document, references);
  return references;
}

export function findResourceReferenceAtPosition(document: ResourceReferenceDocument, position: Position): ResourceReference | null {
  const line = position.line + 1;
  const character = position.character + 1;

  return getResourceReferences(document).find(reference =>
    isInArea(line, character, reference.valueNode.valueLoc ?? reference.valueNode.loc)
  ) ?? null;
}

export function isResourceReferenceDocument(document: ResourceReferenceDocument): boolean {
  const kind = getResourceReferenceDocumentKind(document.fileName);
  return kind !== null && (document.languageId === "json" || isShaderDocumentKind(kind));
}

export function isResourceReferenceFileName(fileName: string): boolean {
  return getResourceReferenceDocumentKind(fileName) !== null;
}

function getReferencesForDocumentKind(ast: JsonDocumentNode, documentKind: ResourceReferenceDocumentKind): ResourceReference[] {
  if (documentKind === "blockstates") {
    return getBlockstateReferences(ast);
  }

  if (documentKind === "modelsBlock") {
    return getModelReferences(ast, "models/block");
  }

  if (documentKind === "modelsItem") {
    return getItemModelReferences(ast);
  }

  if (documentKind === "models") {
    return getModelReferences(ast, "models");
  }

  if (documentKind === "particles") {
    return getParticleReferences(ast);
  }

  if (documentKind === "items") {
    return getItemDefinitionReferences(ast);
  }

  if (documentKind === "atlases") {
    return getAtlasReferences(ast);
  }

  if (documentKind === "equipment") {
    return getEquipmentReferences(ast);
  }

  if (documentKind === "font") {
    return getFontReferences(ast);
  }

  if (documentKind === "waypointStyle") {
    return getWaypointStyleReferences(ast);
  }

  if (documentKind === "postEffect") {
    return getPostEffectReferences(ast);
  }

  return getSoundReferences(ast);
}

function getBlockstateReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "variants") {
      for (const variantEntry of objectMembers(item.value)) {
        if (variantEntry.value?.type === "Object") {
          pushModelPropertyReferences(references, variantEntry.value, "blockstates");
        } else {
          for (const modelVariant of arrayElements(variantEntry.value)) {
            pushModelPropertyReferences(references, modelVariant, "blockstates");
          }
        }
      }
    } else if (memberName(item) === "multipart") {
      for (const multipartEntry of arrayElements(item.value)) {
        for (const applyEntry of objectMembers(multipartEntry)) {
          if (memberName(applyEntry) === "apply") {
            if (applyEntry.value?.type === "Object") {
              pushModelPropertyReferences(references, applyEntry.value, "blockstates");
            } else {
              for (const modelVariant of arrayElements(applyEntry.value)) {
                pushModelPropertyReferences(references, modelVariant, "blockstates");
              }
            }
          }
        }
      }
    }
  }

  return references;
}

function getModelReferences(ast: JsonDocumentNode, source: string): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "parent") {
      pushReference(references, item.value, "models", source, "json", "model", "modelParent");
    } else if (memberName(item) === "textures") {
      for (const textureEntry of objectMembers(item.value)) {
        pushModelTextureReference(references, textureEntry.value, source);
      }
    }
  }

  return references;
}

function getItemModelReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references = getModelReferences(ast, "models/item");

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "overrides") {
      for (const overrideEntry of arrayElements(item.value)) {
        pushModelPropertyReferences(references, overrideEntry, "models/item");
      }
    }
  }

  return references;
}

function getParticleReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "textures") {
      for (const texture of arrayElements(item.value)) {
        pushReference(references, texture, "textures/particle", "particles", "png", "texture");
      }
    }
  }

  return references;
}

function getItemDefinitionReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const model = getObjectMemberValue(ast.body, "model");
  if (model) {
    collectItemModelReferences(model, references);
  }
  return references;
}

function getAtlasReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) !== "sources") {
      continue;
    }

    for (const sourceEntry of arrayElements(item.value)) {
      collectAtlasSourceReferences(sourceEntry, references);
    }
  }

  return references;
}

function getEquipmentReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const layers = objectMembers(ast.body).find(member => memberName(member) === "layers");

  for (const layer of objectMembers(layers?.value)) {
    const layerName = memberName(layer);
    if (!layerName) {
      continue;
    }

    for (const layerEntry of arrayElements(layer.value)) {
      const texture = objectMembers(layerEntry).find(member => memberName(member) === "texture");
      if (texture) {
        pushReference(references, texture.value, `textures/entity/equipment/${layerName}`, "equipment", "png", "texture");
      }
    }
  }

  return references;
}

function getFontReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const providers = objectMembers(ast.body).find(member => memberName(member) === "providers");

  for (const provider of arrayElements(providers?.value)) {
    const type = getObjectString(provider, "type");
    if (type === "reference") {
      const id = objectMembers(provider).find(member => memberName(member) === "id");
      if (id) {
        pushReference(references, id.value, "font", "font", "json", "font");
      }
    } else if (type === "bitmap") {
      const file = objectMembers(provider).find(member => memberName(member) === "file");
      if (file) {
        pushReference(references, file.value, "textures", "font", "png", "texture");
      }
    } else if (type === "ttf") {
      const file = objectMembers(provider).find(member => memberName(member) === "file");
      if (file) {
        pushReference(references, file.value, "font", "font", null, "fontFile");
      }
    } else if (type === "unihex") {
      const hexFile = objectMembers(provider).find(member => memberName(member) === "hex_file");
      if (hexFile) {
        pushReference(references, hexFile.value, "font", "font", null, "fontFile");
      }
    }
  }

  return references;
}

function getWaypointStyleReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const sprites = objectMembers(ast.body).find(member => memberName(member) === "sprites");

  for (const sprite of arrayElements(sprites?.value)) {
    pushReference(references, sprite, "textures/gui/sprites/hud/locator_bar_dot", "waypoint_style", "png", "texture");
  }

  return references;
}

function getPostEffectReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const passes = objectMembers(ast.body).find(member => memberName(member) === "passes");

  for (const pass of arrayElements(passes?.value)) {
    for (const member of objectMembers(pass)) {
      const name = memberName(member);
      if (name === "vertex_shader") {
        pushReference(references, member.value, "shaders", "post_effect", "vsh", "shader");
      } else if (name === "fragment_shader") {
        pushReference(references, member.value, "shaders", "post_effect", "fsh", "shader");
      } else if (name === "inputs") {
        for (const input of arrayElements(member.value)) {
          const location = objectMembers(input).find(inputMember => memberName(inputMember) === "location");
          if (location) {
            pushReference(references, location.value, "textures/effect", "post_effect", "png", "texture");
          }
        }
      }
    }
  }

  return references;
}

function getSoundReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const soundEvent of objectMembers(ast.body)) {
    const sounds = objectMembers(soundEvent.value).find(member => memberName(member) === "sounds");
    for (const sound of arrayElements(sounds?.value)) {
      const directSound = stringValue(sound);
      if (directSound) {
        pushReference(references, sound, "sounds", "sounds.json", "ogg", "sound");
        continue;
      }

      const type = getObjectString(sound, "type");
      if (type === "event") {
        continue;
      }

      const name = objectMembers(sound).find(member => memberName(member) === "name");
      if (name) {
        pushReference(references, name.value, "sounds", "sounds.json", "ogg", "sound");
      }
    }
  }

  return references;
}

function getShaderReferences(text: string, source: string): ResourceReference[] {
  const references: ResourceReference[] = [];
  const lineStarts = getLineStarts(text);
  const importPattern = /#\s*moj_import\s*(?:<([^>\r\n]+)>|"([^"\r\n]+)")/g;

  for (const match of text.matchAll(importPattern)) {
    const value = match[1] ?? match[2];
    if (value === undefined || match.index === undefined) {
      continue;
    }

    const valueStart = match.index + match[0].indexOf(value);
    const valueEnd = valueStart + value.length;
    const valueLoc = getLocationForOffsets(lineStarts, valueStart, valueEnd);
    const target = match[1] !== undefined || value.includes(":") ? "shaders/include" : "shaders/core";
    references.push({
      value,
      valueNode: {
        loc: valueLoc,
        valueLoc
      },
      target,
      source,
      extension: null,
      kind: "shader"
    });
  }

  return references;
}

function collectAtlasSourceReferences(sourceEntry: JsonAstNode, references: ResourceReference[]) {
  const type = getObjectString(sourceEntry, "type");

  if (type === "minecraft:directory" || type === "directory") {
    const source = objectMembers(sourceEntry).find(member => memberName(member) === "source");
    if (source) {
      pushReference(references, source.value, "textures", "atlases", null, "textureDirectory");
    }
    return;
  }

  if (type === "minecraft:single" || type === "single") {
    const resource = objectMembers(sourceEntry).find(member => memberName(member) === "resource");
    if (resource) {
      pushReference(references, resource.value, "textures", "atlases", "png", "texture");
    }
    return;
  }

  if (type === "minecraft:unstitch" || type === "unstitch") {
    const resource = objectMembers(sourceEntry).find(member => memberName(member) === "resource");
    if (resource) {
      pushReference(references, resource.value, "textures", "atlases", "png", "texture");
    }
    return;
  }

  if (type === "minecraft:paletted_permutations" || type === "paletted_permutations") {
    const paletteKey = objectMembers(sourceEntry).find(member => memberName(member) === "palette_key");
    if (paletteKey) {
      pushReference(references, paletteKey.value, "textures", "atlases", "png", "texture");
    }

    const permutations = objectMembers(sourceEntry).find(member => memberName(member) === "permutations");
    for (const permutation of objectMembers(permutations?.value)) {
      pushReference(references, permutation.value, "textures", "atlases", "png", "texture");
    }

    const textures = objectMembers(sourceEntry).find(member => memberName(member) === "textures");
    for (const texture of arrayElements(textures?.value)) {
      pushReference(references, texture, "textures", "atlases", "png", "texture");
    }
  }
}

function pushModelTextureReference(references: ResourceReference[], valueNode: JsonAstNode, source: string): void {
  const directTexture = stringValue(valueNode);
  if (directTexture !== undefined) {
    pushReference(references, valueNode, "textures", source, "png", "texture");
    return;
  }

  const sprite = objectMembers(valueNode).find(member => memberName(member) === "sprite");
  if (sprite) {
    pushReference(references, sprite.value, "textures", source, "png", "texture");
  }
}

function collectItemModelReferences(node: JsonAstNode, references: ResourceReference[]) {
  const type = getMinecraftType(node);

  if (type === "model") {
    pushItemModelReference(references, node, "model");
    return;
  }

  if (type === "composite") {
    collectItemModelArrayMember(node, "models", references);
    return;
  }

  if (type === "condition") {
    collectNamedItemModelMembers(node, new Set(["on_true", "on_false"]), references);
    return;
  }

  if (type === "select") {
    collectSelectCaseModelReferences(node, references);
    collectItemModelMember(node, "fallback", references);
    return;
  }

  if (type === "range_dispatch") {
    collectRangeEntryModelReferences(node, references);
    collectItemModelMember(node, "fallback", references);
    return;
  }

  if (type === "special") {
    pushItemModelReference(references, node, "base");
    collectItemSpecialModelReferences(getObjectMemberValue(node, "model"), references);
    return;
  }

  if (type === "empty" || type === "bundle/selected_item" || type === "selected_item") {
    return;
  }

  collectLooseItemModelReferences(node, references);
}

function collectItemModelMember(node: JsonAstNode, name: string, references: ResourceReference[]) {
  const memberValue = getObjectMemberValue(node, name);
  if (memberValue) {
    collectItemModelReferences(memberValue, references);
  }
}

function collectItemModelArrayMember(node: JsonAstNode, name: string, references: ResourceReference[]) {
  const memberValue = getObjectMemberValue(node, name);
  for (const itemModel of arrayElements(memberValue)) {
    collectItemModelReferences(itemModel, references);
  }
}

function collectNamedItemModelMembers(node: JsonAstNode, names: Set<string>, references: ResourceReference[]) {
  for (const member of objectMembers(node)) {
    const name = memberName(member);
    if (name && names.has(name)) {
      collectItemModelReferences(member.value, references);
    }
  }
}

function collectSelectCaseModelReferences(node: JsonAstNode, references: ResourceReference[]) {
  const cases = getObjectMemberValue(node, "cases");
  for (const selectCase of arrayElements(cases)) {
    collectItemModelMember(selectCase, "model", references);
  }
}

function collectRangeEntryModelReferences(node: JsonAstNode, references: ResourceReference[]) {
  const entries = getObjectMemberValue(node, "entries");
  for (const rangeEntry of arrayElements(entries)) {
    collectItemModelMember(rangeEntry, "model", references);
  }
}

function collectItemSpecialModelReferences(node: JsonAstNode | null, references: ResourceReference[]) {
  if (!node) {
    return;
  }

  const texture = getObjectMemberValue(node, "texture");
  if (texture) {
    pushItemSpecialTextureReference(references, node, texture);
  }
}

function collectLooseItemModelReferences(node: JsonAstNode, references: ResourceReference[]) {
  for (const member of objectMembers(node)) {
    const name = memberName(member);
    if (name === "model" || name === "base") {
      pushReference(references, member.value, "models", "items", "json", "model");
    } else if (name === "texture") {
      pushItemSpecialTextureReference(references, node, member.value);
    }
    collectItemModelReferences(member.value, references);
  }

  for (const element of arrayElements(node)) {
    collectLooseItemModelReferences(element, references);
  }
}

function pushItemSpecialTextureReference(references: ResourceReference[], node: JsonAstNode, valueNode: JsonAstNode) {
  const type = getMinecraftType(node);
  if (type === "chest") {
    pushReference(references, valueNode, "textures/entity/chest", "items", "png", "texture");
  } else if (type === "shulker_box") {
    pushReference(references, valueNode, "textures/entity/shulker", "items", "png", "texture");
  } else if (type === "copper_golem_statue") {
    pushReference(references, valueNode, "", "items", "png", "texture");
  } else if (type === "head") {
    pushReference(references, valueNode, "textures/entity", "items", "png", "texture");
  }
}

function pushItemModelReference(references: ResourceReference[], node: JsonAstNode, name: string): void {
  const memberValue = getObjectMemberValue(node, name);
  if (memberValue) {
    pushReference(references, memberValue, "models", "items", "json", "model");
  }
}

function pushModelPropertyReferences(references: ResourceReference[], node: JsonAstNode, source: string) {
  for (const modelEntry of objectMembers(node)) {
    if (memberName(modelEntry) === "model") {
      pushReference(references, modelEntry.value, "models", source, "json", "model");
    }
  }
}

function pushReference(
  references: ResourceReference[],
  valueNode: JsonAstNode,
  target: string,
  source: string,
  extension: string | null,
  kind: ResourceReferenceKind,
  relationship?: ResourceReferenceRelationship
): void {
  const value = stringValue(valueNode);
  if (value !== undefined) {
    const reference: ResourceReference = { value, valueNode, target, source, extension, kind };
    if (relationship) {
      reference.relationship = relationship;
    }
    references.push(reference);
  }
}

function getObjectString(node: JsonAstNode, name: string): string | null {
  return stringValue(getObjectMemberValue(node, name)) ?? null;
}

function getObjectMemberValue(node: JsonAstNode, name: string): JsonAstNode | null {
  return objectMembers(node).find(item => memberName(item) === name)?.value ?? null;
}

function getMinecraftType(node: JsonAstNode): string | null {
  const type = getObjectString(node, "type");
  if (!type) {
    return null;
  }

  return type.startsWith("minecraft:") ? type.slice("minecraft:".length) : type;
}

function getCachedResourceReferences(document: ResourceReferenceDocument): ResourceReference[] | null {
  if (typeof document.version !== "number") {
    return null;
  }

  const cached = resourceReferenceCache.get(document);
  if (!cached || cached.fileName !== document.fileName || cached.version !== document.version) {
    return null;
  }

  return cached.references;
}

function setCachedResourceReferences(document: ResourceReferenceDocument, references: ResourceReference[]): void {
  if (typeof document.version === "number") {
    resourceReferenceCache.set(document, {
      fileName: document.fileName,
      version: document.version,
      references
    });
  }
}

function isShaderDocumentKind(kind: ResourceReferenceDocumentKind): boolean {
  return kind === "shaderCore" || kind === "shaderPost";
}

function getShaderDocumentSource(kind: ResourceReferenceDocumentKind): string {
  if (kind === "shaderCore") {
    return "shaders/core";
  }

  return "shaders/post";
}

function getLineStarts(text: string): number[] {
  const lineStarts = [0];
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function getLocationForOffsets(lineStarts: number[], startOffset: number, endOffset: number): AstLocation {
  const startLine = findLineIndex(lineStarts, startOffset);
  const endLine = findLineIndex(lineStarts, endOffset);

  return {
    start: {
      line: startLine + 1,
      column: startOffset - lineStarts[startLine]
    },
    end: {
      line: endLine + 1,
      column: endOffset - lineStarts[endLine]
    }
  };
}

function findLineIndex(lineStarts: number[], offset: number): number {
  for (let index = lineStarts.length - 1; index >= 0; index--) {
    if (lineStarts[index] <= offset) {
      return index;
    }
  }

  return 0;
}

function getResourceReferenceDocumentKind(fileName: string): ResourceReferenceDocumentKind | null {
  for (const { kind, pattern } of resourceReferenceDocumentPatterns) {
    if (pattern.test(fileName)) {
      return kind;
    }
  }

  return null;
}
