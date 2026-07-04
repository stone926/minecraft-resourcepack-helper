import * as fs from "node:fs";
import * as path from "node:path";
import {
  ExportDeclNode,
  ImportDeclNode,
  RsglModule,
  parseRsgl
} from "./parser";
import { RsglSourceFile } from "./semantic";

export interface RsglTextDocumentLike {
  fileName: string;
  version?: number;
  getText(): string;
}

export interface RsglWorkspaceSourceCacheOptions {
  encoding?: BufferEncoding;
}

export type RsglOpenTextDocumentProvider = (fileName: string) => RsglTextDocumentLike | null;

interface RsglCachedSourceFile {
  versionKey: string;
  sourceFile: RsglSourceFile;
}

interface RsglSourceReadResult {
  text: string;
  versionKey: string;
}

export class RsglWorkspaceSourceCache {
  private readonly sourceFiles = new Map<string, RsglCachedSourceFile>();
  private openTextDocumentProvider: RsglOpenTextDocumentProvider | null = null;

  public constructor(private readonly options: RsglWorkspaceSourceCacheOptions = {}) { }

  public setOpenTextDocumentProvider(provider: RsglOpenTextDocumentProvider | null): void {
    this.openTextDocumentProvider = provider;
    this.invalidateAll();
  }

  public invalidatePath(fileName: string): void {
    this.sourceFiles.delete(normalizeFileName(path.resolve(fileName)));
  }

  public invalidateAll(): void {
    this.sourceFiles.clear();
  }

  public loadProgramFromEntry(entryFileName: string): RsglSourceFile[] {
    const files: RsglSourceFile[] = [];
    const visited = new Set<string>();

    const visit = (fileName: string): void => {
      const normalizedFileName = normalizeFileName(path.resolve(fileName));
      if (visited.has(normalizedFileName)) {
        return;
      }
      visited.add(normalizedFileName);

      const sourceFile = this.readSourceFile(normalizedFileName);
      if (!sourceFile) {
        return;
      }
      files.push(sourceFile);

      for (const source of collectRsglRelativeModuleSources(sourceFile.module)) {
        visit(path.resolve(path.dirname(normalizedFileName), source));
      }
    };

    visit(entryFileName);
    return files;
  }

  private readSourceFile(fileName: string): RsglSourceFile | null {
    const normalizedFileName = normalizeFileName(path.resolve(fileName));
    const readResult = this.readText(normalizedFileName);
    if (!readResult) {
      this.sourceFiles.delete(normalizedFileName);
      return null;
    }

    const cached = this.sourceFiles.get(normalizedFileName);
    if (cached?.versionKey === readResult.versionKey) {
      return cached.sourceFile;
    }

    const sourceFile = {
      fileName: normalizedFileName,
      module: parseRsgl(readResult.text)
    };
    this.sourceFiles.set(normalizedFileName, { versionKey: readResult.versionKey, sourceFile });
    return sourceFile;
  }

  private readText(fileName: string): RsglSourceReadResult | null {
    const openDocument = this.openTextDocumentProvider?.(fileName);
    if (openDocument) {
      const text = openDocument.getText();
      return {
        text,
        versionKey: `open:${openDocument.version ?? "unknown"}:${hashText(text)}`
      };
    }

    try {
      const stat = fs.statSync(fileName);
      if (!stat.isFile()) {
        return null;
      }
      const text = fs.readFileSync(fileName, this.options.encoding ?? "utf8");
      return {
        text,
        versionKey: `fs:${stat.mtimeMs}:${stat.size}:${hashText(text)}`
      };
    } catch {
      return null;
    }
  }
}

export function collectRsglRelativeModuleSources(module: RsglModule): string[] {
  return module.statements
    .filter((statement): statement is ImportDeclNode | ExportDeclNode => isImportDeclNode(statement) || isExportDeclNode(statement))
    .map(statement => statement.source?.value)
    .filter((source): source is string => Boolean(source && source.startsWith(".")));
}

function normalizeFileName(fileName: string): string {
  return path.normalize(fileName);
}

function isImportDeclNode(node: unknown): node is ImportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ImportDecl");
}

function isExportDeclNode(node: unknown): node is ExportDeclNode {
  return Boolean(node && typeof node === "object" && (node as { kind?: string }).kind === "ExportDecl");
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash.toString(36);
}
