import * as path from "node:path";
import {
  bytesEqual,
  createPreparedRsglMaterialization,
  createRsglMaterializationTransactionId,
  materializationOutputPaths,
  parseRsglOwnershipManifestFiles,
  prepareRsglMaterializationPayload,
  rsglOwnershipManifestDirectory,
  resolveRsglMaterializationOutputPath,
  stagedOutputPath,
  type RsglLoadedOwnershipManifests,
  type RsglPreparedMaterialization
} from "./materializationPlanning";
import { nodeSyncMaterializationHost } from "./materializationNodeHosts";
import { createRsglMaterializationResult } from "./materializationResult";
import type {
  RsglMaterializationFailure,
  RsglMaterializationPreview,
  RsglMaterializationRequest,
  RsglMaterializationTransactionResult,
  RsglSyncMaterializationHost
} from "./materializationTypes";
import { resolveRsglOutputPath } from "./write";
import { RsglCopySourceReadError, RsglOutputFileReadError } from "./writeErrors";

/** Synchronous Node adapter retained for CLI/core APIs; extension-host code uses the async transaction. */
export function previewRsglMaterializationTransactionSync(
  request: RsglMaterializationRequest,
  host: RsglSyncMaterializationHost = nodeSyncMaterializationHost
): RsglMaterializationPreview {
  return prepareTransaction(request, request.transactionId ?? createRsglMaterializationTransactionId(), host).preview;
}

export function runRsglMaterializationTransactionSync(
  request: RsglMaterializationRequest,
  host: RsglSyncMaterializationHost = nodeSyncMaterializationHost
): RsglMaterializationTransactionResult {
  const transactionId = request.transactionId ?? createRsglMaterializationTransactionId();
  const prepared = prepareTransaction(request, transactionId, host);
  if (prepared.preview.ownershipPlan.hasConflicts) {
    return createRsglMaterializationResult(transactionId, "conflict", prepared, [], [], false);
  }
  if (cancelled(request)) {
    return createRsglMaterializationResult(transactionId, "cancelled", prepared, [], [], false, {
      operation: "cancel",
      message: "Materialization was cancelled before staging."
    });
  }

  try {
    stageTransaction(prepared, host, request);
  } catch (error) {
    if (!preservesStaging(error)) {
      cleanupStaging(prepared, host);
    }
    return createRsglMaterializationResult(
      transactionId,
      cancelled(request) ? "cancelled" : "failed",
      prepared,
      [],
      [],
      false,
      { operation: cancelled(request) ? "cancel" : "stage", message: errorMessage(error) }
    );
  }

  if (cancelled(request)) {
    cleanupStaging(prepared, host);
    return createRsglMaterializationResult(transactionId, "cancelled", prepared, [], [], false, {
      operation: "cancel",
      message: "Materialization was cancelled before commit."
    });
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  const committedParentDirectories = new Set<string>();
  try {
    revalidateTransaction(request, prepared, host);
    for (const entry of prepared.preview.writePlan.entries) {
      if (entry.status === "unchanged") {
        continue;
      }
      if (cancelled(request)) {
        throw operationError("cancel", undefined, new Error("Materialization was cancelled."));
      }
      revalidateOutput(entry.outputPath, prepared, host);
      createDirectoryOnce(path.dirname(entry.absolutePath), committedParentDirectories, host);
      try {
        host.replaceFile(stagedOutputPath(prepared, entry.outputPath), entry.absolutePath);
      } catch (error) {
        if (preservesStaging(error)) {
          changed.push(entry.outputPath);
        }
        throw operationError("write", entry.outputPath, asError(error));
      }
      changed.push(entry.outputPath);
    }
    for (const entry of prepared.preview.deletes) {
      if (entry.status !== "delete") {
        continue;
      }
      if (cancelled(request)) {
        throw operationError("cancel", undefined, new Error("Materialization was cancelled."));
      }
      revalidateOutput(entry.outputPath, prepared, host);
      try {
        host.deleteFile(entry.absolutePath);
      } catch (error) {
        throw operationError("delete", entry.outputPath, asError(error));
      }
      deleted.push(entry.outputPath);
    }
    if (cancelled(request)) {
      throw operationError("cancel", undefined, new Error("Materialization was cancelled."));
    }
    revalidateManifestFingerprint(request, prepared, host);
    createDirectoryOnce(
      path.dirname(prepared.preview.manifestPath),
      committedParentDirectories,
      host
    );
    try {
      host.replaceFile(prepared.stagedManifestPath, prepared.preview.manifestPath);
    } catch (error) {
      throw operationError("manifest", undefined, asError(error));
    }
  } catch (error) {
    if (!preservesStaging(error)) {
      cleanupStaging(prepared, host);
    }
    const failure = transactionFailure(error);
    const changedState = changed.length > 0 || deleted.length > 0 || preservesStaging(error);
    return createRsglMaterializationResult(
      transactionId,
      changedState ? "partial" : (failure.operation === "cancel" ? "cancelled" : "failed"),
      prepared,
      changed,
      deleted,
      false,
      failure
    );
  }

  cleanupStaging(prepared, host);
  return createRsglMaterializationResult(transactionId, "committed", prepared, changed, deleted, true);
}

function prepareTransaction(
  request: RsglMaterializationRequest,
  transactionId: string,
  host: RsglSyncMaterializationHost
): RsglPreparedMaterialization {
  validateRequestBeforeIo(request);
  const payloads = request.files.map(file => {
    let content: Uint8Array;
    if ("copyFrom" in file) {
      try {
        const copyContent = host.readFile(file.copyFrom);
        if (copyContent === undefined) {
          throw new RsglCopySourceReadError(file.copyFrom);
        }
        content = copyContent;
      } catch (error) {
        if (error instanceof RsglCopySourceReadError) {
          throw error;
        }
        throw new RsglCopySourceReadError(file.copyFrom, { cause: error });
      }
    } else {
      content = Buffer.from(file.content, "utf8");
    }
    return prepareRsglMaterializationPayload(file, content, request.outputRoot);
  });
  const loaded = loadOwnershipManifests(request, host);
  const previousContent = new Map<string, Uint8Array>();
  for (const outputPath of materializationOutputPaths(payloads, loaded.current)) {
    const absolutePath = resolveRsglOutputPath(request.outputRoot, outputPath);
    try {
      const content = host.readFile(absolutePath);
      if (content !== undefined) {
        previousContent.set(outputPath, content);
      }
    } catch (error) {
      throw new RsglOutputFileReadError(absolutePath, { cause: error });
    }
  }
  return createPreparedRsglMaterialization(
    request,
    transactionId,
    payloads,
    loaded,
    previousContent
  );
}

function stageTransaction(
  prepared: RsglPreparedMaterialization,
  host: RsglSyncMaterializationHost,
  request: RsglMaterializationRequest
): void {
  const createdDirectories = new Set<string>();
  for (const entry of prepared.preview.writePlan.entries) {
    if (entry.status === "unchanged") {
      continue;
    }
    if (cancelled(request)) {
      throw new Error("Materialization was cancelled.");
    }
    const payload = prepared.payloadByOutputPath.get(entry.outputPath);
    if (!payload) {
      throw new Error(`Missing materialization payload for '${entry.outputPath}'.`);
    }
    const staged = stagedOutputPath(prepared, entry.outputPath);
    createDirectoryOnce(path.dirname(staged), createdDirectories, host);
    host.writeFile(staged, payload.content);
  }
  if (cancelled(request)) {
    throw new Error("Materialization was cancelled.");
  }
  createDirectoryOnce(path.dirname(prepared.stagedManifestPath), createdDirectories, host);
  host.writeFile(prepared.stagedManifestPath, prepared.manifestContent);
}

function revalidateTransaction(
  request: RsglMaterializationRequest,
  prepared: RsglPreparedMaterialization,
  host: RsglSyncMaterializationHost
): void {
  revalidateManifestFingerprint(request, prepared, host);
  for (const entry of prepared.preview.writePlan.entries) {
    revalidateOutput(entry.outputPath, prepared, host);
  }
  for (const entry of prepared.preview.deletes) {
    if (entry.status === "delete") {
      revalidateOutput(entry.outputPath, prepared, host);
    }
  }
}

function revalidateOutput(
  outputPath: string,
  prepared: RsglPreparedMaterialization,
  host: RsglSyncMaterializationHost
): void {
  const absolutePath = resolveRsglOutputPath(prepared.preview.outputRoot, outputPath);
  const expected = prepared.previousContentByPath.get(outputPath);
  let current: Uint8Array | undefined;
  try {
    current = host.readFile(absolutePath);
  } catch (error) {
    throw operationError("revalidate", outputPath, new RsglOutputFileReadError(absolutePath, { cause: error }));
  }
  if (!bytesEqual(current, expected)) {
    throw operationError(
      "revalidate",
      outputPath,
      new Error("The output changed after the materialization preview was created.")
    );
  }
}

function revalidateManifestFingerprint(
  request: RsglMaterializationRequest,
  prepared: RsglPreparedMaterialization,
  host: RsglSyncMaterializationHost
): void {
  if (loadOwnershipManifests(request, host).fingerprint !== prepared.manifestFingerprint) {
    throw operationError(
      "revalidate",
      undefined,
      new Error("Ownership manifests changed during the materialization transaction.")
    );
  }
}

function loadOwnershipManifests(
  request: RsglMaterializationRequest,
  host: RsglSyncMaterializationHost
): RsglLoadedOwnershipManifests {
  const directory = resolveRsglOutputPath(request.outputRoot, rsglOwnershipManifestDirectory);
  const raw: Array<{ fileName: string; content: Uint8Array }> = [];
  for (const name of [...host.readDirectory(directory)].sort((left, right) => left.localeCompare(right, "en"))) {
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }
    if (path.basename(name) !== name) {
      throw new Error(`Invalid ownership manifest directory entry '${name}'.`);
    }
    const fileName = path.join(directory, name);
    const content = host.readFile(fileName);
    if (content === undefined) {
      throw new Error(`Ownership manifest '${fileName}' disappeared while it was being read.`);
    }
    raw.push({ fileName, content });
  }
  return parseRsglOwnershipManifestFiles(raw, request.project);
}

function validateRequestBeforeIo(request: RsglMaterializationRequest): void {
  for (const file of request.files) {
    resolveRsglMaterializationOutputPath(request.outputRoot, file.outputPath);
  }
  resolveRsglOutputPath(request.outputRoot, rsglOwnershipManifestDirectory);
  if (!request.project.projectId.trim() || !request.project.outputPackRootIdentity.trim()) {
    throw new TypeError("Materialization project identities must be non-empty.");
  }
}

function cleanupStaging(prepared: RsglPreparedMaterialization, host: RsglSyncMaterializationHost): void {
  try {
    host.deleteDirectory(prepared.stagingRoot);
  } catch {
    // A private, hashed staging path is safe to leave for later maintenance.
  }
}

function createDirectoryOnce(
  directory: string,
  createdDirectories: Set<string>,
  host: RsglSyncMaterializationHost
): void {
  if (createdDirectories.has(directory)) {
    return;
  }
  createdDirectories.add(directory);
  host.createDirectory(directory);
}

function cancelled(request: RsglMaterializationRequest): boolean {
  return request.isCancellationRequested?.() ?? false;
}

function operationError(
  operation: RsglMaterializationFailure["operation"],
  outputPath: string | undefined,
  cause: Error
): Error & { materializationFailure: RsglMaterializationFailure } {
  return Object.assign(cause, {
    materializationFailure: {
      operation,
      message: cause.message,
      ...(outputPath ? { outputPath } : {})
    }
  });
}

function transactionFailure(error: unknown): RsglMaterializationFailure {
  if (error !== null && typeof error === "object" && "materializationFailure" in error) {
    return (error as { materializationFailure: RsglMaterializationFailure }).materializationFailure;
  }
  return { operation: "write", message: errorMessage(error) };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preservesStaging(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && "preserveRsglStaging" in error
    && error.preserveRsglStaging === true;
}
