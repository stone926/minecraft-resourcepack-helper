import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  getRsglCompletionItems,
  type RsglCompletionItem,
  type RsglCompletionNamespace
} from "./completionService";
import { visibleRsglSymbolsAtOffset } from "./completionScope";
import {
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
import type { RsglWorkspaceSemanticProgram } from "./workspaceSemantic";

export interface RsglLanguageDocument {
  fileName: string;
  getText(): string;
}

export interface RsglLanguageWorkspace {
  loadProgramFromEntry(fileName: string): RsglWorkspaceSemanticProgram;
}

export function getRsglDocumentCompletionItems(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglCompletionItem[] {
  const context = semanticContextForRsglDocument(document, workspace);
  const text = document.getText();
  const members = getRsglMemberCompletionInfo(context.program, document.fileName, text, offset);
  if (members) {
    return members.map(member => ({
      label: member.name,
      kind: "property",
      detail: `${member.optional ? "optional " : ""}property: ${formatType(member.type)}`
    }));
  }
  return getRsglCompletionItems(
    text,
    offset,
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
  return getRsglHoverInfo(context.program, document.fileName, document.getText(), offset);
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

/** Resolves a touched local/imported/re-exported symbol to its declaration offsets. */
export function getRsglDocumentDefinitionLocation(
  document: RsglLanguageDocument,
  offset: number,
  workspace: RsglLanguageWorkspace
): RsglDefinitionLocation | undefined {
  const context = semanticContextForRsglDocument(document, workspace);
  return getRsglDefinitionLocation(context.program, document.fileName, document.getText(), offset);
}

export function semanticModelForRsglDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglSemanticModel {
  return semanticContextForRsglDocument(document, workspace).model;
}

interface RsglDocumentSemanticContext {
  model: RsglSemanticModel;
  program: Pick<RsglProgram, "models" | "importGraph" | "typeAliasExportMaps">;
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
  const key = normalizePathKey(path.resolve(fileName));
  return semanticProgram.program.models.find(model => normalizePathKey(path.resolve(model.fileName)) === key);
}
