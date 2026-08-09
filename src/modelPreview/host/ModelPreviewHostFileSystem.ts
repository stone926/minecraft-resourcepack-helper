import type { ModelPreviewFileSystem } from "../model/ModelDocument";
import { findByNormalizedPath, type PackMetadata } from "../../../packages/mc-assets/src";

export interface ModelPreviewOpenTextDocument {
  readonly fileName: string;
  readonly uri: { readonly scheme: string };
  getText(): string;
}

export interface ModelPreviewHostFileSystemDependencies {
  getOpenTextDocuments(): readonly ModelPreviewOpenTextDocument[];
  readTextFile(fileName: string): Promise<string>;
  readBinaryFile(fileName: string): Promise<Uint8Array>;
  fileExists(fileName: string): boolean;
  getResourceGeneration(): number;
  hasAnyResourceChangedSince(generation: number, fileNames: readonly string[]): boolean;
  fileVersion(fileName: string): string | null;
  getPackRoot(fileName: string): string | null;
  getPackMetadata(packRoot: string): PackMetadata;
}

export class ModelPreviewHostFileSystem implements ModelPreviewFileSystem {
  constructor(private readonly dependencies: ModelPreviewHostFileSystemDependencies) {}

  async readTextFile(fileName: string): Promise<string> {
    const document = findOpenTextDocument(this.dependencies.getOpenTextDocuments(), fileName);
    if (document) {
      return document.getText();
    }

    return this.dependencies.readTextFile(fileName);
  }

  async readBinaryFile(fileName: string): Promise<Uint8Array> {
    return this.dependencies.readBinaryFile(fileName);
  }

  fileExists(fileName: string): boolean {
    return this.dependencies.fileExists(fileName);
  }

  getResourceGeneration(): number {
    return this.dependencies.getResourceGeneration();
  }

  hasAnyResourceChangedSince(generation: number, fileNames: readonly string[]): boolean {
    return this.dependencies.hasAnyResourceChangedSince(generation, fileNames);
  }

  fileVersion(fileName: string): string | null {
    return this.dependencies.fileVersion(fileName);
  }

  getPackRoot(fileName: string): string | null {
    return this.dependencies.getPackRoot(fileName);
  }

  getPackMetadata(packRoot: string): PackMetadata {
    return this.dependencies.getPackMetadata(packRoot);
  }
}

function findOpenTextDocument(
  documents: readonly ModelPreviewOpenTextDocument[],
  fileName: string
): ModelPreviewOpenTextDocument | null {
  return findByNormalizedPath(
    documents,
    fileName,
    document => document.uri.scheme === "file" ? document.fileName : null
  ) ?? null;
}
