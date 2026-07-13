import * as path from "node:path";
import { findByNormalizedPath } from "../../mc-assets/src";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  formatRsglText,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  RsglWorkspaceSemanticCache,
  type CompileDependency
} from "../../rsgl-core/src";
import {
  rsglDependencyPathsNotification,
  type RsglDependencyPathsNotification
} from "../../rsgl-shared/src";
import {
  completionItemsForDocument as completionItemsForDocumentCore,
  computeDocumentDiagnostics,
  computeDocumentSemanticTokens,
  dependencyPathsForDocument,
  dependencyPathsForDocuments,
  documentsDependingOnPath,
  fileNameFromUri,
  handleSemanticWatchedFileBatch,
  normalizeFileName,
  projectSemanticConfigurationFingerprint,
  toValidationSettings,
  type RsglValidationSettings
} from "./serverCore";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const semanticCache = RsglWorkspaceSemanticCache.create();
const dependenciesByDocument = new Map<string, Set<string>>();
let publishedDependencyPaths = "";

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
      documentFormattingProvider: true,
      semanticTokensProvider: {
        legend: {
          tokenTypes: [...rsglSemanticTokenTypes],
          tokenModifiers: [...rsglSemanticTokenModifiers]
        },
        full: true
      }
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
  dependenciesByDocument.delete(event.document.uri);
  publishDependencyPaths();
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  refreshOpenDocuments(event.document.uri);
});

connection.onDidChangeWatchedFiles(params => {
  const changedFileNames = params.changes.map(change => fileNameFromUri(change.uri));
  if (handleSemanticWatchedFileBatch(changedFileNames, {
    invalidatePath: fileName => semanticCache.invalidatePath(fileName),
    refresh: refreshOpenDocuments
  })) {
    return;
  }

  const affectedUris = new Set<string>();
  for (const changedFileName of changedFileNames) {
    if (path.extname(changedFileName).toLowerCase() !== ".json") {
      continue;
    }
    for (const uri of documentsDependingOnPath(dependenciesByDocument, changedFileName)) {
      affectedUris.add(uri);
    }
  }
  for (const uri of affectedUris) {
    const document = documents.get(uri);
    if (document) {
      validateDocument(document);
    }
  }
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

connection.languages.semanticTokens.on(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  return {
    data: computeDocumentSemanticTokens(document, fileNameFromUri(document.uri), {
      loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName)
    })
  };
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
  let compileDependencies: readonly CompileDependency[] = [];
  let projectConfigWatchPaths: readonly string[] = [];
  const diagnostics = computeDocumentDiagnostics(document, fileName, {
    loadProgramFromEntry: (entryFileName, fingerprint) =>
      loadSemanticProgram(entryFileName, fingerprint),
    onDependencies: dependencies => {
      compileDependencies = dependencies;
    },
    onProjectConfigWatchPaths: paths => {
      projectConfigWatchPaths = paths;
    },
    settings: validationSettings
  });
  dependenciesByDocument.set(
    document.uri,
    dependencyPathsForDocument(compileDependencies, projectConfigWatchPaths)
  );
  publishDependencyPaths();
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
}

function refreshOpenDocuments(excludeUri?: string): void {
  for (const document of documents.all()) {
    if (document.uri === excludeUri) {
      continue;
    }
    validateDocument(document);
  }
  // Cross-file edits can reclassify identifiers in other open documents.
  connection.languages.semanticTokens.refresh();
}

function invalidateDocument(document: TextDocument): void {
  semanticCache.invalidatePath(fileNameFromUri(document.uri));
}

function completionItemsForDocument(document: TextDocument, offset: number): CompletionItem[] {
  return completionItemsForDocumentCore(document, fileNameFromUri(document.uri), offset, {
    loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName)
  });
}

function loadSemanticProgram(
  entryFileName: string,
  semanticConfigurationFingerprint?: string
) {
  let fingerprint = semanticConfigurationFingerprint;
  if (!fingerprint) {
    try {
      fingerprint = projectSemanticConfigurationFingerprint(entryFileName);
    } catch {
      // Diagnostics report malformed project config; language features keep
      // using the default semantic identity instead of failing outright.
    }
  }
  return semanticCache.loadProgramFromEntry(entryFileName, fingerprint
    ? { semanticConfigurationFingerprint: fingerprint }
    : {});
}

function publishDependencyPaths(): void {
  const paths = dependencyPathsForDocuments(dependenciesByDocument);
  const identity = JSON.stringify(paths);
  if (identity === publishedDependencyPaths) {
    return;
  }
  publishedDependencyPaths = identity;
  const notification: RsglDependencyPathsNotification = { paths };
  void connection.sendNotification(rsglDependencyPathsNotification, notification);
}

function openDocumentForFileName(fileName: string): { fileName: string; version?: number; getText(): string } | null {
  const document = findByNormalizedPath(
    documents.all(),
    path.resolve(fileName),
    item => item.uri.startsWith("file:") ? path.resolve(fileNameFromUri(item.uri)) : null
  );
  return document
    ? {
      fileName: normalizeFileName(path.resolve(fileName)),
      version: document.version,
      getText: () => document.getText()
    }
    : null;
}
