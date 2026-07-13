import * as path from "node:path";
import { parseRsgl } from "../parser";
import {
  bindRsglProgram,
  type RsglBindOptions,
  type RsglSourceFile
} from "../semantic";
import { migrateLegacyBlockstates } from "./blockstateMigration";
import type { MigrationIssue, TextEdit } from "./types";

/** A source participating in program binding. Only files with sourceText are migrated. */
export interface RsglMigrationProgramFile extends RsglSourceFile {
  sourceText?: string;
}

/** A text source convenience input; its module is parsed by the coordinator. */
export interface RsglMigrationTextFile {
  fileName: string;
  sourceText: string;
}

export interface RsglFileMigrationResult {
  fileName: string;
  edits: TextEdit[];
  issues: MigrationIssue[];
}

export interface RsglProgramMigrationResult {
  files: RsglFileMigrationResult[];
}

/**
 * Coordinates blockstate migration over a fully linked program. Imported and
 * re-exported template metadata is resolved once before any file is migrated.
 * This function performs no filesystem or protocol writes.
 */
export function migrateLegacyBlockstateProgram(
  files: readonly RsglMigrationProgramFile[],
  options: RsglBindOptions = {}
): RsglProgramMigrationResult {
  const sourceFiles: RsglSourceFile[] = files.map(file => ({
    fileName: file.fileName,
    module: file.module
  }));
  const program = bindRsglProgram(sourceFiles, options);
  const modelByFileName = new Map(
    program.models.map(model => [fileNameKey(model.fileName), model] as const)
  );
  const results: RsglFileMigrationResult[] = [];

  for (const file of files) {
    if (file.sourceText === undefined) {
      continue;
    }
    const semanticModel = modelByFileName.get(fileNameKey(file.fileName));
    if (!semanticModel) {
      continue;
    }
    const result = migrateLegacyBlockstates({
      sourceText: file.sourceText,
      module: file.module,
      semanticModel
    });
    results.push({ fileName: file.fileName, ...result });
  }

  return { files: results };
}

/** Parses and migrates a set of in-memory files as one linked program. */
export function migrateLegacyBlockstateFiles(
  files: readonly RsglMigrationTextFile[],
  options: RsglBindOptions = {}
): RsglProgramMigrationResult {
  return migrateLegacyBlockstateProgram(files.map(file => ({
    ...file,
    module: parseRsgl(file.sourceText)
  })), options);
}

/** Parses and migrates one standalone in-memory source file. */
export function migrateLegacyBlockstateFile(
  file: RsglMigrationTextFile,
  options: RsglBindOptions = {}
): RsglFileMigrationResult {
  return migrateLegacyBlockstateFiles([file], options).files[0] ?? {
    fileName: file.fileName,
    edits: [],
    issues: []
  };
}

function fileNameKey(fileName: string): string {
  const normalized = path.normalize(fileName);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
