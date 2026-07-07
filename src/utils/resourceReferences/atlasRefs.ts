import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers } from "../jsonAst";
import { getObjectString, pushReference } from "./shared";
import { ResourceReference } from "./types";

export function getAtlasReferences(ast: JsonDocumentNode): ResourceReference[] {
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
