import * as fs from "node:fs";
import type { ModelPreviewFileSystem } from "../model/ModelDocument";

/**
 * Explicit Node adapter for tests, benchmarks, and other non-VS Code hosts.
 * The extension host injects its workspace-cache-backed implementation instead.
 */
export const nodeModelPreviewFileSystem: ModelPreviewFileSystem = Object.freeze({
  readTextFile: (fileName: string) => fs.promises.readFile(fileName, "utf8"),
  readBinaryFile: (fileName: string) => fs.promises.readFile(fileName),
  fileExists: (fileName: string) => fs.existsSync(fileName),
  fileVersion: (fileName: string) => {
    try {
      const stat = fs.statSync(fileName);
      return `${stat.mtimeMs}:${stat.size}`;
    } catch {
      return null;
    }
  }
});
