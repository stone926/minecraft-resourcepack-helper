import * as fs from "node:fs";
import * as promises from "node:fs/promises";
import * as path from "node:path";
import type {
  RsglAsyncMaterializationHost,
  RsglSyncMaterializationHost
} from "./materializationTypes";

export const nodeAsyncMaterializationHost: RsglAsyncMaterializationHost = {
  readFile: async fileName => {
    try {
      return await promises.readFile(fileName);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readDirectory: async directory => {
    try {
      return await promises.readdir(directory);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  },
  createDirectory: async directory => {
    await promises.mkdir(directory, { recursive: true });
  },
  writeFile: async (fileName, content) => {
    await promises.writeFile(fileName, content);
  },
  replaceFile: replaceFileAsync,
  deleteFile: async fileName => {
    await promises.unlink(fileName);
  },
  deleteDirectory: async directory => {
    await promises.rm(directory, { recursive: true, force: true });
  }
};

export const nodeSyncMaterializationHost: RsglSyncMaterializationHost = {
  readFile: fileName => {
    try {
      return fs.readFileSync(fileName);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    }
  },
  readDirectory: directory => {
    try {
      return fs.readdirSync(directory);
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return [];
      }
      throw error;
    }
  },
  createDirectory: directory => {
    fs.mkdirSync(directory, { recursive: true });
  },
  writeFile: (fileName, content) => {
    fs.writeFileSync(fileName, content);
  },
  replaceFile: replaceFileSync,
  deleteFile: fileName => {
    fs.unlinkSync(fileName);
  },
  deleteDirectory: directory => {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

async function replaceFileAsync(stagedFileName: string, targetFileName: string): Promise<void> {
  try {
    await promises.rename(stagedFileName, targetFileName);
    return;
  } catch (error) {
    if (!isWindowsReplaceError(error)) {
      throw error;
    }
  }
  const backup = backupPath(stagedFileName);
  await promises.rename(targetFileName, backup);
  try {
    await promises.rename(stagedFileName, targetFileName);
  } catch (error) {
    try {
      await promises.rename(backup, targetFileName);
    } catch (restoreError) {
      throw preserveStagingError(error, restoreError, backup);
    }
    throw error;
  }
  await promises.rm(backup, { force: true });
}

function replaceFileSync(stagedFileName: string, targetFileName: string): void {
  try {
    fs.renameSync(stagedFileName, targetFileName);
    return;
  } catch (error) {
    if (!isWindowsReplaceError(error)) {
      throw error;
    }
  }
  const backup = backupPath(stagedFileName);
  fs.renameSync(targetFileName, backup);
  try {
    fs.renameSync(stagedFileName, targetFileName);
  } catch (error) {
    try {
      fs.renameSync(backup, targetFileName);
    } catch (restoreError) {
      throw preserveStagingError(error, restoreError, backup);
    }
    throw error;
  }
  fs.rmSync(backup, { force: true });
}

function backupPath(stagedFileName: string): string {
  return path.join(path.dirname(stagedFileName), `${path.basename(stagedFileName)}.previous`);
}

function isWindowsReplaceError(error: unknown): boolean {
  return process.platform === "win32" && error !== null && typeof error === "object" && "code" in error
    && (error.code === "EEXIST" || error.code === "EPERM" || error.code === "EACCES");
}

function isFileNotFoundError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function preserveStagingError(
  commitError: unknown,
  restoreError: unknown,
  backup: string
): AggregateError & { preserveRsglStaging: true } {
  return Object.assign(new AggregateError(
    [commitError, restoreError],
    `Failed to replace the output and restore its backup; recovery copy remains at '${backup}'.`
  ), { preserveRsglStaging: true as const });
}
