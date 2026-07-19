import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizePathKey } from "../../mc-assets/src";
import {
  CodeActionKind,
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
  type CodeAction,
  type CompletionItem,
  type Diagnostic,
  type Hover,
  type Location,
  type Position,
  type Range,
  type SignatureHelp,
  type TextEdit,
  type WorkspaceEdit
} from "vscode-languageserver/node";
import {
  compileRsglModule,
  compileRsglProgram,
  formatRsglText,
  getRsglProjectConfigWatchPaths,
  getRsglDocumentCompletionItems,
  getRsglDocumentDefinitionLocations,
  getRsglDocumentHoverInfo,
  getRsglDocumentReferenceLocations,
  getRsglDocumentRenameEdits,
  getRsglDocumentSignatureHelpInfo,
  getRsglDocumentSemanticTokens,
  getRsglCompletionItems,
  loadRsglProjectConfigForSource,
  parseRsgl,
  prepareRsglDocumentRename,
  projectCompileOptionsFromRsglConfig,
  rsglArrowQuickFixForDiagnosticCode,
  resolveRsglCompileConfiguration,
  RsglProjectConfigError,
  type CompileDependency,
  type RsglCompileConfigurationOptions,
  type RsglCompletionItem,
  type RsglDiagnostic,
  type RsglDefinitionLocation,
  type RsglLanguageWorkspace,
  type RsglReferenceLocation,
  type RsglResourceValidationOptions,
  type RsglRenameEdit,
  type RsglSemanticToken,
  type RsglSymbol,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";
import {
  createRsglWorkspaceValidationOptions,
  type RsglWorkspaceValidationCache
} from "../../rsgl-core/src/workspaceValidation";

/** Validation settings pushed by the client via initializationOptions or didChangeConfiguration. */
export interface RsglValidationSettings {
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
}

/** Filesystem-relevant subset of LSP initialization parameters. */
export interface RsglWorkspaceInitializationParams {
  workspaceFolders?: readonly { uri: string }[] | null;
  rootUri?: string | null;
  rootPath?: string | null;
}

/** Minimal transport-neutral view of an open text document. */
export interface RsglLspDocument {
  getText(): string;
  offsetAt?(position: Position): number;
  positionAt(offset: number): Position;
  readonly version?: number;
}

/** Injected collaborators for the document validation pipeline. */
export interface RsglDocumentValidationDeps {
  loadProgramFromEntry(
    fileName: string,
    semanticConfigurationFingerprint?: string
  ): RsglWorkspaceSemanticProgram;
  onDependencies?: (dependencies: readonly CompileDependency[]) => void;
  onProjectConfigWatchPaths?: (paths: readonly string[]) => void;
  validationCache?: RsglWorkspaceValidationCache;
  settings: RsglValidationSettings;
}

/** Injected collaborators for completion computation and project target lookup. */
export type RsglDocumentCompletionDeps = RsglLanguageWorkspace;

/** Injected collaborators shared by hover, signature help, and definition lookup. */
export type RsglDocumentLanguageIntelligenceDeps = RsglDocumentCompletionDeps;

/** Normalizes an untyped settings payload into safe validation settings. */
export function toValidationSettings(value: unknown): RsglValidationSettings {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
  const defaultAssetsPath = typeof record.defaultAssetsPath === "string" && record.defaultAssetsPath.trim().length > 0
    ? record.defaultAssetsPath
    : null;
  const roots = record.resourcePackRoots;
  const resourcePackRoots = Array.isArray(roots)
    ? roots.filter((root): root is string => typeof root === "string")
    : [];
  return { defaultAssetsPath, resourcePackRoots };
}

/** Compiles the document's program and returns LSP diagnostics scoped to the document's file. */
export function computeDocumentDiagnostics(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentValidationDeps
): Diagnostic[] {
  const currentFileKey = normalizePathKey(path.resolve(fileName));
  deps.onProjectConfigWatchPaths?.(getRsglProjectConfigWatchPaths(fileName, "file"));
  let validationOptions: RsglResourceValidationOptions & RsglCompileConfigurationOptions;
  try {
    validationOptions = workspaceValidationOptionsFor(fileName, deps.settings, deps.validationCache);
  } catch (error) {
    return [toLspDiagnostic(document, {
      code: projectConfigurationDiagnosticCode(error),
      message: error instanceof Error ? error.message : String(error),
      severity: "error",
      range: { start: 0, end: 1 }
    })];
  }
  const semanticConfigurationFingerprint = resolveRsglCompileConfiguration(validationOptions).semanticFingerprint;
  const semanticProgram = deps.loadProgramFromEntry(fileName, semanticConfigurationFingerprint);
  if (semanticProgram.files.length > 0) {
    const result = compileRsglProgram(semanticProgram.files, {
      entryFileName: fileName,
      semanticProgram: semanticProgram.program,
      ...validationOptions
    });
    deps.onDependencies?.(result.dependencies);
    return result.diagnostics
      .filter(diagnostic =>
        !diagnostic.fileName
        || normalizePathKey(path.resolve(diagnostic.fileName)) === currentFileKey
      )
      .map(diagnostic => toLspDiagnostic(document, diagnostic));
  }

  const parsed = parseRsgl(document.getText());
  const result = compileRsglModule(parsed, {
    fileName,
    ...validationOptions
  });
  deps.onDependencies?.(result.dependencies);
  return result.diagnostics.map(diagnostic => toLspDiagnostic(document, diagnostic));
}

/** Builds precise, token-sized quick fixes for parser diagnostics. */
export function codeActionsForDiagnostics(
  document: RsglLspDocument,
  documentUri: string,
  diagnostics: readonly Diagnostic[]
): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const diagnostic of diagnostics) {
    const fix = rsglArrowQuickFixForDiagnosticCode(diagnostic.code);
    if (
      !fix
      || diagnostic.source !== "RSGL"
      || textInRange(document, diagnostic.range) !== fix.original
    ) {
      continue;
    }
    actions.push({
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      diagnostics: [diagnostic],
      isPreferred: true,
      edit: {
        documentChanges: [{
          textDocument: {
            uri: documentUri,
            version: document.version ?? null
          },
          edits: [{ range: diagnostic.range, newText: fix.replacement }]
        }]
      }
    });
  }
  return actions;
}

function textInRange(document: RsglLspDocument, range: Range): string {
  const text = document.getText();
  const offsetAt = document.offsetAt
    ? (position: Position) => document.offsetAt!(position)
    : (position: Position) => offsetAtPosition(text, position);
  return text.slice(offsetAt(range.start), offsetAt(range.end));
}

function offsetAtPosition(text: string, position: Position): number {
  let lineStart = 0;
  for (let line = 0; line < position.line && lineStart < text.length; line++) {
    const lineEnd = text.indexOf("\n", lineStart);
    lineStart = lineEnd < 0 ? text.length : lineEnd + 1;
  }
  const lineFeed = text.indexOf("\n", lineStart);
  const lineEnd = lineFeed < 0 ? text.length : lineFeed;
  const contentEnd = lineEnd > lineStart && text[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
  return Math.max(lineStart, Math.min(contentEnd, lineStart + position.character));
}

export {
  dependencyInvalidationPathsForStructuralChange,
  dependencyPathsForDocument,
  dependencyPathsForDocuments,
  dependencyPatternsForDocuments,
  documentDependenciesEqual,
  documentDependenciesExpanded,
  documentDependenciesForCompile,
  documentsDependingOnPath,
  documentsStructurallyDependingOnPath,
  normalizeDependencyPath,
  requiredExactWatchPathsForDocuments
} from "./dependencyIndex";
export type {
  RsglDependencyWatchPattern,
  RsglDocumentDependencies,
  RsglDocumentDependencyIndex
} from "./dependencyIndex";

export interface RsglSemanticWatchBatchCallbacks {
  invalidatePath(fileName: string): void;
  invalidateProjectConfiguration?(): void;
  refresh(): void;
}

/**
 * Applies configuration and RSGL source watcher changes as one semantic batch.
 * Every changed source is invalidated before the single shared refresh.
 */
export function handleSemanticWatchedFileBatch(
  changedFileNames: readonly string[],
  callbacks: RsglSemanticWatchBatchCallbacks
): boolean {
  const rsglChanges = new Set<string>();
  let configurationChanged = false;
  for (const fileName of changedFileNames) {
    if (path.basename(fileName).toLowerCase() === "rsgl.config.json") {
      configurationChanged = true;
    } else if (path.extname(fileName).toLowerCase() === ".rsgl") {
      rsglChanges.add(fileName);
    }
  }

  if (configurationChanged) {
    callbacks.invalidateProjectConfiguration?.();
  }
  for (const fileName of rsglChanges) {
    callbacks.invalidatePath(fileName);
  }
  if (!configurationChanged && rsglChanges.size === 0) {
    return false;
  }
  callbacks.refresh();
  return true;
}

/** Builds filesystem-backed resource validation options for the given source file. */
export function workspaceValidationOptionsFor(
  sourceFileName: string,
  settings: RsglValidationSettings,
  validationCache?: RsglWorkspaceValidationCache
): ReturnType<typeof createRsglWorkspaceValidationOptions>
  & RsglResourceValidationOptions
  & RsglCompileConfigurationOptions {
  const projectConfig = loadRsglProjectConfigForSource(sourceFileName)?.config;
  const projectDefaultAssetsPath = projectConfig?.defaultAssetsPath;
  return {
    ...projectCompileOptionsFromRsglConfig(projectConfig ?? {}),
    ...createRsglWorkspaceValidationOptions({
      sourceFileName,
      defaultAssetsPath: projectDefaultAssetsPath === undefined
        ? settings.defaultAssetsPath
        : projectDefaultAssetsPath,
      resourcePackRoots: projectConfig?.resourcePackRoots ?? settings.resourcePackRoots,
      cache: validationCache
    }),
    globalExterns: projectConfig?.extern,
    checkExternExistence: projectConfig?.checkExternExistence
  };
}

/** Returns the stable semantic identity of the nearest validated project config. */
export function projectSemanticConfigurationFingerprint(sourceFileName: string): string {
  const projectConfig = loadRsglProjectConfigForSource(sourceFileName)?.config;
  return resolveRsglCompileConfiguration(
    projectCompileOptionsFromRsglConfig(projectConfig ?? {})
  ).semanticFingerprint;
}

function projectConfigurationDiagnosticCode(error: unknown): string {
  const topLevelProperty = error instanceof RsglProjectConfigError
    ? topLevelConfigProperty(error.relativeFieldPath)
    : undefined;
  if (
    topLevelProperty === "namespace"
    || topLevelProperty === "target"
    || topLevelProperty === "maxEvaluationItems"
    || topLevelProperty === "maxItemModelDepth"
  ) {
    return "rsgl.invalidProjectConfiguration";
  }
  return "rsgl.invalidExternConfiguration";
}

function topLevelConfigProperty(fieldPath: string | undefined): string | undefined {
  if (!fieldPath) {
    return undefined;
  }
  const separators = [fieldPath.indexOf("."), fieldPath.indexOf("[")]
    .filter(index => index >= 0);
  const end = separators.length > 0 ? Math.min(...separators) : fieldPath.length;
  return fieldPath.slice(0, end);
}

/** Merges syntactic completion candidates with workspace symbols, deduplicated by label. */
export function completionItemsForContent(
  text: string,
  offset: number,
  semanticSymbols: readonly RsglSymbol[]
): CompletionItem[] {
  return getRsglCompletionItems(text, offset, semanticSymbols).map(toCompletionItem);
}

/** Computes completion items for a document through the shared core language service. */
export function completionItemsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentCompletionDeps
): CompletionItem[] {
  return getRsglDocumentCompletionItems({
    fileName,
    getText: () => document.getText()
  }, offset, deps).map(toCompletionItem);
}

/** Formats a document and converts the result into an LSP full-document edit. */
export function formattingEditsForDocument(
  document: RsglLspDocument,
  tabSize: number
): TextEdit[] {
  const text = document.getText();
  const formatted = formatRsglText(text, Number(tabSize) || 2);
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

/** Computes semantic hover content and converts its source offsets to LSP positions. */
export function computeDocumentHover(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): Hover | null {
  try {
    const hover = getRsglDocumentHoverInfo({
      fileName,
      getText: () => document.getText()
    }, offset, deps);
    if (!hover) {
      return null;
    }
    const detail = hover.detail ? `\n\n${hover.detail}` : "";
    return {
      contents: {
        kind: MarkupKind.Markdown,
        value: `\`\`\`rsgl\n${hover.label}\n\`\`\`${detail}`
      },
      range: {
        start: document.positionAt(clampOffset(document, hover.range.start)),
        end: document.positionAt(clampOffset(document, hover.range.end))
      }
    };
  } catch {
    return null;
  }
}

/** Computes semantic signature help for template and function-valued calls. */
export function computeDocumentSignatureHelp(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): SignatureHelp | null {
  try {
    const help = getRsglDocumentSignatureHelpInfo({
      fileName,
      getText: () => document.getText()
    }, offset, deps);
    if (!help) {
      return null;
    }
    return {
      signatures: help.signatures.map(signature => ({
        label: signature.label,
        documentation: signature.detail,
        parameters: signature.parameters.map(parameter => ({ label: parameter.label }))
      })),
      activeSignature: help.activeSignature,
      activeParameter: help.activeParameter
    };
  } catch {
    return null;
  }
}

/** Returns an offset-based definition; target-document conversion is intentionally separate. */
export function definitionLocationForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglDefinitionLocation | null {
  return definitionLocationsForDocument(document, fileName, offset, deps)[0] ?? null;
}

/** Returns every offset-based definition target for protocol clients that support locations. */
export function definitionLocationsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglDefinitionLocation[] {
  try {
    return getRsglDocumentDefinitionLocations({
      fileName,
      getText: () => document.getText()
    }, offset, deps);
  } catch {
    return [];
  }
}

/** Converts a core definition range using the target document's UTF-16 position mapping. */
export function toLspDefinitionLocation(
  targetDocument: RsglLspDocument,
  targetUri: string,
  definition: RsglDefinitionLocation
): Location {
  return toLspOffsetLocation(targetDocument, targetUri, definition);
}

/** Converts all definition targets while loading each target document once. */
export function toLspDefinitionLocations(
  definitions: readonly RsglDefinitionLocation[],
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<Location[]> {
  return toLspReferenceLocations(definitions, loadDocument);
}

/** Returns offset-based references; target-document conversion is intentionally separate. */
export function referenceLocationsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  includeDeclaration: boolean,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglReferenceLocation[] {
  try {
    return getRsglDocumentReferenceLocations({
      fileName,
      getText: () => document.getText()
    }, offset, includeDeclaration, deps);
  } catch {
    return [];
  }
}

/** A target text document used to map core offsets to LSP locations. */
export interface RsglLocationTargetDocument extends RsglLspDocument {
  uri: string;
}

/** Converts and preserves a stable list of cross-file core reference locations. */
export async function toLspReferenceLocations(
  locations: readonly RsglReferenceLocation[],
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<Location[]> {
  const loadedDocuments: RsglLoadedTargetDocuments = new Map();
  const result: Location[] = [];
  for (const location of locations) {
    const targetDocument = await loadTargetDocumentOnce(
      location.fileName,
      loadedDocuments,
      loadDocument
    );
    if (targetDocument) {
      result.push(toLspOffsetLocation(targetDocument, targetDocument.uri, location));
    }
  }
  return result;
}

function toLspOffsetLocation(
  targetDocument: RsglLspDocument,
  targetUri: string,
  location: Pick<RsglDefinitionLocation, "range">
): Location {
  return {
    uri: targetUri,
    range: {
      start: targetDocument.positionAt(clampOffset(targetDocument, location.range.start)),
      end: targetDocument.positionAt(clampOffset(targetDocument, location.range.end))
    }
  };
}

/** Prepares a namespace alias/member rename and converts its source offsets. */
export function prepareRenameForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  deps: RsglDocumentLanguageIntelligenceDeps
): { range: Range; placeholder: string } | null {
  try {
    const target = prepareRsglDocumentRename({
      fileName,
      getText: () => document.getText()
    }, offset, deps);
    return target
      ? {
          range: {
            start: document.positionAt(clampOffset(document, target.range.start)),
            end: document.positionAt(clampOffset(document, target.range.end))
          },
          placeholder: target.placeholder
        }
      : null;
  } catch {
    return null;
  }
}

/** Returns protocol-neutral rename edits; target documents are converted separately. */
export function renameEditsForDocument(
  document: RsglLspDocument,
  fileName: string,
  offset: number,
  newName: string,
  deps: RsglDocumentLanguageIntelligenceDeps
): RsglRenameEdit[] | null {
  try {
    return getRsglDocumentRenameEdits({
      fileName,
      getText: () => document.getText()
    }, offset, newName, deps) ?? null;
  } catch {
    return null;
  }
}

/** Target document required to convert one core offset edit into an LSP edit. */
export type RsglRenameTargetDocument = RsglLocationTargetDocument;

/**
 * Converts a complete cross-file rename atomically. If any target document
 * cannot be loaded, no partial WorkspaceEdit is returned.
 */
export async function toLspWorkspaceEdit(
  edits: readonly RsglRenameEdit[],
  loadDocument: (fileName: string) => Promise<RsglRenameTargetDocument | null>
): Promise<WorkspaceEdit | null> {
  try {
    const loadedDocuments: RsglLoadedTargetDocuments = new Map();
    const changes = new Map<string, TextEdit[]>();
    for (const edit of edits) {
      const targetDocument = await loadTargetDocumentOnce(edit.fileName, loadedDocuments, loadDocument);
      if (!targetDocument) {
        return null;
      }
      const documentEdits = changes.get(targetDocument.uri) ?? [];
      if (!changes.has(targetDocument.uri)) {
        changes.set(targetDocument.uri, documentEdits);
      }
      documentEdits.push({
        range: {
          start: targetDocument.positionAt(clampOffset(targetDocument, edit.range.start)),
          end: targetDocument.positionAt(clampOffset(targetDocument, edit.range.end))
        },
        newText: edit.newText
      });
    }
    return { changes: Object.fromEntries(changes) };
  } catch {
    return null;
  }
}

type RsglLoadedTargetDocuments = Map<string, RsglLocationTargetDocument | null>;

async function loadTargetDocumentOnce(
  fileName: string,
  loadedDocuments: RsglLoadedTargetDocuments,
  loadDocument: (fileName: string) => Promise<RsglLocationTargetDocument | null>
): Promise<RsglLocationTargetDocument | null> {
  const fileKey = normalizePathKey(path.resolve(fileName));
  if (loadedDocuments.has(fileKey)) {
    return loadedDocuments.get(fileKey) ?? null;
  }
  let document: RsglLocationTargetDocument | null = null;
  try {
    document = await loadDocument(fileName);
  } catch {
    // Callers decide whether an unreadable target is skippable or atomic.
  }
  loadedDocuments.set(fileKey, document);
  return document;
}

/** Injected collaborators for semantic token computation. */
export interface RsglDocumentSemanticTokenDeps {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
}

/**
 * Computes the LSP-encoded semantic tokens for a document, resolving the
 * bound model through the workspace cache with a single-module bind fallback.
 * Never throws; any failure yields an empty token stream.
 */
export function computeDocumentSemanticTokens(
  document: RsglLspDocument,
  fileName: string,
  deps: RsglDocumentSemanticTokenDeps
): number[] {
  try {
    const tokens = getRsglDocumentSemanticTokens({
      fileName,
      getText: () => document.getText()
    }, deps);
    return encodeSemanticTokens(tokens, document);
  } catch {
    return [];
  }
}

/**
 * Encodes absolute-offset tokens into the LSP relative representation
 * (deltaLine, deltaStartChar, length, tokenType, tokenModifiers). Tokens must
 * already be sorted by start offset, which `getRsglSemanticTokens` guarantees.
 */
export function encodeSemanticTokens(tokens: readonly RsglSemanticToken[], document: RsglLspDocument): number[] {
  const data: number[] = [];
  let previousLine = 0;
  let previousCharacter = 0;
  for (const token of tokens) {
    const position = document.positionAt(token.start);
    const deltaLine = position.line - previousLine;
    const deltaStartChar = deltaLine === 0 ? position.character - previousCharacter : position.character;
    data.push(deltaLine, deltaStartChar, token.length, token.tokenType, token.tokenModifiers);
    previousLine = position.line;
    previousCharacter = position.character;
  }
  return data;
}

/** Maps a syntactic completion candidate to an LSP completion item. */
export function toCompletionItem(candidate: RsglCompletionItem): CompletionItem {
  const item: CompletionItem = {
    label: candidate.label,
    kind: toCompletionKind(candidate.kind),
    detail: candidate.detail
  };
  if (candidate.insertText) {
    item.insertText = candidate.insertText;
    if (candidate.kind === "snippet") {
      item.insertTextFormat = InsertTextFormat.Snippet;
    }
  }
  return item;
}

function toCompletionKind(kind: RsglCompletionItem["kind"]): CompletionItemKind {
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
  if (kind === "struct") {
    return CompletionItemKind.Struct;
  }
  if (kind === "file") {
    return CompletionItemKind.File;
  }
  if (kind === "module") {
    return CompletionItemKind.Module;
  }
  if (kind === "variable") {
    return CompletionItemKind.Variable;
  }
  return CompletionItemKind.Keyword;
}

/** Returns the complete identifier touched by an LSP offset, including when the offset is inside it. */
export function identifierAtOffset(text: string, offset: number): string | null {
  const clamped = Math.max(0, Math.min(text.length, offset));
  let anchor = clamped;
  if (!isIdentifierCharacter(text[anchor]) && anchor > 0 && isIdentifierCharacter(text[anchor - 1])) {
    anchor--;
  }
  if (!isIdentifierCharacter(text[anchor])) {
    return null;
  }

  let start = anchor;
  let end = anchor + 1;
  while (start > 0 && isIdentifierCharacter(text[start - 1])) {
    start--;
  }
  while (end < text.length && isIdentifierCharacter(text[end])) {
    end++;
  }
  const identifier = text.slice(start, end);
  return /^[A-Za-z_]/.test(identifier) ? identifier : null;
}

function isIdentifierCharacter(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9_]/.test(char);
}

/** Converts an RSGL diagnostic to an LSP diagnostic, clamping offsets to the document. */
export function toLspDiagnostic(document: RsglLspDocument, diagnostic: RsglDiagnostic): Diagnostic {
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

/** Maps an RSGL severity onto the LSP diagnostic severity scale. */
export function toLspSeverity(severity: RsglDiagnostic["severity"]): DiagnosticSeverity {
  if (severity === "warning") {
    return DiagnosticSeverity.Warning;
  }
  if (severity === "info") {
    return DiagnosticSeverity.Information;
  }
  return DiagnosticSeverity.Error;
}

/** Clamps an offset into the valid range of the document's text. */
export function clampOffset(document: RsglLspDocument, offset: number): number {
  return Math.max(0, Math.min(document.getText().length, offset));
}

/** Resolves a document URI to a filesystem path, passing through non-file URIs. */
export function fileNameFromUri(uri: string): string {
  if (uri.startsWith("file:")) {
    return fileURLToPath(uri);
  }
  return uri;
}

/**
 * Resolves the explicit filesystem boundaries advertised by an LSP client.
 * Workspace folders take precedence over the legacy single-root fields;
 * unsupported URI schemes are ignored instead of becoming accidental paths.
 */
export function workspaceRootFileNamesFromInitialization(
  params: RsglWorkspaceInitializationParams
): string[] {
  const workspaceFolders = uniqueResolvedFileNames(
    (params.workspaceFolders ?? []).flatMap(folder => fileNameFromWorkspaceUri(folder.uri) ?? [])
  );
  if (workspaceFolders.length > 0) {
    return workspaceFolders;
  }

  const rootUriFileName = params.rootUri ? fileNameFromWorkspaceUri(params.rootUri) : null;
  if (rootUriFileName) {
    return [rootUriFileName];
  }
  return params.rootPath ? [path.resolve(params.rootPath)] : [];
}

/** Normalizes a filesystem path for identity comparisons. */
export function normalizeDisplayFileName(fileName: string): string {
  return path.normalize(fileName);
}

function fileNameFromWorkspaceUri(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === "file:" ? path.resolve(fileURLToPath(parsed)) : null;
  } catch {
    return null;
  }
}

function uniqueResolvedFileNames(fileNames: readonly string[]): string[] {
  const unique = new Map<string, string>();
  for (const fileName of fileNames) {
    const resolved = path.resolve(fileName);
    const key = normalizePathKey(resolved);
    if (!unique.has(key)) {
      unique.set(key, resolved);
    }
  }
  return [...unique.values()];
}
