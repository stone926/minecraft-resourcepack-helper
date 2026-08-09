import type { ModelPreviewFileSystem } from "../model/ModelDocument";

/**
 * Source of raw model JSON for parent-chain resolution.
 *
 * The default implementation reads and parses through the preview file system.
 * Hosts can inject an implementation backed by the shared workspace caches so
 * model JSON is not parsed twice in separate subsystems. Parse failures must
 * throw an error whose message carries a `position <offset>` fragment so the
 * resolver can point at the offending character.
 */
export interface ParentChainModelLoader {
  readModelText(fileName: string): Promise<string>;
  parseModelValue(fileName: string, text: string): Promise<unknown> | unknown;
}

/** Loader backed only by the preview file system (previous inline behavior). */
export function createFileSystemModelLoader(fileSystem: ModelPreviewFileSystem): ParentChainModelLoader {
  return {
    readModelText: fileName => fileSystem.readTextFile(fileName),
    parseModelValue: (_fileName, text) => JSON.parse(text)
  };
}
