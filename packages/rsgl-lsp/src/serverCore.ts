import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CompletionItemKind,
  DiagnosticSeverity,
  InsertTextFormat,
  MarkupKind,
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
  getRsglDocumentDefinitionLocation,
  getRsglDocumentHoverInfo,
  getRsglDocumentRenameEdits,
  getRsglDocumentSignatureHelpInfo,
  getRsglDocumentSemanticTokens,
  getRsglCompletionItems,
  loadRsglProjectConfigForSource,
  parseRsgl,
  prepareRsglDocumentRename,
  projectCompileOptionsFromRsglConfig,
  resolveRsglCompileConfiguration,
  RsglProjectConfigError,
  type CompileDependency,
  type RsglCompileConfigurationOptions,
  type RsglCompletionItem,
  type RsglDiagnostic,
  type RsglDefinitionLocation,
  type RsglResourceValidationOptions,
  type RsglRenameEdit,
  type RsglSemanticToken,
  type RsglSymbol,
  type RsglWorkspaceSemanticProgram
} from "../../rsgl-core/src";
import { createRsglWorkspaceValidationOptions } from "../../rsgl-core/src/workspaceValidation";

/** Validation settings pushed by the client via initializationOptions or didChangeConfiguration. */
export interface RsglValidationSettings {
  defaultAssetsPath: string | null;
  resourcePackRoots: string[];
}

/** Minimal transport-neutral view of an open text document. */
export interface RsglLspDocument {
  getText(): string;
  positionAt(offset: number): Position;
}

/** Injected collaborators for the document validation pipeline. */
export interface RsglDocumentValidationDeps {
  loadProgramFromEntry(
    fileName: string,
    semanticConfigurationFingerprint?: string
  ): RsglWorkspaceSemanticProgram;
  onDependencies?: (dependencies: readonly CompileDependency[]) => void;
  onProjectConfigWatchPaths?: (paths: readonly string[]) => void;
  settings: RsglValidationSettings;
}

/** Injected collaborators for completion computation. */
export interface RsglDocumentCompletionDeps {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
}

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
  const currentFileName = normalizeFileName(path.resolve(fileName));
  deps.onProjectConfigWatchPaths?.(getRsglProjectConfigWatchPaths(fileName, "file"));
  let validationOptions: RsglResourceValidationOptions & RsglCompileConfigurationOptions;
  try {
    validationOptions = workspaceValidationOptionsFor(fileName, deps.settings);
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
      .filter(diagnostic => !diagnostic.fileName || normalizeFileName(path.resolve(diagnostic.fileName)) === currentFileName)
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

/** Returns open-document ids whose last compile depends on a changed filesystem path. */
export function documentsDependingOnPath(
  dependenciesByDocument: ReadonlyMap<string, ReadonlySet<string>>,
  changedPath: string
): string[] {
  const normalizedChangedPath = normalizeDependencyPath(changedPath);
  const result: string[] = [];
  for (const [documentId, dependencies] of dependenciesByDocument) {
    if (dependencies.has(normalizedChangedPath)) {
      result.push(documentId);
    }
  }
  return result;
}

/** Merges compile dependencies and exact non-dependency watch candidates for one document. */
export function dependencyPathsForDocument(
  dependencies: readonly CompileDependency[],
  additionalWatchPaths: readonly string[]
): Set<string> {
  return new Set([
    ...dependencies.map(dependency => normalizeDependencyPath(dependency.path)),
    ...additionalWatchPaths.map(normalizeDependencyPath)
  ]);
}

/** Returns the stable, deduplicated dependency union for all open documents. */
export function dependencyPathsForDocuments(
  dependenciesByDocument: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const paths = new Set<string>();
  for (const dependencies of dependenciesByDocument.values()) {
    for (const dependency of dependencies) {
      paths.add(normalizeDependencyPath(dependency));
    }
  }
  return [...paths].sort();
}

/** Normalizes dependency paths for stable identity comparisons across watcher events. */
export function normalizeDependencyPath(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export interface RsglSemanticWatchBatchCallbacks {
  invalidatePath(fileName: string): void;
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
  settings: RsglValidationSettings
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
      resourcePackRoots: projectConfig?.resourcePackRoots ?? settings.resourcePackRoots
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
  if (topLevelProperty === "namespace" || topLevelProperty === "target" || topLevelProperty === "maxEvaluationItems") {
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
  try {
    return getRsglDocumentDefinitionLocation({
      fileName,
      getText: () => document.getText()
    }, offset, deps) ?? null;
  } catch {
    return null;
  }
}

/** Converts a core definition range using the target document's UTF-16 position mapping. */
export function toLspDefinitionLocation(
  targetDocument: RsglLspDocument,
  targetUri: string,
  definition: RsglDefinitionLocation
): Location {
  return {
    uri: targetUri,
    range: {
      start: targetDocument.positionAt(clampOffset(targetDocument, definition.range.start)),
      end: targetDocument.positionAt(clampOffset(targetDocument, definition.range.end))
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
export interface RsglRenameTargetDocument extends RsglLspDocument {
  uri: string;
}

/**
 * Converts a complete cross-file rename atomically. If any target document
 * cannot be loaded, no partial WorkspaceEdit is returned.
 */
export async function toLspWorkspaceEdit(
  edits: readonly RsglRenameEdit[],
  loadDocument: (fileName: string) => Promise<RsglRenameTargetDocument | null>
): Promise<WorkspaceEdit | null> {
  try {
    const loadedDocuments: Array<{ fileName: string; document: RsglRenameTargetDocument }> = [];
    const changes = new Map<string, TextEdit[]>();
    for (const edit of edits) {
      let target = loadedDocuments.find(candidate => sameFileName(candidate.fileName, edit.fileName));
      if (!target) {
        const document = await loadDocument(edit.fileName);
        if (!document) {
          return null;
        }
        target = { fileName: edit.fileName, document };
        loadedDocuments.push(target);
      }
      const documentEdits = changes.get(target.document.uri) ?? [];
      if (!changes.has(target.document.uri)) {
        changes.set(target.document.uri, documentEdits);
      }
      documentEdits.push({
        range: {
          start: target.document.positionAt(clampOffset(target.document, edit.range.start)),
          end: target.document.positionAt(clampOffset(target.document, edit.range.end))
        },
        newText: edit.newText
      });
    }
    return { changes: Object.fromEntries(changes) };
  } catch {
    return null;
  }
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

/** Normalizes a filesystem path for identity comparisons. */
export function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function sameFileName(left: string, right: string): boolean {
  const leftNormalized = normalizeFileName(path.resolve(left));
  const rightNormalized = normalizeFileName(path.resolve(right));
  return process.platform === "win32"
    ? leftNormalized.toLowerCase() === rightNormalized.toLowerCase()
    : leftNormalized === rightNormalized;
}
