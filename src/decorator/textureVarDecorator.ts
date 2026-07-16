import * as vscode from "vscode";
import { isResourceSurfaceFile } from "../resources/resourceSurfaceRegistry";
import { modelSourceForFile } from "../services/modelParentChain";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { arrayElements, JsonAstNode, memberName, objectMembers, stringValue } from "../utils/jsonAst";
import { createTextureVariableDefinitionResolver } from "../utils/modelTexture";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { resourceConfigurationKeys } from "../utils/resourceConfigurationKeys";

let decorationType: vscode.TextEditorDecorationType | null = null;

export function applyDecoration(editor: vscode.TextEditor): void {
  const currentDecorationType = getDecorationType();
  if (
    editor.document.languageId !== "json"
    || !isResourceSurfaceFile(editor.document.uri.fsPath, "textureVariables")
  ) {
    editor.setDecorations(currentDecorationType, []);
    return;
  }

  const ast = workspaceResourceCache.getJsonAst(editor.document);
  if (!ast) {
    editor.setDecorations(currentDecorationType, []);
    return;
  }

  const texturesAst = objectMembers(ast.body).find(member => memberName(member) === "textures");
  const modelSource = modelSourceForFile(editor.document.fileName);
  const textureDefinitions = new Set(
    objectMembers(texturesAst?.value)
      .map(member => memberName(member))
      .filter((name): name is string => typeof name === "string" && name !== "particle")
  );
  const ranges: vscode.Range[] = [];
  const textureVariableResolver = createTextureVariableDefinitionResolver(ast, editor.document, getResourceConfiguration, modelSource);

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) !== "elements") {
      continue;
    }

    for (const element of arrayElements(item.value)) {
      const faces = objectMembers(element).find(member => memberName(member) === "faces");
      for (const face of objectMembers(faces?.value)) {
        const textureEntry = objectMembers(face.value).find(member => memberName(member) === "texture");
        const textureReference = stringValue(textureEntry?.value);
        if (
          textureEntry &&
          textureReference?.startsWith("#") &&
          !textureDefinitions.has(textureReference.slice(1)) &&
          !textureVariableResolver.has(textureReference)
        ) {
          pushRange(ranges, textureEntry.value);
        }
      }
    }
  }

  for (const texture of objectMembers(texturesAst?.value)) {
    const value = stringValue(texture.value);
    if (
      value?.startsWith("#") &&
      !textureDefinitions.has(value.slice(1)) &&
      !textureVariableResolver.has(value)
    ) {
      pushRange(ranges, texture.value);
    }
  }

  editor.setDecorations(currentDecorationType, ranges);
}

export function updateDecoration(editor: vscode.TextEditor): void {
  const currentDecorationType = getDecorationType();
  editor.setDecorations(currentDecorationType, []);
  currentDecorationType.dispose();
  decorationType = createDecorationType();
  applyDecoration(editor);
}

export function disposeDecoration(): void {
  decorationType?.dispose();
  decorationType = null;
}

function getDecorationType(): vscode.TextEditorDecorationType {
  decorationType ??= createDecorationType();
  return decorationType;
}

function createDecorationType(): vscode.TextEditorDecorationType {
  const color = vscode.workspace.getConfiguration().get<string>(
    resourceConfigurationKeys.undefinedTextureVariableColor
  ) ?? "Chartreuse";
  return vscode.window.createTextEditorDecorationType({ color });
}

function pushRange(ranges: vscode.Range[], node: JsonAstNode | null | undefined): void {
  if (!node?.loc) {
    return;
  }

  ranges.push(new vscode.Range(
    new vscode.Position(node.loc.start.line - 1, node.loc.start.column - 1),
    new vscode.Position(node.loc.end.line - 1, node.loc.end.column - 1)
  ));
}
