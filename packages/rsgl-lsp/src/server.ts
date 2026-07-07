import * as path from "node:path";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import { formatRsglText, RsglWorkspaceSemanticCache, type RsglSymbol } from "../../rsgl-core/src";
import {
  completionItemsForContent,
  computeDocumentDiagnostics,
  fileNameFromUri,
  normalizeFileName,
  semanticModelForFile,
  toValidationSettings,
  type RsglValidationSettings
} from "./serverCore";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const semanticCache = RsglWorkspaceSemanticCache.create();

let validationSettings: RsglValidationSettings = { defaultAssetsPath: null, resourcePackRoots: [] };

semanticCache.setOpenTextDocumentProvider(fileName => openDocumentForFileName(fileName));

connection.onInitialize(params => {
  validationSettings = toValidationSettings(params.initializationOptions);
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        triggerCharacters: [" ", ".", ":", "@", "[", "("]
      },
      hoverProvider: true,
      documentFormattingProvider: true
    }
  };
});

connection.onDidChangeConfiguration(params => {
  validationSettings = toValidationSettings(params.settings);
  refreshOpenDocuments();
});

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

documents.listen(connection);
connection.listen();

function validateDocument(document: TextDocument): void {
  const fileName = fileNameFromUri(document.uri);
  const diagnostics = computeDocumentDiagnostics(document, fileName, {
    loadProgramFromEntry: entryFileName => semanticCache.loadProgramFromEntry(entryFileName),
    settings: validationSettings
  });
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
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
  return completionItemsForContent(document.getText(), offset, semanticSymbolsForDocument(document));
}

function semanticSymbolsForDocument(document: TextDocument): RsglSymbol[] {
  const fileName = fileNameFromUri(document.uri);
  const semanticProgram = semanticCache.loadProgramFromEntry(fileName);
  return semanticModelForFile(semanticProgram, fileName)?.symbols ?? [];
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
