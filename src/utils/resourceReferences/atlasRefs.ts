import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers } from "../jsonAst";
import { getMinecraftType, getObjectMemberValue, pushReference } from "./shared";
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
  const type = getMinecraftType(sourceEntry);

  if (type === "directory") {
    const source = getObjectMemberValue(sourceEntry, "source");
    if (source) {
      pushReference(references, source, "textures", "atlases", null, "textureDirectory");
    }
    return;
  }

  if (type === "single" || type === "unstitch") {
    pushAtlasTextureMemberReference(sourceEntry, "resource", references);
    return;
  }

  if (type === "paletted_permutations") {
    pushAtlasTextureMemberReference(sourceEntry, "palette_key", references);

    const permutations = getObjectMemberValue(sourceEntry, "permutations");
    for (const permutation of objectMembers(permutations)) {
      pushReference(references, permutation.value, "textures", "atlases", "png", "texture");
    }

    const textures = getObjectMemberValue(sourceEntry, "textures");
    for (const texture of arrayElements(textures)) {
      pushReference(references, texture, "textures", "atlases", "png", "texture");
    }
  }
}

function pushAtlasTextureMemberReference(
  sourceEntry: JsonAstNode,
  member: string,
  references: ResourceReference[]
): void {
  const value = getObjectMemberValue(sourceEntry, member);
  if (value) {
    pushReference(references, value, "textures", "atlases", "png", "texture");
  }
}
