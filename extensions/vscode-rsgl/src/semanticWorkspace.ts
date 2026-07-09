import * as path from "node:path";
import * as vscode from "vscode";
import { normalizePathKey } from "../../../packages/mc-assets/src";
import { parseRsgl } from "../../../packages/rsgl-core/src/parser";
import {
  bindRsglModule,
  type RsglSemanticModel
} from "../../../packages/rsgl-core/src/semantic";
import type { RsglWorkspaceSemanticCache } from "../../../packages/rsgl-core/src/workspaceSemantic";

export function rsglDocumentFileName(document: vscode.TextDocument): string {
  return document.uri.fsPath || document.fileName;
}

export function semanticModelForRsglDocument(
  document: vscode.TextDocument,
  semanticCache: RsglWorkspaceSemanticCache
): RsglSemanticModel {
  const fileName = rsglDocumentFileName(document);
  const semanticProgram = semanticCache.loadProgramFromEntry(fileName);
  const key = normalizePathKey(path.resolve(fileName));
  const model = semanticProgram.program.models.find(candidate =>
    normalizePathKey(path.resolve(candidate.fileName)) === key
  );
  return model ?? bindRsglModule(parseRsgl(document.getText()), { fileName });
}
