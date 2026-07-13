export { migrateLegacyBlockstates } from "./blockstateMigration";
export {
  migrateLegacyBlockstateFile,
  migrateLegacyBlockstateFiles,
  migrateLegacyBlockstateProgram
} from "./programMigration";
export {
  analyzeLegacyRootTemplateMigration,
  analyzeRootTemplateOperationEffects,
  createRootTemplateOperationProgram
} from "./rootTemplateMigration";
export { applyTextEdits, sortTextEdits } from "./textEdits";
export type {
  BlockstateMigrationInput,
  MigrationIssue,
  MigrationIssueCode,
  MigrationResult,
  TextEdit
} from "./types";
export type {
  RsglFileMigrationResult,
  RsglMigrationProgramFile,
  RsglMigrationTextFile,
  RsglProgramMigrationResult
} from "./programMigration";
export type {
  RootTemplateMigrationAnalysis,
  RootTemplateMigrationOperation,
  RootTemplateMigrationStrategy,
  RootTemplateOperationEffects,
  RootTemplateOperationProgram
} from "./rootTemplateMigration";
