import { Position, Range, TextDocument } from "vscode";
import { arrayElements, JsonAstNode, JsonDocumentNode, memberName, objectMembers, parseJsonAst, stringValue } from "./jsonAst";
import { isInArea } from "./locationChecker";

export interface ResourceReference {
  value: string;
  valueNode: JsonAstNode;
  target: string;
  source: string;
  extension: string;
  kind: "model" | "texture";
}

export function getResourceReferences(document: TextDocument): ResourceReference[] {
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

  return [];
}

export function findResourceReferenceAtPosition(document: TextDocument, position: Position): ResourceReference | null {
  const line = position.line + 1;
  const character = position.character + 1;

  return getResourceReferences(document).find(reference => isInArea(line, character, reference.valueNode?.loc)) ?? null;
}

export function rangeInsideString(node: JsonAstNode): Range | null {
  if (!node?.loc) {
    return null;
  }

  return new Range(
    new Position(node.loc.start.line - 1, node.loc.start.column),
    new Position(node.loc.end.line - 1, Math.max(node.loc.start.column, node.loc.end.column - 2))
  );
}

export function rangeIncludingString(node: JsonAstNode): Range | null {
  if (!node?.loc) {
    return null;
  }

  return new Range(
    new Position(node.loc.start.line - 1, node.loc.start.column - 1),
    new Position(node.loc.end.line - 1, node.loc.end.column - 1)
  );
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
  extension: string,
  kind: "model" | "texture"
) {
  const value = stringValue(valueNode);
  if (value) {
    references.push({ value, valueNode, target, source, extension, kind });
  }
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
