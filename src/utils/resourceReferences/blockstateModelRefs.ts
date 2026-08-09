import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers, stringValue } from "../jsonAst";
import { pushReference } from "./shared";
import { ResourceReference } from "./types";

export function getBlockstateReferences(ast: JsonDocumentNode): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "variants") {
      for (const variantEntry of objectMembers(item.value)) {
        pushBlockstateModelVariantReferences(references, variantEntry.value);
      }
    } else if (memberName(item) === "multipart") {
      for (const multipartEntry of arrayElements(item.value)) {
        for (const applyEntry of objectMembers(multipartEntry)) {
          if (memberName(applyEntry) === "apply") {
            pushBlockstateModelVariantReferences(references, applyEntry.value);
          }
        }
      }
    }
  }

  return references;
}

export function getModelReferences(ast: JsonDocumentNode, source: string): ResourceReference[] {
  const references: ResourceReference[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "parent") {
      pushReference(references, item.value, "models", source, "model", { relationship: "modelParent" });
    } else if (memberName(item) === "textures") {
      for (const textureEntry of objectMembers(item.value)) {
        pushModelTextureReference(references, textureEntry.value, source);
      }
    }
  }

  return references;
}

export function getItemModelReferences(ast: JsonDocumentNode): ResourceReference[] {
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

export function getCitModelReferences(ast: JsonDocumentNode, source: string): ResourceReference[] {
  const references = getModelReferences(ast, source);

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) === "overrides") {
      for (const overrideEntry of arrayElements(item.value)) {
        pushModelPropertyReferences(references, overrideEntry, source);
      }
    }
  }

  return references.map(reference => ({
    ...reference,
    resolveMode: "cit" as const
  }));
}

function pushBlockstateModelVariantReferences(references: ResourceReference[], node: JsonAstNode): void {
  if (node.type === "Object") {
    pushModelPropertyReferences(references, node, "blockstates");
    return;
  }

  for (const modelVariant of arrayElements(node)) {
    pushModelPropertyReferences(references, modelVariant, "blockstates");
  }
}

function pushModelPropertyReferences(references: ResourceReference[], node: JsonAstNode, source: string) {
  for (const modelEntry of objectMembers(node)) {
    if (memberName(modelEntry) === "model") {
      pushReference(references, modelEntry.value, "models", source, "model");
    }
  }
}

function pushModelTextureReference(references: ResourceReference[], valueNode: JsonAstNode, source: string): void {
  const directTexture = stringValue(valueNode);
  if (directTexture !== undefined) {
    pushReference(references, valueNode, "textures", source, "texture");
    return;
  }

  const sprite = objectMembers(valueNode).find(member => memberName(member) === "sprite");
  if (sprite) {
    pushReference(references, sprite.value, "textures", source, "texture");
  }
}
