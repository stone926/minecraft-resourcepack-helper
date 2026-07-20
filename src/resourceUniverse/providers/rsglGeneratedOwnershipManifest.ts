import { joinResourceProjectUri } from "../../../packages/resource-project/src";
import type { RsglGeneratedMaterializationSnapshot } from "./rsglGeneratedMaterialization";

export interface RsglGeneratedOwnershipManifestProjectionOptions {
  canonicalProjectId: string;
  ownershipProjectId: string;
  ownershipRevision: string;
  outputPackRootUri: string;
  /** Undefined skips disk verification; a missing map entry means the output is absent. */
  actualContentHashes?: ReadonlyMap<string, string>;
}

export interface RsglGeneratedOwnershipManifestFile {
  outputPath: string;
  producerId: string;
  contentHash: string;
}

export interface RsglGeneratedOwnershipManifest {
  projectId: string;
  sourceRoot: string;
  outputPackRootIdentity: string;
  buildRevision: string;
  files: readonly RsglGeneratedOwnershipManifestFile[];
}

/**
 * Reads only the ownership fields needed by ResourceUniverse. The main bundle
 * deliberately does not import compiler manifest code across the lazy boundary.
 */
export function projectRsglGeneratedOwnershipManifest(
  text: string,
  options: RsglGeneratedOwnershipManifestProjectionOptions
): RsglGeneratedMaterializationSnapshot {
  return projectParsedRsglGeneratedOwnershipManifest(
    parseRsglGeneratedOwnershipManifest(text),
    options
  );
}

export function parseRsglGeneratedOwnershipManifest(
  text: string
): RsglGeneratedOwnershipManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid RSGL ownership manifest JSON: ${errorMessage(error)}`, { cause: error });
  }
  const manifest = requireRecord(value, "manifest");
  if (manifest.version !== 2) {
    throw new Error(`Unsupported RSGL ownership manifest version '${String(manifest.version)}'.`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error("The RSGL ownership manifest files field must be an array.");
  }

  const files = manifest.files.map((value, index) => {
      const file = requireRecord(value, `files[${index}]`);
      const outputPath = requirePortableOutputPath(file.outputPath, `files[${index}].outputPath`);
      return {
        producerId: requireIdentity(file.producerId, `files[${index}].producerId`),
        outputPath,
        contentHash: requireContentHash(file.contentHash, `files[${index}].contentHash`)
      };
    });
  if (new Set(files.map(file => file.outputPath)).size !== files.length) {
    throw new Error("The RSGL ownership manifest contains duplicate output paths.");
  }
  return {
    projectId: requireIdentity(manifest.projectId, "projectId"),
    sourceRoot: requireIdentity(manifest.sourceRoot, "sourceRoot"),
    outputPackRootIdentity: requireIdentity(
      manifest.outputPackRootIdentity,
      "outputPackRootIdentity"
    ),
    buildRevision: requireIdentity(manifest.buildRevision, "buildRevision"),
    files
  };
}

export function projectParsedRsglGeneratedOwnershipManifest(
  manifest: RsglGeneratedOwnershipManifest,
  options: RsglGeneratedOwnershipManifestProjectionOptions
): RsglGeneratedMaterializationSnapshot {
  if (manifest.projectId !== options.ownershipProjectId) {
    throw new Error("The RSGL ownership manifest belongs to a different materialization project.");
  }
  if (manifest.buildRevision !== options.ownershipRevision) {
    throw new Error("The RSGL ownership manifest revision does not match the committed transaction.");
  }
  return {
    projectId: requireIdentity(options.canonicalProjectId, "canonicalProjectId"),
    revision: requireIdentity(options.ownershipRevision, "ownershipRevision"),
    ownedOutputPaths: manifest.files.map(file => file.outputPath),
    entries: manifest.files.map(file => {
      const actualHash = options.actualContentHashes?.get(file.outputPath);
      const exists = options.actualContentHashes === undefined || actualHash !== undefined;
      return {
        producerId: file.producerId,
        outputPath: file.outputPath,
        state: options.actualContentHashes === undefined || actualHash === file.contentHash
          ? "current" as const
          : exists
            ? "conflict" as const
            : "stale" as const,
        owned: true,
        locations: exists ? [{
          uri: joinResourceProjectUri(options.outputPackRootUri, file.outputPath)
        }] : []
      };
    })
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid RSGL ownership manifest ${label}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function requireIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`Invalid RSGL ownership manifest ${label}: expected a non-empty identity.`);
  }
  return value.trim();
}

function requireContentHash(value: unknown, label: string): string {
  const hash = requireIdentity(value, label);
  if (!/^sha256:[a-f\d]{64}$/i.test(hash)) {
    throw new Error(`Invalid RSGL ownership manifest ${label}: expected a sha256 hash.`);
  }
  return hash.toLowerCase();
}

function requirePortableOutputPath(value: unknown, label: string): string {
  const outputPath = requireIdentity(value, label).replaceAll("\\", "/");
  if (outputPath.startsWith("/")
    || /^[a-zA-Z]:/.test(outputPath)
    || outputPath.split("/").some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid RSGL ownership manifest ${label}: expected a portable output path.`);
  }
  return outputPath;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
