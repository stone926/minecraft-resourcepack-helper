import type { RsglModule, TextRange } from "../parser";
import type { RsglSemanticModel } from "../semantic";

/** Protocol-independent source edit. Ranges are UTF-16 offsets into sourceText. */
export interface TextEdit {
  range: TextRange;
  newText: string;
}

export type MigrationIssueCode =
  | "blockstateModeSelectionRequired"
  | "blockstateModeConflict"
  | "manualBlockstateApplyMigrationRequired"
  | "manualRootTemplateMigrationRequired";

export interface MigrationIssue {
  code: MigrationIssueCode;
  message: string;
  severity: "warning";
  range: TextRange;
}

export interface MigrationResult {
  edits: TextEdit[];
  issues: MigrationIssue[];
}

export interface BlockstateMigrationInput {
  sourceText: string;
  module: RsglModule;
  semanticModel: RsglSemanticModel;
}
