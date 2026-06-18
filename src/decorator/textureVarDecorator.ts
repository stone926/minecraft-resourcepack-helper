import * as vscode from "vscode";
import { arrayElements, memberName, objectMembers, parseJsonAst, stringValue } from "../utils/jsonAst";

let tipColor = <string>vscode.workspace.getConfiguration().get("McResHelper.tipColorForUndefinedTextureVariables");
let decorationType: vscode.TextEditorDecorationType = vscode.window.createTextEditorDecorationType({
  color: tipColor
});

export function applyDecoration(editor: vscode.TextEditor) {
  if (editor.document.languageId !== "json" || !isBlockModelFile(editor.document.uri.fsPath)) {
    editor.setDecorations(decorationType, []);
    return;
  }

  const ast = parseJsonAst(editor.document.getText());
  if (!ast) {
    editor.setDecorations(decorationType, []);
    return;
  }

  const texturesAst = objectMembers(ast.body).find(member => memberName(member) === "textures");
  const textureDefinitions = new Set(
    objectMembers(texturesAst?.value)
      .map(member => memberName(member))
      .filter((name): name is string => typeof name === "string" && name !== "particle")
  );
  const ranges: vscode.Range[] = [];

  for (const item of objectMembers(ast.body)) {
    if (memberName(item) !== "elements") {
      continue;
    }

    for (const element of arrayElements(item.value)) {
      const faces = objectMembers(element).find(member => memberName(member) === "faces");
      for (const face of objectMembers(faces?.value)) {
        const textureEntry = objectMembers(face.value).find(member => memberName(member) === "texture");
        const textureReference = stringValue(textureEntry?.value);
        if (textureReference?.startsWith("#") && !textureDefinitions.has(textureReference.slice(1))) {
          pushRange(ranges, textureEntry.value);
        }
      }
    }
  }

  for (const texture of objectMembers(texturesAst?.value)) {
    const value = stringValue(texture.value);
    if (value?.startsWith("#") && !textureDefinitions.has(value.slice(1))) {
      pushRange(ranges, texture.value);
    }
  }

  editor.setDecorations(decorationType, ranges);
}

export function updateDecoration(editor: vscode.TextEditor) {
  tipColor = <string>vscode.workspace.getConfiguration().get("McResHelper.tipColorForUndefinedTextureVariables");
  editor.setDecorations(decorationType, []);
  decorationType.dispose();
  decorationType = vscode.window.createTextEditorDecorationType({
    color: tipColor
  });
  applyDecoration(editor);
}

export function disposeDecoration() {
  decorationType.dispose();
}

function isBlockModelFile(filePath: string): boolean {
  return /[\\/]models[\\/]block[\\/].+\.json$/i.test(filePath);
}

function pushRange(ranges: vscode.Range[], node: any) {
  if (!node?.loc) {
    return;
  }

  ranges.push(new vscode.Range(
    new vscode.Position(node.loc.start.line - 1, node.loc.start.column - 1),
    new vscode.Position(node.loc.end.line - 1, node.loc.end.column - 1)
  ));
}
