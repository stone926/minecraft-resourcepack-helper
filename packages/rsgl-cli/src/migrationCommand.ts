import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyTextEdits,
  migrateLegacyBlockstateProgram,
  RsglWorkspaceSourceCache,
  type RsglFileMigrationResult,
  type RsglMigrationProgramFile
} from "../../rsgl-core/src";

export interface RsglMigrationCommandOptions {
  target: string;
  write: boolean;
}

export interface RsglMigrationCommandIo {
  writeOut(text: string): void;
  writeErr(text: string): void;
}

export interface RsglMigrationFileIdentity {
  dev: number;
  ino: number;
  mode: number;
}

/** Narrow seam for deterministic transaction tests; program loading still uses the workspace cache. */
export interface RsglMigrationTransactionFileSystem {
  exists(fileName: string): boolean;
  identity(fileName: string): RsglMigrationFileIdentity;
  link(source: string, destination: string): void;
  readText(fileName: string): string;
  remove(fileName: string): void;
  rename(source: string, destination: string): void;
  writeTextExclusive(fileName: string, text: string, mode: number): void;
}

export interface RsglMigrationCommandDependencies {
  transactionFileSystem?: RsglMigrationTransactionFileSystem;
}

interface PendingMigrationWrite {
  fileName: string;
  originalText: string;
  migratedText: string;
  temporaryFileName: string;
  temporaryIdentity: RsglMigrationFileIdentity;
  backupFileName: string;
  backupIdentity?: RsglMigrationFileIdentity;
  backupText?: string;
  originalMoved: boolean;
  replacementInstalled: boolean;
}

interface MigrationRecoveryReport {
  problems: string[];
  artifacts: Map<string, string>;
}

const nodeMigrationTransactionFileSystem: RsglMigrationTransactionFileSystem = {
  exists: fileName => fs.existsSync(fileName),
  identity: fileName => fileIdentity(fs.statSync(fileName)),
  link: (source, destination) => fs.linkSync(source, destination),
  readText: fileName => fs.readFileSync(fileName, "utf8"),
  remove: fileName => fs.rmSync(fileName),
  rename: (source, destination) => fs.renameSync(source, destination),
  writeTextExclusive: (fileName, text, mode) => {
    fs.writeFileSync(fileName, text, {
      encoding: "utf8",
      flag: "wx",
      mode
    });
  }
};

/** Runs the filesystem-facing migration workflow; semantic decisions stay in core. */
export function runRsglMigrationCommand(
  options: RsglMigrationCommandOptions,
  io: RsglMigrationCommandIo,
  dependencies: RsglMigrationCommandDependencies = {}
): number {
  try {
    const target = path.resolve(options.target);
    const stat = fs.statSync(target);
    if (!stat.isFile() && !stat.isDirectory()) {
      throw new Error(`Migration target is not a file or directory: ${target}`);
    }
    if (stat.isFile() && path.extname(target).toLowerCase() !== ".rsgl") {
      throw new Error(`Migration file must use the .rsgl extension: ${target}`);
    }

    const sourceCache = new RsglWorkspaceSourceCache();
    const sourceFiles = stat.isFile()
      ? sourceCache.loadProgramFromEntry(target)
      : sourceCache.loadProgramFromDirectory(target);
    const migrationFiles = migrationInputs(sourceFiles, target, stat.isFile());
    const result = migrateLegacyBlockstateProgram(migrationFiles);
    const issueCount = printMigrationIssues(result.files, io);
    const changedFiles = result.files.filter(file => file.edits.length > 0);

    if (!options.write) {
      for (const file of changedFiles) {
        io.writeOut(`Would migrate ${file.fileName} (${editCountLabel(file.edits.length)}).\n`);
      }
      io.writeOut(
        `RSGL migration dry run: ${changedFiles.length} file(s) would change, ${issueCount} issue(s).`
        + (changedFiles.length > 0 ? " Re-run with --write to apply.\n" : "\n")
      );
      return issueCount > 0 ? 1 : 0;
    }

    writeMigrationTransaction(
      changedFiles,
      migrationFiles,
      dependencies.transactionFileSystem ?? nodeMigrationTransactionFileSystem
    );
    for (const file of changedFiles) {
      io.writeOut(`Migrated ${file.fileName} (${editCountLabel(file.edits.length)}).\n`);
    }
    io.writeOut(`RSGL migration complete: ${changedFiles.length} file(s) changed, ${issueCount} issue(s).\n`);
    return issueCount > 0 ? 1 : 0;
  } catch (error) {
    io.writeErr(`RSGL migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function migrationInputs(
  sourceFiles: readonly { fileName: string; module: RsglMigrationProgramFile["module"] }[],
  target: string,
  targetIsFile: boolean
): RsglMigrationProgramFile[] {
  return sourceFiles.map(file => {
    const isTarget = targetIsFile
      ? sameFileName(file.fileName, target)
      : isPathInsideOrEqual(file.fileName, target);
    return {
      ...file,
      ...(isTarget && isDiskRsglFile(file.fileName)
        ? { sourceText: fs.readFileSync(file.fileName, "utf8") }
        : {})
    };
  });
}

function printMigrationIssues(
  files: readonly RsglFileMigrationResult[],
  io: RsglMigrationCommandIo
): number {
  let count = 0;
  for (const file of files) {
    for (const issue of file.issues) {
      io.writeErr(`${file.fileName}: warning ${issue.code}: ${issue.message}\n`);
      count++;
    }
  }
  return count;
}

function writeMigrationTransaction(
  changedFiles: readonly RsglFileMigrationResult[],
  inputs: readonly RsglMigrationProgramFile[],
  fileSystem: RsglMigrationTransactionFileSystem
): void {
  const sourceTextByFileName = new Map(
    inputs
      .filter((file): file is RsglMigrationProgramFile & { sourceText: string } => file.sourceText !== undefined)
      .map(file => [fileNameKey(file.fileName), file.sourceText] as const)
  );
  const pending: PendingMigrationWrite[] = [];

  try {
    for (const file of changedFiles) {
      const originalText = sourceTextByFileName.get(fileNameKey(file.fileName));
      if (originalText === undefined) {
        throw new Error(`Missing source text for migration target: ${file.fileName}`);
      }
      const migratedText = applyTextEdits(originalText, file.edits);
      const fileIdentity = fileSystem.identity(file.fileName);
      const temporaryFileName = uniqueSiblingPath(file.fileName, "migrate-tmp", fileSystem);
      const backupFileName = uniqueSiblingPath(file.fileName, "migrate-backup", fileSystem);
      let temporaryIdentity: RsglMigrationFileIdentity;
      try {
        fileSystem.writeTextExclusive(temporaryFileName, migratedText, fileIdentity.mode);
        temporaryIdentity = fileSystem.identity(temporaryFileName);
      } catch (error) {
        const artifact = fileSystem.exists(temporaryFileName)
          ? ` Recovery/artifact path: ${temporaryFileName}.`
          : "";
        throw new Error(
          `Could not prepare migration replacement: ${errorMessage(error)}.${artifact}`,
          { cause: error }
        );
      }
      pending.push({
        fileName: file.fileName,
        originalText,
        migratedText,
        temporaryFileName,
        temporaryIdentity,
        backupFileName,
        originalMoved: false,
        replacementInstalled: false
      });
    }

    // Complete all fallible reads before the first rename, preventing a stale
    // analysis from partially updating a multi-file migration.
    for (const item of pending) {
      if (fileSystem.readText(item.fileName) !== item.originalText) {
        throw new Error(`Source changed while migration was being prepared: ${item.fileName}`);
      }
    }

    for (const item of pending) {
      fileSystem.rename(item.fileName, item.backupFileName);
      item.originalMoved = true;
      item.backupIdentity = fileSystem.identity(item.backupFileName);
      item.backupText = fileSystem.readText(item.backupFileName);
      if (item.backupText !== item.originalText) {
        throw new Error(
          `Source changed after migration preflight; the moved file no longer matches the analyzed source: ${item.fileName}`
        );
      }
      if (!isOwnedUnmodifiedFile(
        item.temporaryFileName,
        item.temporaryIdentity,
        item.migratedText,
        fileSystem
      )) {
        throw new Error(`Prepared migration replacement changed before installation: ${item.temporaryFileName}`);
      }
      // link() is an atomic, no-overwrite installation because both paths are
      // siblings on the same filesystem. Keep the temporary hard link until
      // every replacement has been installed so rollback can identify it.
      fileSystem.link(item.temporaryFileName, item.fileName);
      item.replacementInstalled = true;
    }

    // Preserve all backups until every installed path has been validated. A
    // concurrent atomic save is detected by identity even if its bytes happen
    // to match the migration output.
    for (const item of pending) {
      if (!isOwnedUnmodifiedFile(
        item.fileName,
        item.temporaryIdentity,
        item.migratedText,
        fileSystem
      )) {
        throw new Error(`Installed migration replacement changed during the transaction: ${item.fileName}`);
      }
      if (item.backupIdentity === undefined || !isOwnedUnmodifiedFile(
        item.backupFileName,
        item.backupIdentity,
        item.originalText,
        fileSystem
      )) {
        throw new Error(`Migration backup changed during the transaction: ${item.backupFileName}`);
      }
    }
  } catch (error) {
    const recovery = rollbackMigrationWrites(pending, fileSystem);
    throw transactionFailure(error, recovery);
  }

  const cleanup = createRecoveryReport();
  for (const item of pending) {
    const problemCountBeforeItem = cleanup.problems.length;
    removeOwnedFile(
      item.temporaryFileName,
      item.temporaryIdentity,
      item.migratedText,
      "prepared replacement",
      cleanup,
      fileSystem
    );
    if (item.backupIdentity !== undefined) {
      if (cleanup.problems.length === problemCountBeforeItem && isOwnedUnmodifiedFile(
        item.fileName,
        item.temporaryIdentity,
        item.migratedText,
        fileSystem
      )) {
        removeOwnedFile(
          item.backupFileName,
          item.backupIdentity,
          item.originalText,
          "original source backup",
          cleanup,
          fileSystem
        );
      } else {
        cleanup.problems.push(
          `retained the source backup because ${item.fileName} could not be revalidated safely during cleanup`
        );
        preserveIfPresent(
          item.backupFileName,
          "original source backup for recovery",
          cleanup,
          fileSystem
        );
      }
    }
  }
  if (cleanup.problems.length > 0 || cleanup.artifacts.size > 0) {
    throw new Error(
      `Migration was applied, but cleanup was incomplete. ${formatRecoveryReport(cleanup)}`
    );
  }
}

function rollbackMigrationWrites(
  pending: readonly PendingMigrationWrite[],
  fileSystem: RsglMigrationTransactionFileSystem
): MigrationRecoveryReport {
  const recovery = createRecoveryReport();
  for (let index = pending.length - 1; index >= 0; index--) {
    const item = pending[index];
    let displacedFileName: string | undefined;

    if (item.replacementInstalled) {
      try {
        displacedFileName = uniqueSiblingPath(item.fileName, "migrate-rollback", fileSystem);
        // Moving first never deletes a save that raced with rollback. The
        // moved path is removed only when identity and bytes prove it is ours.
        fileSystem.rename(item.fileName, displacedFileName);
      } catch (error) {
        recovery.problems.push(
          `could not move the installed path aside for ${item.fileName}: ${errorMessage(error)}`
        );
        preserveIfPresent(item.fileName, "current file", recovery, fileSystem);
      }
    }

    let originalRestored = !item.originalMoved;
    if (item.originalMoved) {
      if (
        item.backupIdentity === undefined
        || item.backupText === undefined
        || !isOwnedUnmodifiedFile(
          item.backupFileName,
          item.backupIdentity,
          item.backupText,
          fileSystem
        )
      ) {
        recovery.problems.push(`could not verify the source backup for ${item.fileName}`);
        preserveIfPresent(item.backupFileName, "unverified source backup", recovery, fileSystem);
      } else {
        try {
          // link() restores only when the destination is absent. It therefore
          // cannot overwrite a concurrent editor save that appeared meanwhile.
          fileSystem.link(item.backupFileName, item.fileName);
          originalRestored = true;
        } catch (error) {
          recovery.problems.push(
            `could not restore ${item.fileName} without overwriting the current file: ${errorMessage(error)}`
          );
          preserveIfPresent(item.fileName, "current file preserved during rollback", recovery, fileSystem);
          preserveIfPresent(item.backupFileName, "source backup for manual recovery", recovery, fileSystem);
        }
      }
    }

    if (originalRestored && item.backupIdentity !== undefined && item.backupText !== undefined) {
      removeOwnedFile(
        item.backupFileName,
        item.backupIdentity,
        item.backupText,
        "source backup",
        recovery,
        fileSystem
      );
    }

    if (displacedFileName !== undefined) {
      if (isOwnedUnmodifiedFile(
        displacedFileName,
        item.temporaryIdentity,
        item.migratedText,
        fileSystem
      )) {
        removeOwnedFile(
          displacedFileName,
          item.temporaryIdentity,
          item.migratedText,
          "rolled-back replacement",
          recovery,
          fileSystem
        );
      } else {
        recovery.problems.push(`concurrent content was preserved while rolling back ${item.fileName}`);
        preserveIfPresent(
          displacedFileName,
          "concurrent content moved aside during rollback",
          recovery,
          fileSystem
        );
      }
    }

    removeOwnedFile(
      item.temporaryFileName,
      item.temporaryIdentity,
      item.migratedText,
      "prepared replacement",
      recovery,
      fileSystem
    );
    if (!item.originalMoved && fileSystem.exists(item.backupFileName)) {
      recovery.problems.push(
        `an unexpected backup path appeared before the move was recorded for ${item.fileName}`
      );
      recovery.artifacts.set(item.backupFileName, "unverified backup path");
    }
  }
  return recovery;
}

function removeOwnedFile(
  fileName: string,
  identity: RsglMigrationFileIdentity,
  expectedText: string | undefined,
  description: string,
  recovery: MigrationRecoveryReport,
  fileSystem: RsglMigrationTransactionFileSystem
): void {
  if (!fileSystem.exists(fileName)) {
    return;
  }
  if (expectedText === undefined || !isOwnedUnmodifiedFile(fileName, identity, expectedText, fileSystem)) {
    recovery.problems.push(`refused to remove changed or replaced ${description}: ${fileName}`);
    recovery.artifacts.set(fileName, description);
    return;
  }
  try {
    fileSystem.remove(fileName);
  } catch (error) {
    recovery.problems.push(`could not remove ${description} ${fileName}: ${errorMessage(error)}`);
    preserveIfPresent(fileName, description, recovery, fileSystem);
  }
}

function uniqueSiblingPath(
  fileName: string,
  purpose: string,
  fileSystem: RsglMigrationTransactionFileSystem
): string {
  const directory = path.dirname(fileName);
  const baseName = path.basename(fileName);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = path.join(
      directory,
      `.${baseName}.${purpose}-${process.pid}-${Date.now().toString(36)}-${attempt}`
    );
    if (!fileSystem.exists(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not allocate a temporary migration path beside ${fileName}.`);
}

function isOwnedUnmodifiedFile(
  fileName: string,
  identity: RsglMigrationFileIdentity,
  expectedText: string,
  fileSystem: RsglMigrationTransactionFileSystem
): boolean {
  return sameIdentity(safeIdentity(fileName, fileSystem), identity)
    && safeReadText(fileName, fileSystem) === expectedText;
}

function sameIdentity(
  left: RsglMigrationFileIdentity | undefined,
  right: RsglMigrationFileIdentity
): boolean {
  // An inode of zero is not a useful identity on filesystems that do not
  // expose file IDs. In that case cleanup errs on the side of preservation.
  return left !== undefined
    && left.ino !== 0
    && right.ino !== 0
    && left.dev === right.dev
    && left.ino === right.ino;
}

function safeIdentity(
  fileName: string,
  fileSystem: RsglMigrationTransactionFileSystem
): RsglMigrationFileIdentity | undefined {
  try {
    return fileSystem.identity(fileName);
  } catch {
    return undefined;
  }
}

function safeReadText(
  fileName: string,
  fileSystem: RsglMigrationTransactionFileSystem
): string | undefined {
  try {
    return fileSystem.readText(fileName);
  } catch {
    return undefined;
  }
}

function preserveIfPresent(
  fileName: string,
  description: string,
  recovery: MigrationRecoveryReport,
  fileSystem: RsglMigrationTransactionFileSystem
): void {
  if (fileSystem.exists(fileName)) {
    recovery.artifacts.set(fileName, description);
  }
}

function transactionFailure(error: unknown, recovery: MigrationRecoveryReport): Error {
  const primary = errorMessage(error);
  if (recovery.problems.length === 0 && recovery.artifacts.size === 0) {
    return error instanceof Error ? error : new Error(primary);
  }
  return new Error(
    `${primary} Rollback was incomplete. ${formatRecoveryReport(recovery)}`,
    { cause: error }
  );
}

function createRecoveryReport(): MigrationRecoveryReport {
  return { problems: [], artifacts: new Map() };
}

function formatRecoveryReport(recovery: MigrationRecoveryReport): string {
  const parts: string[] = [];
  if (recovery.problems.length > 0) {
    parts.push(`Problems: ${recovery.problems.join("; ")}.`);
  }
  if (recovery.artifacts.size > 0) {
    parts.push(
      `Recovery/artifact paths: ${[...recovery.artifacts]
        .map(([fileName, description]) => `${fileName} (${description})`)
        .join(", ")}.`
    );
  }
  return parts.join(" ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fileIdentity(stat: fs.Stats): RsglMigrationFileIdentity {
  return { dev: stat.dev, ino: stat.ino, mode: stat.mode };
}

function isDiskRsglFile(fileName: string): boolean {
  return path.extname(fileName).toLowerCase() === ".rsgl" && fs.existsSync(fileName);
}

function isPathInsideOrEqual(fileName: string, directory: string): boolean {
  const relative = path.relative(path.resolve(directory), path.resolve(fileName));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function sameFileName(left: string, right: string): boolean {
  return fileNameKey(left) === fileNameKey(right);
}

function fileNameKey(fileName: string): string {
  const normalized = path.normalize(path.resolve(fileName));
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function editCountLabel(count: number): string {
  return `${count} edit${count === 1 ? "" : "s"}`;
}
