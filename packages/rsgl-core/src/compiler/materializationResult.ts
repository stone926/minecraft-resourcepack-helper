import { resolveRsglOutputPath } from "./write";
import { serializedFileUri, type RsglPreparedMaterialization } from "./materializationPlanning";
import {
  rsglMaterializationInvalidationVersion,
  type RsglMaterializationFailure,
  type RsglMaterializationInvalidation,
  type RsglMaterializationTransactionResult
} from "./materializationTypes";

export function createRsglMaterializationResult(
  transactionId: string,
  status: RsglMaterializationTransactionResult["status"],
  prepared: RsglPreparedMaterialization,
  changedPaths: readonly string[],
  deletedPaths: readonly string[],
  manifestCommitted: boolean,
  failure?: RsglMaterializationFailure
): RsglMaterializationTransactionResult {
  const invalidation = status === "committed" || status === "partial"
    ? createInvalidation(transactionId, status, prepared, changedPaths, deletedPaths, manifestCommitted)
    : undefined;
  return {
    transactionId,
    status,
    preview: prepared.preview,
    changedPaths: [...changedPaths],
    deletedPaths: [...deletedPaths],
    manifestCommitted,
    ...(invalidation ? { invalidation } : {}),
    ...(failure ? { failure } : {})
  };
}

function createInvalidation(
  transactionId: string,
  status: "committed" | "partial",
  prepared: RsglPreparedMaterialization,
  changedPaths: readonly string[],
  deletedPaths: readonly string[],
  manifestCommitted: boolean
): RsglMaterializationInvalidation {
  const changedFiles = changedPaths.map(outputPath =>
    resolveRsglOutputPath(prepared.preview.outputRoot, outputPath)
  );
  if (manifestCommitted) {
    changedFiles.push(prepared.preview.manifestPath);
  }
  return {
    version: rsglMaterializationInvalidationVersion,
    transactionId,
    projectId: prepared.preview.manifest.projectId,
    ownershipRevision: prepared.preview.manifest.buildRevision,
    state: status,
    changedUris: changedFiles.map(serializedFileUri).sort((left, right) => left.localeCompare(right, "en")),
    deletedUris: deletedPaths.map(outputPath => serializedFileUri(
      resolveRsglOutputPath(prepared.preview.outputRoot, outputPath)
    )).sort((left, right) => left.localeCompare(right, "en")),
    manifestUri: serializedFileUri(prepared.preview.manifestPath)
  };
}
