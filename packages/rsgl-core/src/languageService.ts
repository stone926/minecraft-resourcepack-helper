import * as path from "node:path";
import { normalizePathKey } from "../../mc-assets/src";
import {
  getRsglCompletionItems,
  type RsglCompletionItem
} from "./completionService";
import { parseRsgl } from "./parser";
import {
  bindRsglModule,
  type RsglSemanticModel
} from "./semantic";
import {
  getRsglSemanticTokens,
  type RsglSemanticToken
} from "./semanticTokens";
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
  return getRsglCompletionItems(
    document.getText(),
    offset,
    semanticModelForRsglDocument(document, workspace).symbols
  );
}

export function getRsglDocumentSemanticTokens(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglSemanticToken[] {
  return getRsglSemanticTokens(semanticModelForRsglDocument(document, workspace));
}

export function semanticModelForRsglDocument(
  document: RsglLanguageDocument,
  workspace: RsglLanguageWorkspace
): RsglSemanticModel {
  try {
    const semanticProgram = workspace.loadProgramFromEntry(document.fileName);
    const model = semanticModelForFile(semanticProgram, document.fileName);
    if (model) {
      return model;
    }
  } catch {
    // Completion and highlighting are best-effort; fall back to the open text.
  }
  return bindRsglModule(parseRsgl(document.getText()), { fileName: document.fileName });
}

export function semanticModelForFile(
  semanticProgram: RsglWorkspaceSemanticProgram,
  fileName: string
): RsglSemanticModel | undefined {
  const key = normalizePathKey(path.resolve(fileName));
  return semanticProgram.program.models.find(model => normalizePathKey(path.resolve(model.fileName)) === key);
}
