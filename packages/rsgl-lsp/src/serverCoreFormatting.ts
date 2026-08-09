import type {
  FormattingOptions,
  TextEdit
} from "vscode-languageserver/node";
import {
  formatRsglText,
  normalizeRsglFormattingConfiguration,
  type RsglFormattingConfiguration,
  type RsglFormatOptions
} from "../../rsgl-core/src";
import type { RsglLspDocument } from "./serverCoreDocuments";

/** Formats a document and converts the result into an LSP full-document edit. */
export function formattingEditsForDocument(
  document: RsglLspDocument,
  options: FormattingOptions | number,
  formatting?: RsglFormattingConfiguration
): TextEdit[] {
  const text = document.getText();
  const editorOptions: FormattingOptions = typeof options === "number"
    ? { tabSize: options, insertSpaces: true }
    : options;
  const formatOptions: RsglFormatOptions = {
    ...normalizeRsglFormattingConfiguration(formatting),
    tabSize: Number.isFinite(editorOptions.tabSize) && editorOptions.tabSize > 0
      ? Math.round(editorOptions.tabSize)
      : 2,
    insertSpaces: editorOptions.insertSpaces !== false,
    trimTrailingWhitespace: editorOptions.trimTrailingWhitespace ?? false,
    trimFinalNewlines: editorOptions.trimFinalNewlines ?? false,
    ...(typeof editorOptions.insertFinalNewline === "boolean"
      ? { insertFinalNewline: editorOptions.insertFinalNewline }
      : {})
  };
  const formatted = formatRsglText(text, formatOptions);
  return formatted === text
    ? []
    : [{
      range: {
        start: document.positionAt(0),
        end: document.positionAt(text.length)
      },
      newText: formatted
    }];
}
