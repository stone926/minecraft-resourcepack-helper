import { semanticModelForRsglLanguageFile } from "./semanticOccurrences";
import {
  getRsglCompletionItemsForContext,
  type RsglCompletionItem,
  type RsglCompletionNamespace
} from "./completionService";
import { getRsglCompletionContext } from "./completionContext";
import { visibleRsglSymbolsAtOffset } from "./completionScope";
import {
  callablePresentation,
  getRsglDefinitionLocation,
  getRsglHoverInfo,
  getRsglSignatureHelpInfo,
  type RsglDefinitionLocation,
  type RsglHoverInfo,
  type RsglSignatureHelpInfo
} from "./languageIntelligence";
import { getRsglMemberCompletionInfo } from "./memberLanguageIntelligence";
import { parseRsgl } from "./parser";
import { walkRsglModule } from "./parser/astTraversal";
import {
  bindRsglModule,
  type RsglProgram,
  type RsglSemanticModel
} from "./semantic";
import {
  getRsglSemanticTokens,
  type RsglSemanticToken
} from "./semanticTokens";
import { formatType } from "./semantic/typeRelations";
import { getRsglItemModelHoverInfo } from "./itemModelLanguageIntelligence";
import { isItemModelCompletionKeyPosition } from "./itemModelCompletionContext";
import type { ItemModelFormat } from "./itemModelSchema";
import { itemModelTargetFormatInModule } from "./itemModelTarget";
import type { RsglWorkspaceSemanticProgram } from "./workspaceSemantic";
import {
  getRsglSemanticReferenceLocations,
  isRsglResourceSemanticTargetAtOffset,
  type RsglReferenceLocation
} from "./referenceService";
import {
  getRsglResourceDefinitionLocationsAtOffset,
  getRsglResourceReferenceLocationsAtOffset,
  type RsglResourceNavigationIndex
} from "./compiler/resourceNavigation";
import {
  getRsglNamespaceRenameEdits,
  prepareRsglNamespaceRename,
  type RsglRenameEdit,
  type RsglRenameTarget
} from "./renameService";

export interface RsglLanguageDocument {
  fileName: string;
  getText(): string;
}

export interface RsglLanguageWorkspace {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
  /**
   * Lazily loads the source-root program used by workspace-wide navigation.
   * Implementations should cache this directory program and prefer open text.
   */
  loadProgramForNavigation?(fileName: string): RsglWorkspaceSemanticProgram;
  /**
   * Lazily compiles and caches canonical generated-resource navigation facts.
   * A source-root program loaded for the same request is supplied for reuse.
   */
  loadResourceNavigation?(
    fileName: string,
    semanticProgram?: RsglWorkspaceSemanticProgram
  ): RsglResourceNavigationIndex;
  /** Cached project fallback used only when the source has no target declaration. */
  projectItemModelTargetFormatForSource?(fileName: string): ItemModelFormat | undefined;
}

export function getRsglDocumentCompletionItems(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglCompletionItem[] {
  const context = semanticContextForRsglDocument(document, workspace);
  const text = document.getText();
  const effectiveTarget = effectiveItemModelTargetForDocument(
    context.model.module,
    document.fileName,
    workspace
  );
  const completionContext = getRsglCompletionContext(text, offset, effectiveTarget);
  const itemSchemaOwnsCompletion = Boolean(completionContext.itemModel?.schema)
    || isItemModelCompletionKeyPosition(completionContext.itemModel);
  const members = itemSchemaOwnsCompletion
    ? undefined
    : getRsglMemberCompletionInfo(context.program, document.fileName, text, offset);
  if (members) {
    return members.map(member => {
      if (!member.category || !member.symbol) {
        return {
          label: member.name,
          kind: "property" as const,
          detail: `${member.optional ? "optional " : ""}property: ${formatType(member.type)}`
        };
      }
      const callable = callablePresentation(member.symbol, member.name);
      return {
        label: member.name,
        kind: callable ? "function" as const : "variable" as const,
        detail: callable
          ? `${member.category}: ${callable.detail ? `${callable.label} — ${callable.detail}` : callable.label}`
          : `${member.category}: ${formatType(member.type)}`
      };
    });
  }
  return getRsglCompletionItemsForContext(
    completionContext,
    visibleRsglSymbolsAtOffset(context.model, offset),
    context.model.scope.typeAliases,
    completionNamespaceAt(context.model, text, offset)
  );
}

export function getRsglDocumentSemanticTokens(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglSemanticToken[] {
  return getRsglSemanticTokens(semanticModelForRsglDocument(document, workspace));
}

/** Returns hover information from the linked semantic model, never from completion labels. */
export function getRsglDocumentHoverInfo(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglHoverInfo | undefined {
  const context = semanticContextForRsglDocument(document, workspace);
  const text = document.getText();
  return getRsglHoverInfo(context.program, document.fileName, text, offset)
    ?? getRsglItemModelHoverInfo(
      context.model.module,
      text,
      offset,
      effectiveItemModelTargetForDocument(context.model.module, document.fileName, workspace)
    );
}

function effectiveItemModelTargetForDocument(
  module: RsglSemanticModel["module"],
  fileName: string,
  workspace: RsglLanguageWorkspace
): ItemModelFormat | undefined {
  return itemModelTargetFormatInModule(module)
    ?? projectItemModelTargetForDocument(fileName, workspace);
}

function projectItemModelTargetForDocument(
  fileName: string,
  workspace: RsglLanguageWorkspace
): ItemModelFormat | undefined {
  try {
    return workspace.projectItemModelTargetFormatForSource?.(fileName);
  } catch {
    // Project-config diagnostics own malformed configuration reporting. Language
    // features retain target-neutral union behavior while the config is invalid.
    return undefined;
  }
}

/** Returns signature help for the innermost template/function call at the cursor. */
export function getRsglDocumentSignatureHelpInfo(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglSignatureHelpInfo | undefined {
  const context = semanticContextForRsglDocument(document, workspace);
  return getRsglSignatureHelpInfo(context.program, document.fileName, document.getText(), offset);
}

/** Resolves every declaration target for a touched semantic or generated-resource symbol. */
export function getRsglDocumentDefinitionLocations(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglDefinitionLocation[] {
  const context = semanticContextForRsglDocument(document, workspace);
  const semanticDefinition = getRsglDefinitionLocation(
    context.program,
    document.fileName,
    document.getText(),
    offset
  );
  const resourceTarget = isRsglResourceSemanticTargetAtOffset(
    context.program,
    document.fileName,
    offset
  );
  if (semanticDefinition && !resourceTarget) {
    return [semanticDefinition];
  }
  const resourceIndex = resourceNavigationForDocument(document, workspace);
  const resourceDefinitions = resourceIndex
    ? getRsglResourceDefinitionLocationsAtOffset(
      resourceIndex,
      document.fileName,
      offset
    )
    : [];
  return resourceDefinitions.length > 0
    ? resourceDefinitions
    : semanticDefinition ? [semanticDefinition] : [];
}

/** Backward-compatible single-target view; protocol integrations should use the plural API. */
export function getRsglDocumentDefinitionLocation(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglDefinitionLocation | undefined {
  return getRsglDocumentDefinitionLocations(document, offset, workspace)[0];
}

/** Finds linked references across the source root, optionally including declarations. */
export function getRsglDocumentReferenceLocations(
  document: RsglLanguageDocument,
  offset: number,
  includeDeclaration: boolean,
  workspace: RsglLanguageWorkspace
): RsglReferenceLocation[] {
  const context = navigationSemanticContextForRsglDocument(document, workspace);
  const semanticReferences = getRsglSemanticReferenceLocations(
    context.program,
    document.fileName,
    offset,
    includeDeclaration
  );
  const resourceTarget = isRsglResourceSemanticTargetAtOffset(
    context.program,
    document.fileName,
    offset
  );
  if (semanticReferences !== undefined && !resourceTarget) {
    return semanticReferences;
  }
  const resourceIndex = resourceNavigationForDocument(
    document,
    workspace,
    context.workspaceProgram
  );
  if (resourceIndex) {
    const resourceReferences = getRsglResourceReferenceLocationsAtOffset(
      resourceIndex,
      document.fileName,
      offset,
      includeDeclaration
    );
    if (resourceReferences.length > 0 || resourceTarget) {
      return resourceReferences;
    }
  }
  return semanticReferences ?? [];
}

/** Prepares rename only for a module namespace alias or one of its members. */
export function prepareRsglDocumentRename(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglRenameTarget | undefined {
  const context = semanticContextForRsglDocument(document, workspace);
  return prepareRsglNamespaceRename(context.program, document.fileName, offset);
}

/** Computes offset edits; protocol layers convert each target document. */
export function getRsglDocumentRenameEdits(
  document: RsglLanguageDocument,
  offset: number,
  newName: string,
  workspace: RsglLanguageWorkspace
): RsglRenameEdit[] | undefined {
  const context = semanticContextForRsglDocument(document, workspace);
  return getRsglNamespaceRenameEdits(
    context.program,
    document.fileName,
    offset,
    newName
  );
}

export function semanticModelForRsglDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglSemanticModel {
  return semanticContextForRsglDocument(document, workspace).model;
}

interface RsglDocumentSemanticContext {
  model: RsglSemanticModel;
  program: Pick<
    RsglProgram,
    "models" | "importGraph" | "valueExportMaps" | "typeAliasExportMaps"
  >;
  workspaceProgram?: RsglWorkspaceSemanticProgram;
}

function semanticContextForRsglDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglDocumentSemanticContext {
  try {
    const semanticProgram = workspace.loadProgramFromEntry(document.fileName);
    const model = semanticModelForFile(semanticProgram, document.fileName);
    if (model) {
      return { model, program: semanticProgram.program };
    }
  } catch {
    // Completion and highlighting are best-effort; fall back to the open text.
  }
  const model = bindRsglModule(parseRsgl(document.getText()), { fileName: document.fileName });
  return {
    model,
    program: {
      models: [model],
      importGraph: {
        files: [document.fileName],
        edges: [],
        cycles: [],
        missing: []
      }
    }
  };
}

function navigationSemanticContextForRsglDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglDocumentSemanticContext {
  if (workspace.loadProgramForNavigation) {
    try {
      const semanticProgram = workspace.loadProgramForNavigation(document.fileName);
      const model = semanticModelForFile(semanticProgram, document.fileName);
      if (model) {
        return {
          model,
          program: semanticProgram.program,
          workspaceProgram: semanticProgram
        };
      }
    } catch {
      // References remain available over the entry closure or open document.
    }
  }
  return semanticContextForRsglDocument(document, workspace);
}

function resourceNavigationForDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace,
  semanticProgram?: RsglWorkspaceSemanticProgram
): RsglResourceNavigationIndex | undefined {
  try {
    return workspace.loadResourceNavigation?.(document.fileName, semanticProgram);
  } catch {
    // Resource navigation is best-effort while the source is incomplete.
    return undefined;
  }
}

function completionNamespaceAt(
  model: RsglSemanticModel,
  text: string,
  offset: number
): RsglCompletionNamespace {
  let insideType = false;
  walkRsglModule(model.module, {
    enterType(type) {
      if (type.range.start <= offset && offset <= type.range.end) {
        insideType = true;
      }
    },
    enterStatement(statement) {
      if ((statement.kind === "ImportDecl" || statement.kind === "ExportDecl")
        && statement.range.start <= offset && offset <= statement.range.end) {
        return "skipChildren";
      }
      return undefined;
    }
  });
  if (insideType || looksLikeIncompleteTypePosition(text.slice(0, offset))) {
    return "type";
  }
  const ambiguousImportOrExport = model.module.statements.some(statement =>
    (statement.kind === "ImportDecl" || statement.kind === "ExportDecl")
    && statement.range.start <= offset && offset <= statement.range.end
  );
  return ambiguousImportOrExport ? "both" : "value";
}

function looksLikeIncompleteTypePosition(prefix: string): boolean {
  const line = prefix.slice(Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r")) + 1);
  if (/^\s*type\s+[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) {
    return true;
  }
  return /(?:\blet\s+[A-Za-z_][A-Za-z0-9_]*|[A-Za-z_][A-Za-z0-9_]*\??)\s*:\s*[^=,)]*$/.test(line);
}

export function semanticModelForFile(
  semanticProgram: RsglWorkspaceSemanticProgram,
  fileName: string
): RsglSemanticModel | undefined {
  return semanticModelForRsglLanguageFile(semanticProgram.program, fileName);
}
