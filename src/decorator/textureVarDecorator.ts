import * as vscode from "vscode";
import { isResourceSurfaceFile } from "../resources/resourceSurfaceRegistry";
import { modelSourceForFile } from "../services/modelParentChain";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { JsonAstNode, memberName, objectMembers } from "../utils/jsonAst";
import { jsonAstLocationToLineCharacterRange } from "../utils/astLocationRanges";
import {
  collectTextureVariableReferenceNodes,
  createTextureVariableDefinitionResolver
} from "../utils/modelTexture";
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

  for (const reference of collectTextureVariableReferenceNodes(ast.body)) {
    if (
      !textureDefinitions.has(reference.value.slice(1)) &&
      !textureVariableResolver.has(reference.value)
    ) {
      pushRange(ranges, reference.node);
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
  if (node?.loc) {
    const pair = jsonAstLocationToLineCharacterRange(node.loc);
    ranges.push(new vscode.Range(
      new vscode.Position(pair.start.line, pair.start.character),
      new vscode.Position(pair.end.line, pair.end.character)
    ));
  }
}
