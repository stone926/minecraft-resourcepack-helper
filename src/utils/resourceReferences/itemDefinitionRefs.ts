import { arrayElements, getObjectMemberValue, JsonAstNode, JsonDocumentNode, memberName, objectMembers } from "../jsonAst";
import { getMinecraftType, pushReference } from "./shared";
import { ResourceReference } from "./types";

export function getItemDefinitionReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];
  const model = getObjectMemberValue(ast.body, "model");
  if (model) {
    collectItemModelReferences(model, references);
  }
  return references;
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
