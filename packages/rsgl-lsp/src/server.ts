import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findByNormalizedPath, normalizePathKey } from "../../mc-assets/src";
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
import { RsglWorkspaceValidationCache } from "../../rsgl-core/src/workspaceValidation";
import {
  rsglDependencyPathsNotification,
  rsglDependencyStructureChangedNotification,
  rsglRefreshWorkspaceNotification,
  type RsglDependencyPathsNotification,
  type RsglDependencyStructureChangedNotification
} from "../../rsgl-shared/src";
import {
  completionItemsForDocument as completionItemsForDocumentCore,
  codeActionsForDiagnostics,
  computeDocumentDiagnostics,
  computeDocumentHover,
  computeDocumentSignatureHelp,
  computeDocumentSemanticTokens,
  definitionLocationForDocument,
  dependencyInvalidationPathsForStructuralChange,
  dependencyPathsForDocuments,
  dependencyPatternsForDocuments,
  documentDependenciesExpanded,
  documentDependenciesForCompile,
  documentsDependingOnPath,
  documentsStructurallyDependingOnPath,
  fileNameFromUri,
  formattingEditsForDocument,
  normalizeDisplayFileName,
  projectSemanticConfigurationFingerprint,
  requiredExactWatchPathsForDocuments,
  prepareRenameForDocument,
  renameEditsForDocument,
  toLspDefinitionLocation,
  toLspWorkspaceEdit,
  toValidationSettings,
  type RsglDocumentDependencies,
  type RsglValidationSettings
} from "./serverCore";
import { DirtyDiagnosticScheduler } from "./diagnosticScheduler";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const semanticCache = RsglWorkspaceSemanticCache.create();
const projectTargetCache = new RsglProjectTargetCache();
// Targeted watchers provide low-latency invalidation, while TTL/version checks
// remain the correctness fallback for paths excluded by VS Code watcher rules.
const workspaceValidationCache = new RsglWorkspaceValidationCache();
const dependenciesByDocument = new Map<string, RsglDocumentDependencies>();
const dependencyVerificationUris = new Set<string>();
let publishedDependencyPaths = "";

let validationSettings: RsglValidationSettings = { defaultAssetsPath: null, resourcePackRoots: [] };

const diagnosticScheduler = new DirtyDiagnosticScheduler<string>({
  delayMs: 150,
  run: uri => {
    const document = documents.get(uri);
    if (document) {
      validateDocument(document);
    }
  },
  onIdle: async () => {
    await connection.languages.semanticTokens.refresh();
    if (dependencyVerificationUris.size === 0) {
      return;
    }
    const uris = [...dependencyVerificationUris];
    dependencyVerificationUris.clear();
    diagnosticScheduler.schedule(uris, 0);
  }
});

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
  projectTargetCache.invalidateAll();
  workspaceValidationCache.invalidateAll();
  scheduleAllOpenDocuments(0);
});

documents.onDidOpen(event => {
  invalidateDocument(event.document);
  scheduleAffectedDocuments(fileNameFromUri(event.document.uri), event.document.uri, 0);
});
documents.onDidChangeContent(event => {
  invalidateDocument(event.document);
  scheduleAffectedDocuments(fileNameFromUri(event.document.uri), event.document.uri);
});
documents.onDidClose(event => {
  const fileName = fileNameFromUri(event.document.uri);
  diagnosticScheduler.drop(event.document.uri);
  dependencyVerificationUris.delete(event.document.uri);
  semanticCache.invalidatePath(fileName);
  dependenciesByDocument.delete(event.document.uri);
  publishDependencyPaths();
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  scheduleAffectedDocuments(fileName, undefined, 0);
});

connection.onDidChangeWatchedFiles(params => {
  const changedFileNames = params.changes.map(change => fileNameFromUri(change.uri));
  const affectedUris = new Set<string>();
  for (const changedFileName of changedFileNames) {
    for (const uri of documentsDependingOnPath(dependenciesByDocument, changedFileName)) {
      affectedUris.add(uri);
    }
    const changedDocument = findOpenDocument(changedFileName);
    if (changedDocument) {
      affectedUris.add(changedDocument.uri);
    }
  }
  scheduleWatchedPathInvalidation(changedFileNames, affectedUris);
});

connection.onNotification(
  rsglDependencyStructureChangedNotification,
  (notification: RsglDependencyStructureChangedNotification) => {
    const changedFileNames = Array.isArray(notification?.paths)
      ? notification.paths.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [];
    const affectedUris = new Set<string>();
    const invalidationPaths = new Map<string, string>();
    for (const changedFileName of changedFileNames) {
      invalidationPaths.set(normalizePathKey(changedFileName), changedFileName);
      for (const uri of documentsStructurallyDependingOnPath(
        dependenciesByDocument,
        changedFileName
      )) {
        affectedUris.add(uri);
      }
      for (const dependencyPath of dependencyInvalidationPathsForStructuralChange(
        dependenciesByDocument,
        changedFileName
      )) {
        invalidationPaths.set(normalizePathKey(dependencyPath), dependencyPath);
      }
    }
    scheduleWatchedPathInvalidation([...invalidationPaths.values()], affectedUris);
  }
);

function scheduleWatchedPathInvalidation(
  invalidationPaths: readonly string[],
  affectedUris: ReadonlySet<string>
): void {
  let configurationChanged = false;
  for (const invalidationPath of invalidationPaths) {
    workspaceValidationCache.invalidatePath(invalidationPath);
    if (path.basename(invalidationPath).toLowerCase() === "rsgl.config.json") {
      configurationChanged = true;
    } else if (path.extname(invalidationPath).toLowerCase() === ".rsgl") {
      semanticCache.invalidatePath(invalidationPath);
    }
  }
  if (configurationChanged) {
    projectTargetCache.invalidateAll();
    semanticCache.invalidateAll();
  }
  if (affectedUris.size === 0 && configurationChanged) {
    scheduleAllOpenDocuments(0);
  } else {
    diagnosticScheduler.schedule(affectedUris, 0);
  }
}

connection.onNotification(rsglRefreshWorkspaceNotification, () => {
  semanticCache.invalidateAll();
  projectTargetCache.invalidateAll();
  workspaceValidationCache.invalidateAll();
  scheduleAllOpenDocuments(0);
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
    settings: validationSettings,
    validationCache: workspaceValidationCache
  });
  const semanticWatchPaths = semanticDependencyPaths(fileName);
  const nextDependencies = documentDependenciesForCompile(compileDependencies, [
    ...projectConfigWatchPaths,
    ...semanticWatchPaths
  ]);
  const previousDependencies = dependenciesByDocument.get(document.uri);
  dependenciesByDocument.set(document.uri, nextDependencies);
  publishDependencyPaths();
  connection.sendDiagnostics({ uri: document.uri, diagnostics });
  if (documentDependenciesExpanded(previousDependencies, nextDependencies)) {
    // Verify once after the dependency graph expands. Watchers may have fired
    // while this compile was still discovering paths owned by this document.
    // Queue after the current batch becomes idle so one document cannot keep
    // invalidating the scheduler generation while its peers are still dirty.
    dependencyVerificationUris.add(document.uri);
  }
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

function scheduleAllOpenDocuments(delay = 150): void {
  diagnosticScheduler.schedule(documents.all().map(document => document.uri), delay);
}

function scheduleAffectedDocuments(
  changedFileName: string,
  explicitUri?: string,
  delay = 150
): void {
  const affected = new Set(documentsDependingOnPath(dependenciesByDocument, changedFileName));
  if (explicitUri) {
    affected.add(explicitUri);
  }
  const changedDocument = findOpenDocument(changedFileName);
  if (changedDocument) {
    affected.add(changedDocument.uri);
  }
  diagnosticScheduler.schedule(affected, delay);
}

function semanticDependencyPaths(fileName: string): string[] {
  try {
    const semantic = loadSemanticProgram(fileName);
    const paths = new Set(semantic.files.map(file => file.fileName));
    for (const missing of semantic.program.importGraph.missing) {
      if (missing.source.startsWith(".")) {
        paths.add(path.resolve(path.dirname(missing.from), missing.source));
      }
    }
    return [...paths];
  } catch {
    return [fileName];
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
  const requiredExactWatchPaths = requiredExactWatchPathsForDocuments(dependenciesByDocument);
  const patterns = dependencyPatternsForDocuments(dependenciesByDocument);
  const identity = JSON.stringify({ paths, requiredExactWatchPaths, patterns });
  if (identity === publishedDependencyPaths) {
    return;
  }
  publishedDependencyPaths = identity;
  const notification: RsglDependencyPathsNotification = {
    paths,
    requiredExactWatchPaths,
    patterns
  };
  void connection.sendNotification(rsglDependencyPathsNotification, notification);
}

function openDocumentForFileName(fileName: string): { fileName: string; version?: number; getText(): string } | null {
  const document = findOpenDocument(fileName);
  return document
    ? {
      fileName: normalizeDisplayFileName(path.resolve(fileName)),
      version: document.version,
      getText: () => document.getText()
    }
    : null;
}

function findOpenDocument(fileName: string): TextDocument | null {
  return findByNormalizedPath(
    documents.all(),
    path.resolve(fileName),
    item => item.uri.startsWith("file:") ? path.resolve(fileNameFromUri(item.uri)) : null
  ) ?? null;
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
