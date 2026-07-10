import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  resolveRsglOutputPath,
  type RsglEmittedFile,
  type RsglWritePlan,
  type RsglWritePlanEntry,
  type RsglWriteStatus
} from "../../../../packages/rsgl-core/src/compiler";

export interface RsglBuildWriteCancellationToken {
  readonly isCancellationRequested: boolean;
}

export interface RsglBuildWriteHost {
  readText(fileName: string): Promise<string | undefined>;
  readBytes(fileName: string): Promise<Uint8Array | undefined>;
  createDirectory(directory: string): Promise<void>;
  writeText(fileName: string, content: string): Promise<void>;
  copyFile(source: string, target: string): Promise<void>;
}

const nodeBuildWriteHost: RsglBuildWriteHost = {
  readText: fileName => readOptionalFile(fileName, "utf8"),
  readBytes: fileName => readOptionalFile(fileName),
  createDirectory: async directory => {
    await fs.mkdir(directory, { recursive: true });
  },
  writeText: async (fileName, content) => {
    await fs.writeFile(fileName, content, "utf8");
  },
  copyFile: async (source, target) => {
    await fs.copyFile(source, target);
  }
};

export async function applyRsglEmittedFiles(
  files: readonly RsglEmittedFile[],
  outputRoot: string,
  cancellationToken: RsglBuildWriteCancellationToken,
  host: RsglBuildWriteHost = nodeBuildWriteHost
): Promise<RsglWritePlan | null> {
  const entries: RsglWritePlanEntry[] = [];
  const summary = { create: 0, update: 0, unchanged: 0 };

  for (const file of files) {
    if (cancellationToken.isCancellationRequested) {
      return null;
    }

    const absolutePath = resolveRsglOutputPath(outputRoot, file.outputPath);
    let entry: RsglWritePlanEntry;
    if (isCopyFile(file)) {
      const [previousContent, nextContent] = await Promise.all([
        host.readBytes(absolutePath),
        host.readBytes(file.copyFrom)
      ]);
      if (!nextContent) {
        throw new Error(`Unable to read RSGL copy source '${file.copyFrom}'.`);
      }
      const status = binaryWriteStatus(previousContent, nextContent);
      entry = { ...file, absolutePath, status };
    } else {
      const previousContent = await host.readText(absolutePath);
      const status = textWriteStatus(previousContent, file.content);
      entry = { ...file, absolutePath, status };
    }
    entries.push(entry);
    summary[entry.status]++;

    if (cancellationToken.isCancellationRequested) {
      return null;
    }
    if (entry.status === "unchanged") {
      continue;
    }

    await host.createDirectory(path.dirname(absolutePath));
    if (cancellationToken.isCancellationRequested) {
      return null;
    }

    if (isCopyFile(file)) {
      await host.copyFile(file.copyFrom, absolutePath);
    } else {
      await host.writeText(absolutePath, file.content);
    }
    if (cancellationToken.isCancellationRequested) {
      return null;
    }
  }

  return {
    outputRoot: path.resolve(outputRoot),
    entries,
    summary
  };
}

function isCopyFile(file: RsglEmittedFile): file is RsglEmittedFile & { copyFrom: string } {
  return "copyFrom" in file;
}

function textWriteStatus(previous: string | undefined, next: string): RsglWriteStatus {
  return previous === undefined ? "create" : previous === next ? "unchanged" : "update";
}

function binaryWriteStatus(previous: Uint8Array | undefined, next: Uint8Array): RsglWriteStatus {
  return previous === undefined
    ? "create"
    : Buffer.compare(Buffer.from(previous), Buffer.from(next)) === 0 ? "unchanged" : "update";
}

async function readOptionalFile(fileName: string): Promise<Uint8Array | undefined>;
async function readOptionalFile(fileName: string, encoding: "utf8"): Promise<string | undefined>;
async function readOptionalFile(fileName: string, encoding?: "utf8"): Promise<string | Uint8Array | undefined> {
  try {
    return encoding ? await fs.readFile(fileName, encoding) : await fs.readFile(fileName);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
