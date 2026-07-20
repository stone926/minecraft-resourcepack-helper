import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { findByNormalizedPath, normalizePathKey } from "../../mc-assets/src";
import {
  CodeActionKind,
  createConnection,
  ErrorCodes,
  ProposedFeatures,
  ResponseError,
  TextDocuments,
  TextDocumentSyncKind,
  type CancellationToken,
  type CompletionItem,
  type Location
} from "vscode-languageserver/node";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  findRsglProjectConfig,
  rsglSemanticTokenModifiers,
  rsglSemanticTokenTypes,
  loadRsglProjectConfigForSource,
  RsglProjectTargetCache,
  RsglWorkspaceSemanticCache,
  resolveRsglNavigationSourceRoot,
  type CompileDependency,
  type RsglResourceNavigationIndex,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";
import { RsglWorkspaceValidationCache } from "../../rsgl-core/src/workspaceValidation";
import {
  rsglDependencyPathsNotification,
  rsglDependencyStructureChangedNotification,
  rsglRefreshWorkspaceNotification,
  rsglResourceNavigationRequest,
  rsglResourceSnapshotInvalidatedNotification,
  rsglResourceSnapshotRequest,
  type RsglDependencyPathsNotification,
  type RsglDependencyStructureChangedNotification,
  type RsglResourceSnapshotRequest
} from "../../rsgl-shared/src";
import {
  completionItemsForDocument as completionItemsForDocumentCore,
  codeActionsForDiagnostics,
  computeDocumentDiagnostics,
  computeDocumentHover,
  computeDocumentSignatureHelp,
  computeDocumentSemanticTokens,
  definitionLocationsForDocument,
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
  referenceLocationsForDocument,
  resourceAnalysisConfigurationFor,
  requiredExactWatchPathsForDocuments,
  prepareRenameForDocument,
  renameEditsForDocument,
  toLspDefinitionLocations,
  toLspReferenceLocations,
  toLspWorkspaceEdit,
  toValidationSettings,
  workspaceRootFileNamesFromInitialization,
  type RsglDocumentDependencies,
  type RsglValidationSettings
} from "./serverCore";
import { DirtyDiagnosticScheduler } from "./diagnosticScheduler";
import {
  RsglResourceAnalysisCache,
  type RsglResourceAnalysisEntry
} from "./resourceAnalysisCache";
import {
  RsglResourceSnapshotProtocolError,
  RsglResourceSnapshotService
} from "./resourceSnapshotService";
import {
  fileNameFromSerializedResourceUri,
  rsglSourceUriFromFileName,
  type RsglResourceUriNativePathMapping
} from "./resourceSnapshotUris";
import { resourceNavigationTargetsAtOffset } from "./resourceNavigationTarget";
import {
  createResourceNavigationRequest,
  mergeLspResourceLocations,
  requireMatchingResourceNavigationResponse,
  toLspResourceNavigationLocations
} from "./resourceNavigationTransport";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let semanticCache = RsglWorkspaceSemanticCache.create();
const resourceAnalysisCache = new RsglResourceAnalysisCache();
const projectTargetCache = new RsglProjectTargetCache();
// Targeted watchers provide low-latency invalidation, while TTL/version checks
// remain the correctness fallback for paths excluded by VS Code watcher rules.
const workspaceValidationCache = new RsglWorkspaceValidationCache();
const dependenciesByDocument = new Map<string, RsglDocumentDependencies>();
const resourceNavigationDependenciesByRoot = new Map<string, RsglDocumentDependencies>();
const dependencyVerificationUris = new Set<string>();
let publishedDependencyPaths = "";
let workspaceNavigationRoots: string[] = [];
let initializedWorkspaceNavigationRoots: string[] = [];
let resourceNavigationRequestGeneration = 0;

let validationSettings: RsglValidationSettings = {
  defaultAssetsPath: null,
  resourcePackRoots: [],
  workspaceFolders: []
};

const resourceSnapshotService = new RsglResourceSnapshotService({
  loadAnalysis: (sourceRootFileName, projectContext, nativePathMappings) =>
    loadResourceAnalysis(sourceRootFileName, undefined, projectContext, nativePathMappings),
  documentFact: fileName => {
    const document = findOpenDocument(fileName);
    return document ? { version: document.version } : undefined;
  }
});

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
  replaceSemanticCache(validationSettings.stdlibRoot);
  initializedWorkspaceNavigationRoots = workspaceRootFileNamesFromInitialization(params);
  workspaceNavigationRoots = configuredWorkspaceNavigationRoots(validationSettings);
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
      referencesProvider: true,
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
  const nextValidationSettings = toValidationSettings(params.settings);
  if (nextValidationSettings.stdlibRoot !== validationSettings.stdlibRoot) {
    replaceSemanticCache(nextValidationSettings.stdlibRoot);
  }
  validationSettings = nextValidationSettings;
  workspaceNavigationRoots = configuredWorkspaceNavigationRoots(validationSettings);
  projectTargetCache.invalidateAll();
  workspaceValidationCache.invalidateAll();
  invalidateResourceAnalysisCache(true);
  publishResourceSnapshotInvalidations("configuration");
  scheduleAllOpenDocuments(0);
});

documents.onDidOpen(event => {
  invalidateDocument(event.document);
  scheduleAffectedDocuments(nativeFileNameFromUri(event.document.uri), event.document.uri, 0);
});
documents.onDidChangeContent(event => {
  invalidateDocument(event.document);
  scheduleAffectedDocuments(nativeFileNameFromUri(event.document.uri), event.document.uri);
});
documents.onDidClose(event => {
  const fileName = nativeFileNameFromUri(event.document.uri);
  diagnosticScheduler.drop(event.document.uri);
  dependencyVerificationUris.delete(event.document.uri);
  semanticCache.invalidatePath(fileName);
  dependenciesByDocument.delete(event.document.uri);
  publishDependencyPaths();
  publishResourceSnapshotInvalidations("document", [fileName]);
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
  scheduleAffectedDocuments(fileName, undefined, 0);
});

connection.onDidChangeWatchedFiles(params => {
  const changedFileNames = params.changes.map(change => nativeFileNameFromUri(change.uri));
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
  invalidateResourceAnalysisCache(configurationChanged);
  publishResourceSnapshotInvalidations(
    configurationChanged
      ? "configuration"
      : invalidationPaths.some(fileName => path.extname(fileName).toLowerCase() === ".rsgl")
        ? "document"
        : "dependency",
    invalidationPaths
  );
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
  invalidateResourceAnalysisCache(true);
  projectTargetCache.invalidateAll();
  workspaceValidationCache.invalidateAll();
  publishResourceSnapshotInvalidations("refresh");
  scheduleAllOpenDocuments(0);
});

connection.onRequest(rsglResourceSnapshotRequest, (request: unknown) => {
  try {
    return resourceSnapshotService.handle(request);
  } catch (error) {
    if (error instanceof RsglResourceSnapshotProtocolError) {
      throw new ResponseError(ErrorCodes.InvalidParams, error.message, { code: error.code });
    }
    throw error;
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
  return computeDocumentHover(document, nativeFileNameFromUri(document.uri), offset, {
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
    nativeFileNameFromUri(document.uri),
    document.offsetAt(params.position),
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
});

connection.onDefinition(async (params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  const definitions = definitionLocationsForDocument(
    document,
    nativeFileNameFromUri(document.uri),
    document.offsetAt(params.position),
    documentLanguageWorkspace()
  );
  const coreLocations = definitions.length > 0
    ? await toLspDefinitionLocations(definitions, loadLanguageDocument)
    : [];
  if (coreLocations.length > 0) {
    return coreLocations;
  }
  const locations = await requestMainResourceNavigation(
    "definition",
    document,
    document.offsetAt(params.position),
    false,
    token
  );
  return locations.length > 0 ? locations : null;
});

connection.onReferences(async (params, token) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return [];
  }
  const references = referenceLocationsForDocument(
    document,
    nativeFileNameFromUri(document.uri),
    document.offsetAt(params.position),
    params.context.includeDeclaration,
    documentLanguageWorkspace()
  );
  const [coreLocations, physicalLocations] = await Promise.all([
    toLspReferenceLocations(references, loadLanguageDocument),
    requestMainResourceNavigation(
      "references",
      document,
      document.offsetAt(params.position),
      params.context.includeDeclaration,
      token
    )
  ]);
  return mergeLspResourceLocations([coreLocations, physicalLocations]);
});

connection.onPrepareRename(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return null;
  }
  return prepareRenameForDocument(
    document,
    nativeFileNameFromUri(document.uri),
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
    nativeFileNameFromUri(document.uri),
    document.offsetAt(params.position),
    params.newName,
    { loadProgramFromEntry: entryFileName => loadSemanticProgram(entryFileName) }
  );
  return edits ? toLspWorkspaceEdit(edits, loadLanguageDocument) : null;
});

connection.languages.semanticTokens.on(params => {
  const document = documents.get(params.textDocument.uri);
  if (!document) {
    return { data: [] };
  }
  return {
    data: computeDocumentSemanticTokens(document, nativeFileNameFromUri(document.uri), {
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
  const fileName = nativeFileNameFromUri(document.uri);
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
  const fileName = nativeFileNameFromUri(document.uri);
  semanticCache.invalidatePath(fileName);
  publishResourceSnapshotInvalidations("document", [fileName]);
}

function completionItemsForDocument(document: TextDocument, offset: number): CompletionItem[] {
  return completionItemsForDocumentCore(
    document,
    nativeFileNameFromUri(document.uri),
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
    loadProgramForNavigation: (sourceFileName: string) => loadNavigationSemanticProgram(sourceFileName),
    loadResourceNavigation: (
      sourceFileName: string,
      semanticProgram?: RsglWorkspaceSemanticProgram
    ) => loadResourceNavigation(sourceFileName, semanticProgram),
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

function loadNavigationSemanticProgram(sourceFileName: string) {
  return loadNavigationSemanticProgramFromRoot(
    navigationSourceRoot(sourceFileName),
    sourceFileName
  );
}

function loadNavigationSemanticProgramFromRoot(
  rootDirectory: string,
  configurationAnchor = rootDirectory
) {
  let fingerprint: string | undefined;
  try {
    fingerprint = projectSemanticConfigurationFingerprint(configurationAnchor);
  } catch {
    // Diagnostics report malformed project config; navigation remains available.
  }
  return semanticCache.loadProgramFromDirectory(
    rootDirectory,
    fingerprint ? { semanticConfigurationFingerprint: fingerprint } : {}
  );
}

function loadResourceNavigation(
  sourceFileName: string,
  loadedSemanticProgram?: RsglWorkspaceSemanticProgram
): RsglResourceNavigationIndex {
  return loadResourceAnalysis(sourceFileName, loadedSemanticProgram).analysis.index;
}

function loadResourceAnalysis(
  sourceFileName: string,
  loadedSemanticProgram?: RsglWorkspaceSemanticProgram,
  projectContext?: RsglResourceSnapshotRequest["projectContext"],
  nativePathMappings: Parameters<typeof resourceAnalysisConfigurationFor>[4] = []
): RsglResourceAnalysisEntry {
  const semanticProgram = loadedSemanticProgram
    ?? loadNavigationSemanticProgramFromRoot(sourceFileName, sourceFileName);
  const entry = resourceAnalysisCache.getOrCreate(
    semanticProgram,
    resourceAnalysisConfigurationFor(
      sourceFileName,
      validationSettings,
      workspaceValidationCache,
      projectContext,
      nativePathMappings
    )
  );
  resourceNavigationDependenciesByRoot.set(
    normalizePathKey(semanticProgram.rootDirectory ?? semanticProgram.sourceName),
    documentDependenciesForCompile(entry.dependencies, [])
  );
  publishDependencyPaths();
  return entry;
}

async function requestMainResourceNavigation(
  operation: "definition" | "references",
  document: TextDocument,
  offset: number,
  includeDeclaration: boolean,
  token: CancellationToken
): Promise<Location[]> {
  if (token.isCancellationRequested) {
    return [];
  }
  let selections;
  try {
    const fileName = nativeFileNameFromUri(document.uri);
    const entry = loadResourceAnalysis(fileName);
    selections = resourceNavigationTargetsAtOffset(
      entry.analysis,
      fileName,
      offset
    );
  } catch {
    return [];
  }
  if (selections.length === 0) {
    return [];
  }

  const sourceRootUri = document.uri.startsWith("file:")
    ? pathToFileURL(navigationSourceRoot(nativeFileNameFromUri(document.uri))).toString()
    : undefined;
  const responses = await Promise.all(selections.map(async selection => {
    const request = createResourceNavigationRequest(
      operation,
      ++resourceNavigationRequestGeneration,
      document.uri,
      selection,
      { sourceRootUri, includeDeclaration }
    );
    try {
      const value = await connection.sendRequest(rsglResourceNavigationRequest, request, token);
      return toLspResourceNavigationLocations(
        requireMatchingResourceNavigationResponse(value, request)
      );
    } catch (error) {
      if (!token.isCancellationRequested) {
        connection.console.error(
          `RSGL ResourceUniverse navigation failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      return [];
    }
  }));
  return mergeLspResourceLocations(responses);
}

function invalidateResourceAnalysisCache(clearDependencies: boolean): void {
  resourceAnalysisCache.invalidateAll();
  if (clearDependencies && resourceNavigationDependenciesByRoot.size > 0) {
    resourceNavigationDependenciesByRoot.clear();
    publishDependencyPaths();
  }
}

function replaceSemanticCache(stdlibRoot: string | undefined): void {
  semanticCache = RsglWorkspaceSemanticCache.create({ stdlibRoot });
  semanticCache.setOpenTextDocumentProvider(fileName => openDocumentForFileName(fileName));
}

function publishResourceSnapshotInvalidations(
  reason: Parameters<RsglResourceSnapshotService["invalidations"]>[0],
  changedFileNames: readonly string[] = []
): void {
  for (const notification of resourceSnapshotService.invalidations(reason, changedFileNames)) {
    void connection.sendNotification(rsglResourceSnapshotInvalidatedNotification, notification);
  }
}

function navigationSourceRoot(sourceFileName: string): string {
  let projectConfig: ReturnType<typeof loadRsglProjectConfigForSource>;
  try {
    projectConfig = loadRsglProjectConfigForSource(sourceFileName);
  } catch {
    projectConfig = null;
  }
  // A malformed config still establishes a project boundary while the user is
  // editing it; only its parsed options are unavailable until it is repaired.
  const configFileName = projectConfig?.fileName
    ?? findRsglProjectConfig(sourceFileName);
  return resolveRsglNavigationSourceRoot(sourceFileName, {
    configuredRoot: projectConfig?.config.root,
    projectRoots: configFileName
      ? [path.dirname(configFileName)]
      : [...workspaceNavigationRoots]
  });
}

function publishDependencyPaths(): void {
  const publishedDependencies = new Map(dependenciesByDocument);
  for (const [root, dependencies] of resourceNavigationDependenciesByRoot) {
    publishedDependencies.set(`resource-navigation:${root}`, dependencies);
  }
  const paths = dependencyPathsForDocuments(publishedDependencies);
  const requiredExactWatchPaths = requiredExactWatchPathsForDocuments(publishedDependencies);
  const patterns = dependencyPatternsForDocuments(publishedDependencies);
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

function nativeFileNameFromUri(uri: string): string {
  return fileNameFromSerializedResourceUri(uri, workspaceUriNativePathMappings())
    ?? fileNameFromUri(uri);
}

function workspaceUriNativePathMappings(): RsglResourceUriNativePathMapping[] {
  return (validationSettings.workspaceFolders ?? []).flatMap(folder =>
    folder.workspaceFolderUri
      ? [{
          uriRoot: folder.workspaceFolderUri,
          fileSystemPath: folder.workspaceFolderPath
        }]
      : []
  );
}

function uniqueNativePaths(fileNames: readonly string[]): string[] {
  return [...new Map(fileNames.map(fileName => [
    normalizePathKey(path.resolve(fileName)),
    path.resolve(fileName)
  ])).values()];
}

function configuredWorkspaceNavigationRoots(settings: RsglValidationSettings): string[] {
  return uniqueNativePaths([
    ...initializedWorkspaceNavigationRoots,
    ...(settings.workspaceFolders ?? []).map(folder => folder.workspaceFolderPath)
  ]);
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
    item => path.resolve(nativeFileNameFromUri(item.uri))
  ) ?? null;
}

async function loadLanguageDocument(fileName: string): Promise<TextDocument | null> {
  const openDocument = findByNormalizedPath(
    documents.all(),
    path.resolve(fileName),
    item => path.resolve(nativeFileNameFromUri(item.uri))
  );
  if (openDocument) {
    return openDocument;
  }
  try {
    const normalizedFileName = path.resolve(fileName);
    const text = await readFile(normalizedFileName, "utf8");
    return TextDocument.create(
      rsglSourceUriFromFileName(normalizedFileName, workspaceUriNativePathMappings()),
      "rsgl",
      0,
      text
    );
  } catch {
    return null;
  }
}
