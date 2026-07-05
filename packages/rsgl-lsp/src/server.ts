import { fileURLToPath } from "node:url";
import {
  CompletionItemKind,
  createConnection,
  DiagnosticSeverity,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem,
  type Diagnostic
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  compileRsglModule,
  formatRsglText,
  getRsglCompletionCandidates,
  parseRsgl,
  type RsglDiagnostic
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

connection.onInitialize(() => ({
  capabilities: {
    textDocumentSync: TextDocumentSyncKind.Incremental,
    completionProvider: {
      triggerCharacters: [" ", ".", ":", "@", "[", "("]
    },
    hoverProvider: true,
    documentFormattingProvider: true,
    definitionProvider: true,
    referencesProvider: true,
    renameProvider: true,
    documentSymbolProvider: true,
    workspaceSymbolProvider: true
  }
}));

documents.onDidOpen(event => validateDocument(event.document));
documents.onDidChangeContent(event => validateDocument(event.document));
documents.onDidClose(event => connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] }));

connection.onCompletion(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const offset = document.offsetAt(params.position);
  return getRsglCompletionCandidates(document.getText(), offset).map(toCompletionItem);
});

connection.onHover(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const offset = document.offsetAt(params.position);
  const word = document.getText().slice(0, offset).match(/[A-Za-z_][A-Za-z0-9_]*$/)?.[0];
  if (!word) {
    return null;
  }
  const candidate = getRsglCompletionCandidates(document.getText(), offset).find(item => item.label === word);
  return candidate?.detail ? { contents: candidate.detail } : null;
});

connection.onDocumentFormatting(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const text = document.getText();
  const formatted = formatRsglText(text, Number(params.options.tabSize) || 2);
  return formatted === text
    ? []
    : [{
      range: {
        start: document.positionAt(0),
        end: document.positionAt(text.length)
      },
      newText: formatted
    }];
});

connection.onDefinition(() => null);
connection.onReferences(() => []);
connection.onRenameRequest(() => null);
connection.onDocumentSymbol(() => []);
connection.onWorkspaceSymbol(() => []);

documents.listen(connection);
connection.listen();

function validateDocument(document: TextDocument): void {
  const fileName = fileNameFromUri(document.uri);
  const parsed = parseRsgl(document.getText());
  const result = compileRsglModule(parsed, {
    fileName,
    ...createRsglWorkspaceValidationOptions({
      sourceFileName: fileName
    })
  });
  connection.sendDiagnostics({
    uri: document.uri,
    diagnostics: result.diagnostics.map(diagnostic => toLspDiagnostic(document, diagnostic))
  });
}

function toCompletionItem(candidate: ReturnType<typeof getRsglCompletionCandidates>[number]): CompletionItem {
  return {
    label: candidate.label,
    kind: toCompletionKind(candidate.kind),
    detail: candidate.detail,
    insertText: candidate.insertText
  };
}

function toCompletionKind(kind: ReturnType<typeof getRsglCompletionCandidates>[number]["kind"]): CompletionItemKind {
  if (kind === "snippet") {
    return CompletionItemKind.Snippet;
  }
  if (kind === "function") {
    return CompletionItemKind.Function;
  }
  if (kind === "constant") {
    return CompletionItemKind.Constant;
  }
  if (kind === "property") {
    return CompletionItemKind.Property;
  }
  return CompletionItemKind.Keyword;
}

function toLspDiagnostic(document: TextDocument, diagnostic: RsglDiagnostic): Diagnostic {
  const start = clampOffset(document, diagnostic.range.start);
  const end = Math.max(start + 1, clampOffset(document, diagnostic.range.end));
  return {
    range: {
      start: document.positionAt(start),
      end: document.positionAt(end)
    },
    severity: toLspSeverity(diagnostic.severity),
    code: diagnostic.code,
    source: "RSGL",
    message: diagnostic.message
  };
}

function toLspSeverity(severity: RsglDiagnostic["severity"]): DiagnosticSeverity {
  if (severity === "warning") {
    return DiagnosticSeverity.Warning;
  }
  if (severity === "info") {
    return DiagnosticSeverity.Information;
  }
  return DiagnosticSeverity.Error;
}

function clampOffset(document: TextDocument, offset: number): number {
  return Math.max(0, Math.min(document.getText().length, offset));
}

function fileNameFromUri(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}
