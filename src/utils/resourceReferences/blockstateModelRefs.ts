import { getCitDocumentSource } from "../citPaths";
import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers, stringValue } from "../jsonAst";
import { pushReference } from "./shared";
import { ResourceReference } from "./types";

export function getBlockstateReferences(ast: JsonDocumentNode): ResourceReference[] {
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

export function getModelReferences(ast: JsonDocumentNode, source: string): ResourceReference[] {
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

export function getCitModelReferences(ast: JsonDocumentNode, fileName: string): ResourceReference[] {
  const source = getCitDocumentSource(fileName);
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

function pushModelPropertyReferences(references: ResourceReference[], node: JsonAstNode, source: string) {
  for (const modelEntry of objectMembers(node)) {
    if (memberName(modelEntry) === "model") {
      pushReference(references, modelEntry.value, "models", source, "json", "model");
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
