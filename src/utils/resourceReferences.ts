import type { Position } from "vscode";
import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers, parseJsonAst, stringValue } from "./jsonAst";
import { isInArea } from "./locationChecker";

export interface ResourceReference {
  value: string;
  valueNode: JsonAstNode;
  target: string;
  source: string;
  extension: string | null;
  kind: "model" | "texture" | "textureDirectory";
}

export interface ResourceReferenceDocument {
  languageId: string;
  fileName: string;
  getText(): string;
}

export function getResourceReferences(document: ResourceReferenceDocument): ResourceReference[] {
  if (document.languageId !== "json") {
    return [];
  }

  const ast = parseJsonAst(document.getText());
  if (!ast) {
    return [];
  }

  if (isFileInFolder(document.fileName, "blockstates")) {
    return getBlockstateReferences(ast);
  }

  if (isFileInNestedFolder(document.fileName, "models", "block")) {
    return getModelReferences(ast, "models/block");
  }

  if (isFileInNestedFolder(document.fileName, "models", "item")) {
    return getItemModelReferences(ast);
  }

  if (isFileInFolder(document.fileName, "particles")) {
    return getParticleReferences(ast);
  }

  if (isFileInFolder(document.fileName, "items")) {
    return getItemDefinitionReferences(ast);
  }

  if (isFileInFolder(document.fileName, "atlases")) {
    return getAtlasReferences(ast);
  }

  if (isFileInFolder(document.fileName, "equipment")) {
    return getEquipmentReferences(ast);
  }

  return [];
}

export function findResourceReferenceAtPosition(document: ResourceReferenceDocument, position: Position): ResourceReference | null {
  const line = position.line + 1;
  const character = position.character + 1;

  return getResourceReferences(document).find(reference => isInArea(line, character, reference.valueNode?.loc)) ?? null;
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
      pushReference(references, item.value, "models", source, "json", "model");
    } else if (memberName(item) === "textures") {
      for (const textureEntry of objectMembers(item.value)) {
        pushReference(references, textureEntry.value, "textures", source, "png", "texture");
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
  collectItemModelReferences(ast.body, references);
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

function collectItemModelReferences(node: JsonAstNode, references: ResourceReference[]) {
  for (const member of objectMembers(node)) {
    if (memberName(member) === "model") {
      pushReference(references, member.value, "models", "items", "json", "model");
    }
    collectItemModelReferences(member.value, references);
  }

  for (const element of arrayElements(node)) {
    collectItemModelReferences(element, references);
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
  kind: "model" | "texture" | "textureDirectory"
): void {
  const value = stringValue(valueNode);
  if (value) {
    references.push({ value, valueNode, target, source, extension, kind });
  }
}

function getObjectString(node: JsonAstNode, name: string): string | null {
  const member = objectMembers(node).find(item => memberName(item) === name);
  return stringValue(member?.value) ?? null;
}

function isFileInFolder(fileName: string, folder: string): boolean {
  return new RegExp(`[\\\\/]${escapeRegExp(folder)}[\\\\/].+\\.json$`, "i").test(fileName);
}

function isFileInNestedFolder(fileName: string, firstFolder: string, secondFolder: string): boolean {
  return new RegExp(`[\\\\/]${escapeRegExp(firstFolder)}[\\\\/]${escapeRegExp(secondFolder)}[\\\\/].+\\.json$`, "i").test(fileName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
