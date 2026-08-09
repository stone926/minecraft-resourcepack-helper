import * as vscode from "vscode";
import { isResourceSurfaceFile } from "../resources/resourceSurfaceRegistry";
import { modelSourceForFile } from "../services/modelParentChain";
import { workspaceResourceCache } from "../services/workspaceResourceCache";
import { createTextureVariableDefinitionResolver } from "../utils/modelTexture";
import { getResourceConfiguration } from "../utils/resourceConfiguration";
import { resourceConfigurationKeys } from "../utils/resourceConfigurationKeys";
import { collectUndefinedTextureVariableRanges } from "./textureVarDecorationCore";

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

  const modelSource = modelSourceForFile(editor.document.fileName);
  const textureVariableResolver = createTextureVariableDefinitionResolver(ast, editor.document, getResourceConfiguration, modelSource);
  const ranges = collectUndefinedTextureVariableRanges(
    ast,
    reference => textureVariableResolver.has(reference)
  ).map(range => new vscode.Range(
    new vscode.Position(range.start.line, range.start.character),
    new vscode.Position(range.end.line, range.end.character)
  ));

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
