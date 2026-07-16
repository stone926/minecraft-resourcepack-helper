import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findByNormalizedPath } from "../../mc-assets/src";
import {
  CodeActionKind,
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type CompletionItem
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  RsglProjectTargetCache,
  RsglWorkspaceSemanticCache,
  type CompileDependency
} from "../../rsgl-core/src";
import {
  rsglDependencyPathsNotification,
  type RsglDependencyPathsNotification
} from "../../rsgl-shared/src";
import {
  completionItemsForDocument as completionItemsForDocumentCore,
  codeActionsForDiagnostics,
  computeDocumentDiagnostics,
  computeDocumentHover,
  computeDocumentSignatureHelp,
  computeDocumentSemanticTokens,
  definitionLocationForDocument,
  dependencyPathsForDocument,
  dependencyPathsForDocuments,
  documentsDependingOnPath,
  fileNameFromUri,
  formattingEditsForDocument,
  handleSemanticWatchedFileBatch,
  normalizeFileName,
  projectSemanticConfigurationFingerprint,
  prepareRenameForDocument,
  renameEditsForDocument,
  toLspDefinitionLocation,
  toLspWorkspaceEdit,
  toValidationSettings,
  type RsglValidationSettings
} from "./serverCore";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const semanticCache = RsglWorkspaceSemanticCache.create();
const projectTargetCache = new RsglProjectTargetCache();
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
        triggerCharacters: [" ", ".", ":", "[", "("]
      },
      hoverProvider: true,
      signatureHelpProvider: {
        triggerCharacters: ["(", ",", ":"],
        retriggerCharacters: [","]
      },
      definitionProvider: true,
      codeActionProvider: {
        codeActionKinds: [CodeActionKind.QuickFix]
      },
      renameProvider: { prepareProvider: true },
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
  scheduleOpenDocumentRefresh();
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
    invalidateProjectConfiguration: () => projectTargetCache.invalidateAll(),
    refresh: refreshOpenDocuments
  })) {
    return;
  }

  const affectedUris = new Set<string>();
  for (const changedFileName of changedFileNames) {
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

connection.onCodeAction(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document || (params.context.only?.length
    && !params.context.only.some(kind => kind === CodeActionKind.QuickFix))) {
    return [];
  }
  return codeActionsForDiagnostics(document, params.textDocument.uri, params.context.diagnostics);
});

connection.onHover(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const offset = document.offsetAt(params.position);
  return computeDocumentHover(document, fileNameFromUri(document.uri), offset, {
    ...documentLanguageWorkspace()
  });
});

connection.onSignatureHelp(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  return computeDocumentSignatureHelp(
    document,
    fileNameFromUri(document.uri),
    document.offsetAt(params.position),
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
});

connection.onDefinition(async params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const definition = definitionLocationForDocument(
    document,
    fileNameFromUri(document.uri),
    document.offsetAt(params.position),
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
  if (!definition) {
    return null;
  }
  const targetDocument = await loadDefinitionDocument(definition.fileName);
  return targetDocument
    ? toLspDefinitionLocation(targetDocument, targetDocument.uri, definition)
    : null;
});

connection.onPrepareRename(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  return prepareRenameForDocument(
    document,
    fileNameFromUri(document.uri),
    document.offsetAt(params.position),
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
});

connection.onRenameRequest(async params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const edits = renameEditsForDocument(
    document,
    fileNameFromUri(document.uri),
    document.offsetAt(params.position),
    params.newName,
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
  return edits ? toLspWorkspaceEdit(edits, loadDefinitionDocument) : null;
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
  return formattingEditsForDocument(document, params.options.tabSize);
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
  cancelScheduledOpenDocumentRefresh();
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
  return completionItemsForDocumentCore(
    document,
    fileNameFromUri(document.uri),
    offset,
    documentLanguageWorkspace()
  );
}

let openDocumentRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleOpenDocumentRefresh(delay = 150): void {
  cancelScheduledOpenDocumentRefresh();
  openDocumentRefreshTimer = setTimeout(() => {
    openDocumentRefreshTimer = null;
    refreshOpenDocuments();
  }, delay);
}

function cancelScheduledOpenDocumentRefresh(): void {
  if (openDocumentRefreshTimer) {
    clearTimeout(openDocumentRefreshTimer);
    openDocumentRefreshTimer = null;
  }
}

function documentLanguageWorkspace() {
  return {
    loadProgramFromEntry: (entryFileName: string) => loadSemanticProgram(entryFileName),
    projectItemModelTargetFormatForSource: (sourceFileName: string) =>
      projectTargetCache.projectItemModelTargetFormatForSource(sourceFileName)
  };
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

async function loadDefinitionDocument(fileName: string): Promise<TextDocument | null> {
  const openDocument = findByNormalizedPath(
    documents.all(),
    path.resolve(fileName),
    item => item.uri.startsWith("file:") ? path.resolve(fileNameFromUri(item.uri)) : null
  );
  if (openDocument) {
    return openDocument;
  }
  try {
    const normalizedFileName = path.resolve(fileName);
    const text = await readFile(normalizedFileName, "utf8");
    return TextDocument.create(pathToFileURL(normalizedFileName).toString(), "rsgl", 0, text);
  } catch {
    return null;
  }
}
