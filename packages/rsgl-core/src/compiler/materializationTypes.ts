import type { RsglEmittedFile } from "./emit";
import type {
  RsglOwnedMaterializationPlan,
  RsglOwnershipManifestV2
} from "./ownershipManifest";
import type { RsglWritePlan } from "./write";

export const rsglMaterializationInvalidationVersion = 1;

export interface RsglMaterializationProject {
  /** Stable across builds and unique for one source project. */
  projectId: string;
  /** Portable path relative to the project's identity root. */
  sourceRoot: string;
  /** Opaque stable identity for the target resource-pack root. */
  outputPackRootIdentity: string;
}

export interface RsglMaterializationRequest {
  files: readonly RsglEmittedFile[];
  outputRoot: string;
  project: RsglMaterializationProject;
  /** Native source-root path used only to make disk provenance portable. */
  sourceRootPath?: string;
  /** Opt-in ownership claim for byte-identical, currently unowned outputs. */
  adoptUnownedIdentical?: boolean;
  transactionId?: string;
  isCancellationRequested?: () => boolean;
}

export interface RsglMaterializationDeletePreview {
  outputPath: string;
  absolutePath: string;
  status: "delete" | "alreadyAbsent" | "preserve";
  preserveReason?: "userModified" | "ownedByOtherProject";
}

export interface RsglMaterializationPreview {
  outputRoot: string;
  manifestPath: string;
  manifest: RsglOwnershipManifestV2;
  ownershipPlan: RsglOwnedMaterializationPlan;
  /** Compatibility projection for existing build preview/presenter consumers. */
  writePlan: RsglWritePlan;
  deletes: readonly RsglMaterializationDeletePreview[];
}

export type RsglMaterializationTransactionStatus =
  | "committed"
  | "conflict"
  | "cancelled"
  | "partial"
  | "failed";

export interface RsglMaterializationFailure {
  operation: "prepare" | "stage" | "revalidate" | "write" | "delete" | "manifest" | "cancel";
  message: string;
  outputPath?: string;
}

/**
 * One coalesced invalidation for every known watcher event caused by a
 * materialization transaction. URIs are serialized strings and contain no
 * file contents.
 */
export interface RsglMaterializationInvalidation {
  version: typeof rsglMaterializationInvalidationVersion;
  transactionId: string;
  projectId: string;
  ownershipRevision: string;
  state: "committed" | "partial";
  changedUris: readonly string[];
  deletedUris: readonly string[];
  manifestUri: string;
}

export interface RsglMaterializationTransactionResult {
  transactionId: string;
  status: RsglMaterializationTransactionStatus;
  preview: RsglMaterializationPreview;
  changedPaths: readonly string[];
  deletedPaths: readonly string[];
  manifestCommitted: boolean;
  invalidation?: RsglMaterializationInvalidation;
  failure?: RsglMaterializationFailure;
}

/**
 * Read, directory-creation, staging-write, and revalidation calls may run
 * concurrently in bounded batches. Implementations must therefore be
 * reentrant; final replace/delete/manifest commits remain serialized.
 */
export interface RsglAsyncMaterializationHost {
  /** Returns undefined only when the path is absent. */
  readFile(fileName: string): Promise<Uint8Array | undefined>;
  /** Returns direct child names, or an empty list when the directory is absent. */
  readDirectory(directory: string): Promise<readonly string[]>;
  createDirectory(directory: string): Promise<void>;
  writeFile(fileName: string, content: Uint8Array): Promise<void>;
  /** Commits one staged file to its final path, replacing an existing file. */
  replaceFile(stagedFileName: string, targetFileName: string): Promise<void>;
  deleteFile(fileName: string): Promise<void>;
  /** Best-effort cleanup of the transaction's private staging directory. */
  deleteDirectory(directory: string): Promise<void>;
}

export interface RsglSyncMaterializationHost {
  readFile(fileName: string): Uint8Array | undefined;
  readDirectory(directory: string): readonly string[];
  createDirectory(directory: string): void;
  writeFile(fileName: string, content: Uint8Array): void;
  replaceFile(stagedFileName: string, targetFileName: string): void;
  deleteFile(fileName: string): void;
  deleteDirectory(directory: string): void;
}
