import {
  createRsglMaterializationProject,
  nodeAsyncMaterializationHost,
  runRsglMaterializationTransaction,
  type RsglAsyncMaterializationHost,
  type RsglEmittedFile,
  type RsglMaterializationInvalidation,
  type RsglMaterializationProject,
  type RsglMaterializationTransactionResult
} from "../../../../packages/rsgl-core/src/compiler";

export interface RsglBuildWriteCancellationToken {
  readonly isCancellationRequested: boolean;
}

export type RsglBuildWriteHost = RsglAsyncMaterializationHost;

export interface RsglBuildMaterializationOptions {
  cancellationToken: RsglBuildWriteCancellationToken;
  /** Source file/root used to derive a stable project ID when project is omitted. */
  sourceIdentity: string;
  /** Native source-root path used to serialize portable manifest provenance. */
  sourceRootPath?: string;
  project?: RsglMaterializationProject;
  adoptUnownedIdentical?: boolean;
  transactionId?: string;
  onInvalidation?: (invalidation: RsglMaterializationInvalidation) => unknown | Promise<unknown>;
}

export interface RsglAppliedMaterialization extends RsglMaterializationTransactionResult {
  /** The filesystem commit remains authoritative even if a downstream consumer fails. */
  invalidationDeliveryFailure?: string;
}

/**
 * Applies emitted payloads through the VS Code-free ownership transaction.
 * The extension host performs only targeted asynchronous filesystem I/O.
 */
export async function applyRsglEmittedFiles(
  files: readonly RsglEmittedFile[],
  outputRoot: string,
  options: RsglBuildMaterializationOptions,
  host: RsglBuildWriteHost = nodeAsyncMaterializationHost
): Promise<RsglAppliedMaterialization> {
  const outcome = await runRsglMaterializationTransaction({
    files,
    outputRoot,
    project: options.project ?? createRsglMaterializationProject(
      options.sourceRootPath ?? options.sourceIdentity,
      outputRoot
    ),
    sourceRootPath: options.sourceRootPath ?? options.sourceIdentity,
    adoptUnownedIdentical: options.adoptUnownedIdentical,
    transactionId: options.transactionId,
    isCancellationRequested: () => options.cancellationToken.isCancellationRequested
  }, host);
  if (outcome.invalidation) {
    try {
      await options.onInvalidation?.(outcome.invalidation);
    } catch (error) {
      return {
        ...outcome,
        invalidationDeliveryFailure: error instanceof Error ? error.message : String(error)
      };
    }
  }
  return outcome;
}
