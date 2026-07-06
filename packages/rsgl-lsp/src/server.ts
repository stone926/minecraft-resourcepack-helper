import * as path from "node:path";
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
  compileRsglProgram,
  formatRsglText,
  getRsglCompletionCandidates,
  parseRsgl,
  RsglWorkspaceSemanticCache,
  type RsglDiagnostic,
  type RsglSemanticModel,
  type RsglSymbol
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const semanticCache = RsglWorkspaceSemanticCache.create();

semanticCache.setOpenTextDocumentProvider(fileName => openDocumentForFileName(fileName));

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

documents.onDidOpen(event => {
  invalidateDocument(event.document);
  refreshOpenDocuments();
});
documents.onDidChangeContent(event => {
  invalidateDocument(event.document);
  refreshOpenDocuments();
});
documents.onDidClose(event => {
  semanticCache.invalidatePath(fileNameFromUri(event.document.uri));
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  refreshOpenDocuments(event.document.uri);
});

connection.onDidChangeWatchedFiles(params => {
  for (const change of params.changes) {
    semanticCache.invalidatePath(fileNameFromUri(change.uri));
  }
  refreshOpenDocuments();
});

connection.onCompletion(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const offset = document.offsetAt(params.position);
  return completionItemsForDocument(document, offset);
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
  const candidate = completionItemsForDocument(document, offset).find(item => item.label === word);
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
  const currentFileName = normalizeFileName(path.resolve(fileName));
  const semanticProgram = semanticCache.loadProgramFromEntry(fileName);
  if (semanticProgram.files.length > 0) {
    const result = compileRsglProgram(semanticProgram.files, {
      entryFileName: fileName,
      semanticProgram: semanticProgram.program,
      ...createRsglWorkspaceValidationOptions({
        sourceFileName: fileName
      })
    });
    const diagnostics = result.diagnostics
      .filter(diagnostic => !diagnostic.fileName || normalizeFileName(path.resolve(diagnostic.fileName)) === currentFileName)
      .map(diagnostic => toLspDiagnostic(document, diagnostic));
    connection.sendDiagnostics({ uri: document.uri, diagnostics });
    return;
  }

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

function refreshOpenDocuments(excludeUri?: string): void {
  for (const document of documents.all()) {
    if (document.uri === excludeUri) {
      continue;
    }
    validateDocument(document);
  }
}

function invalidateDocument(document: TextDocument): void {
  semanticCache.invalidatePath(fileNameFromUri(document.uri));
}

function completionItemsForDocument(document: TextDocument, offset: number): CompletionItem[] {
  const items = new Map<string, CompletionItem>();
  for (const candidate of getRsglCompletionCandidates(document.getText(), offset)) {
    items.set(candidate.label, toCompletionItem(candidate));
  }
  for (const symbol of semanticSymbolsForDocument(document)) {
    if (!items.has(symbol.name)) {
      items.set(symbol.name, symbolCompletionItem(symbol));
    }
  }
  return [...items.values()];
}

function semanticSymbolsForDocument(document: TextDocument): RsglSymbol[] {
  const model = semanticModelForDocument(document);
  return model?.symbols ?? [];
}

function semanticModelForDocument(document: TextDocument): RsglSemanticModel | undefined {
  const fileName = fileNameFromUri(document.uri);
  const normalized = normalizeFileName(path.resolve(fileName));
  const semanticProgram = semanticCache.loadProgramFromEntry(fileName);
  return semanticProgram.program.models.find(model => normalizeFileName(path.resolve(model.fileName)) === normalized);
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

function symbolCompletionItem(symbol: RsglSymbol): CompletionItem {
  return {
    label: symbol.name,
    kind: symbol.kind === "template" ? CompletionItemKind.Function
      : symbol.kind === "table" ? CompletionItemKind.Struct
        : symbol.kind === "resource" ? CompletionItemKind.File
          : CompletionItemKind.Variable,
    detail: `${symbol.kind}: ${formatSymbolType(symbol)}`
  };
}

function formatSymbolType(symbol: RsglSymbol): string {
  if (symbol.signature) {
    return "function";
  }
  return symbol.type.kind;
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

function openDocumentForFileName(fileName: string): { fileName: string; version?: number; getText(): string } | null {
  const normalized = normalizeFileName(path.resolve(fileName));
  const document = documents.all().find(item => {
    if (!item.uri.startsWith("file:")) {
      return false;
    }
    return normalizeFileName(path.resolve(fileNameFromUri(item.uri))) === normalized;
  });
  return document
    ? {
      fileName: normalized,
      version: document.version,
      getText: () => document.getText()
    }
    : null;
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}
