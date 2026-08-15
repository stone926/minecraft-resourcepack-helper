import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { MissingCitResourcePlan } from "./missingCitResourcePlanner";

interface ExclusiveFileHandle {
  identity(): Promise<string>;
  writeFile(content: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

export interface SafeCitResourceFileSystem {
  realpath(filePath: string): Promise<string>;
  stat(filePath: string): Promise<void>;
  lstatExists(filePath: string): Promise<boolean>;
  mkdir(directory: string): Promise<void>;
  identity(filePath: string): Promise<string>;
  openExclusive(filePath: string): Promise<ExclusiveFileHandle>;
}

const nodeFileSystem: SafeCitResourceFileSystem = {
  realpath: filePath => fs.realpath(filePath),
  stat: async filePath => { await fs.stat(filePath); },
  lstatExists: async filePath => {
    try {
      await fs.lstat(filePath);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) {
        return false;
      }
      throw error;
    }
  },
  mkdir: async directory => { await fs.mkdir(directory, { recursive: true }); },
  identity: async filePath => fileIdentity(await fs.stat(filePath, { bigint: true })),
  openExclusive: async filePath => {
    const handle = await fs.open(filePath, "wx");
    return {
      identity: async () => fileIdentity(await handle.stat({ bigint: true })),
      writeFile: async content => { await handle.writeFile(content); },
      close: async () => { await handle.close(); }
    };
  }
};

/** Creates one missing CIT asset without following an existing link outside its pack. */
export class SafeCitResourceWriter {
  public constructor(private readonly fileSystem: SafeCitResourceFileSystem = nodeFileSystem) {}

  public async create(plan: MissingCitResourcePlan): Promise<void> {
    const packRoot = path.resolve(plan.packRoot);
    const targetPath = path.resolve(plan.targetPath);
    assertContainedPath(packRoot, targetPath);

    const realPackRoot = await this.fileSystem.realpath(packRoot);
    const targetDirectory = path.dirname(targetPath);
    const existingAncestor = await this.findExistingAncestor(targetDirectory, packRoot);
    assertContainedPath(realPackRoot, await this.fileSystem.realpath(existingAncestor), true);

    await this.fileSystem.mkdir(targetDirectory);
    const realTargetDirectory = await this.fileSystem.realpath(targetDirectory);
    assertContainedPath(realPackRoot, realTargetDirectory, true);

    // lstat sees dangling links as existing. On Windows, an exclusive path write
    // can otherwise follow a dangling final symlink and create its outside target.
    if (await this.fileSystem.lstatExists(targetPath)) {
      throw alreadyExistsError(targetPath);
    }

    const realTargetPath = path.join(realTargetDirectory, path.basename(targetPath));
    assertContainedPath(realPackRoot, realTargetPath);
    if (await this.fileSystem.lstatExists(realTargetPath)) {
      throw alreadyExistsError(targetPath);
    }

    // Create an empty file first, then validate its resolved location and identity.
    // Writing through the verified handle keeps a subsequent parent-link swap from
    // redirecting the actual payload after the containment check.
    const handle = await this.fileSystem.openExclusive(realTargetPath);
    try {
      const openedRealPath = await this.fileSystem.realpath(realTargetPath);
      assertContainedPath(realPackRoot, openedRealPath);
      if (await this.fileSystem.identity(realTargetPath) !== await handle.identity()) {
        throw new Error(`CIT resource target changed while it was being created: ${targetPath}`);
      }
      await handle.writeFile(plan.content);
    } finally {
      await handle.close();
    }
  }

  private async findExistingAncestor(directory: string, boundary: string): Promise<string> {
    let current = directory;
    while (true) {
      try {
        await this.fileSystem.stat(current);
        return current;
      } catch (error) {
        if (!isMissingPathError(error)) {
          throw error;
        }
      }
      if (samePath(current, boundary)) {
        return boundary;
      }
      const parent = path.dirname(current);
      if (parent === current || !isContainedPath(boundary, parent, true)) {
        throw new Error(`CIT resource target escapes its resource pack: ${directory}`);
      }
      current = parent;
    }
  }
}

function assertContainedPath(root: string, candidate: string, allowRoot = false): void {
  if (!isContainedPath(root, candidate, allowRoot)) {
    throw new Error(`CIT resource target escapes its resource pack: ${candidate}`);
  }
}

function isContainedPath(root: string, candidate: string, allowRoot: boolean): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (allowRoot || relative.length > 0)
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function isMissingPathError(error: unknown): boolean {
  return !!error
    && typeof error === "object"
    && "code" in error
    && ((error as { code?: unknown }).code === "ENOENT"
      || (error as { code?: unknown }).code === "ENOTDIR");
}

function alreadyExistsError(filePath: string): NodeJS.ErrnoException {
  const error = new Error(`CIT resource target already exists: ${filePath}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  return error;
}

function fileIdentity(stats: { dev: bigint; ino: bigint }): string {
  return `${stats.dev}:${stats.ino}`;
}
