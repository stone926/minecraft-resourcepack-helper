import * as vscode from "vscode";
import { formatRsglText } from "../../../packages/rsgl-core/src/formatterCore";

export { formatRsglText };

export const rsglFormattingProvider = {
  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    options: vscode.FormattingOptions,
    token: vscode.CancellationToken
  ): vscode.TextEdit[] {
    if (token?.isCancellationRequested) {
      return [];
    }

    const formatted = formatRsglText(document.getText(), Number(options.tabSize) || 2);
    if (formatted === document.getText()) {
      return [];
    }

    return [vscode.TextEdit.replace(fullDocumentRange(document), formatted)];
  }
};

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  if (document.lineCount === 0) {
    return new vscode.Range(0, 0, 0, 0);
  }

  return new vscode.Range(
    document.lineAt(0).rangeIncludingLineBreak.start,
    document.lineAt(document.lineCount - 1).rangeIncludingLineBreak.end
  );
}
