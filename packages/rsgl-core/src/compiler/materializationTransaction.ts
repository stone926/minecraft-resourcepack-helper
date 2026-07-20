import * as path from "node:path";
import {
  createPreparedRsglMaterialization,
  createRsglMaterializationTransactionId,
  materializationOutputPaths,
  parseRsglOwnershipManifestFiles,
  prepareRsglMaterializationPayload,
  rsglOwnershipManifestDirectory,
  resolveRsglMaterializationOutputPath,
  stagedOutputPath,
  bytesEqual,
  type RsglLoadedOwnershipManifests,
  type RsglPreparedMaterialization
} from "./materializationPlanning";
import {
  type RsglAsyncMaterializationHost,
  type RsglMaterializationFailure,
  type RsglMaterializationPreview,
  type RsglMaterializationRequest,
  type RsglMaterializationTransactionResult
} from "./materializationTypes";
import { createRsglMaterializationResult } from "./materializationResult";
import { resolveRsglOutputPath } from "./write";
import { RsglCopySourceReadError, RsglOutputFileReadError } from "./writeErrors";

/** Reads and classifies every targeted output without mutating the output pack. */
export async function previewRsglMaterializationTransaction(
  request: RsglMaterializationRequest,
  host: RsglAsyncMaterializationHost
): Promise<RsglMaterializationPreview> {
  return (await prepareTransaction(request, request.transactionId ?? createRsglMaterializationTransactionId(), host)).preview;
}

/**
 * Stages and commits one project-scoped transaction. Conflicts never mutate the
 * pack. The ownership manifest is the final committed file.
 */
export async function runRsglMaterializationTransaction(
  request: RsglMaterializationRequest,
  host: RsglAsyncMaterializationHost
): Promise<RsglMaterializationTransactionResult> {
  const transactionId = request.transactionId ?? createRsglMaterializationTransactionId();
  const prepared = await prepareTransaction(request, transactionId, host);
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
    await stageTransaction(prepared, host, request);
  } catch (error) {
    if (!preservesStaging(error)) {
      await cleanupStaging(prepared, host);
    }
    return createRsglMaterializationResult(transactionId, cancelled(request) ? "cancelled" : "failed", prepared, [], [], false, {
      operation: cancelled(request) ? "cancel" : "stage",
      message: errorMessage(error)
    });
  }

  if (cancelled(request)) {
    await cleanupStaging(prepared, host);
    return createRsglMaterializationResult(transactionId, "cancelled", prepared, [], [], false, {
      operation: "cancel",
      message: "Materialization was cancelled before commit."
    });
  }

  const changed: string[] = [];
  const deleted: string[] = [];
  try {
    await revalidateTransaction(request, prepared, host);
    for (const entry of prepared.preview.writePlan.entries) {
      if (entry.status === "unchanged") {
        continue;
      }
      if (cancelled(request)) {
        throw cancellationFailure();
      }
      await revalidateOutput(entry.outputPath, prepared, host);
      await host.createDirectory(path.dirname(entry.absolutePath));
      try {
        await host.replaceFile(stagedOutputPath(prepared, entry.outputPath), entry.absolutePath);
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
        throw cancellationFailure();
      }
      await revalidateOutput(entry.outputPath, prepared, host);
      try {
        await host.deleteFile(entry.absolutePath);
      } catch (error) {
        throw operationError("delete", entry.outputPath, asError(error));
      }
      deleted.push(entry.outputPath);
    }
    if (cancelled(request)) {
      throw cancellationFailure();
    }
    await revalidateManifestFingerprint(request, prepared, host);
    await host.createDirectory(path.dirname(prepared.preview.manifestPath));
    try {
      await host.replaceFile(prepared.stagedManifestPath, prepared.preview.manifestPath);
    } catch (error) {
      throw operationError("manifest", undefined, asError(error));
    }
  } catch (error) {
    if (!preservesStaging(error)) {
      await cleanupStaging(prepared, host);
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

  await cleanupStaging(prepared, host);
  return createRsglMaterializationResult(transactionId, "committed", prepared, changed, deleted, true);
}

async function prepareTransaction(
  request: RsglMaterializationRequest,
  transactionId: string,
  host: RsglAsyncMaterializationHost
): Promise<RsglPreparedMaterialization> {
  validateRequestBeforeIo(request);
  const payloads = [];
  for (const file of request.files) {
    let content: Uint8Array;
    if ("copyFrom" in file) {
      try {
        const copyContent = await host.readFile(file.copyFrom);
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
    payloads.push(prepareRsglMaterializationPayload(file, content, request.outputRoot));
  }
  const loaded = await loadOwnershipManifests(request, host);
  const previousContent = new Map<string, Uint8Array>();
  for (const outputPath of materializationOutputPaths(payloads, loaded.current)) {
    const absolutePath = resolveRsglOutputPath(request.outputRoot, outputPath);
    try {
      const content = await host.readFile(absolutePath);
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

async function stageTransaction(
  prepared: RsglPreparedMaterialization,
  host: RsglAsyncMaterializationHost,
  request: RsglMaterializationRequest
): Promise<void> {
  for (const entry of prepared.preview.writePlan.entries) {
    if (entry.status === "unchanged") {
      continue;
    }
    if (cancelled(request)) {
      throw cancellationFailure();
    }
    const payload = prepared.payloads.find(candidate => candidate.file.outputPath === entry.outputPath);
    if (!payload) {
      throw new Error(`Missing materialization payload for '${entry.outputPath}'.`);
    }
    const staged = stagedOutputPath(prepared, entry.outputPath);
    await host.createDirectory(path.dirname(staged));
    await host.writeFile(staged, payload.content);
  }
  if (cancelled(request)) {
    throw cancellationFailure();
  }
  await host.createDirectory(path.dirname(prepared.stagedManifestPath));
  await host.writeFile(prepared.stagedManifestPath, prepared.manifestContent);
}

async function revalidateTransaction(
  request: RsglMaterializationRequest,
  prepared: RsglPreparedMaterialization,
  host: RsglAsyncMaterializationHost
): Promise<void> {
  await revalidateManifestFingerprint(request, prepared, host);
  for (const entry of prepared.preview.writePlan.entries) {
    await revalidateOutput(entry.outputPath, prepared, host);
  }
  for (const entry of prepared.preview.deletes) {
    if (entry.status === "delete") {
      await revalidateOutput(entry.outputPath, prepared, host);
    }
  }
}

async function revalidateOutput(
  outputPath: string,
  prepared: RsglPreparedMaterialization,
  host: RsglAsyncMaterializationHost
): Promise<void> {
  const absolutePath = resolveRsglOutputPath(prepared.preview.outputRoot, outputPath);
  const expected = prepared.previousContentByPath.get(outputPath);
  let current: Uint8Array | undefined;
  try {
    current = await host.readFile(absolutePath);
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

async function revalidateManifestFingerprint(
  request: RsglMaterializationRequest,
  prepared: RsglPreparedMaterialization,
  host: RsglAsyncMaterializationHost
): Promise<void> {
  const loaded = await loadOwnershipManifests(request, host);
  if (loaded.fingerprint !== prepared.manifestFingerprint) {
    throw operationError(
      "revalidate",
      undefined,
      new Error("Ownership manifests changed during the materialization transaction.")
    );
  }
}

async function loadOwnershipManifests(
  request: RsglMaterializationRequest,
  host: RsglAsyncMaterializationHost
): Promise<RsglLoadedOwnershipManifests> {
  const directory = resolveRsglOutputPath(request.outputRoot, rsglOwnershipManifestDirectory);
  const names = await host.readDirectory(directory);
  const raw: Array<{ fileName: string; content: Uint8Array }> = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right, "en"))) {
    if (!name.toLowerCase().endsWith(".json")) {
      continue;
    }
    if (path.basename(name) !== name) {
      throw new Error(`Invalid ownership manifest directory entry '${name}'.`);
    }
    const fileName = path.join(directory, name);
    const content = await host.readFile(fileName);
    if (content === undefined) {
      throw new Error(`Ownership manifest '${fileName}' disappeared while it was being read.`);
    }
    raw.push({ fileName, content });
  }
  return parseRsglOwnershipManifestFiles(raw, request.project);
}

function validateRequestBeforeIo(request: RsglMaterializationRequest): void {
  // Resolve every target before reading copy payloads so unsafe paths cannot
  // trigger any filesystem access.
  for (const file of request.files) {
    resolveRsglMaterializationOutputPath(request.outputRoot, file.outputPath);
  }
  resolveRsglOutputPath(request.outputRoot, rsglOwnershipManifestDirectory);
  // The manifest constructor performs all project identity/path validation.
  // A real revision/files list is supplied after payload hashing.
  if (!request.project.projectId.trim() || !request.project.outputPackRootIdentity.trim()) {
    throw new TypeError("Materialization project identities must be non-empty.");
  }
}

async function cleanupStaging(
  prepared: RsglPreparedMaterialization,
  host: RsglAsyncMaterializationHost
): Promise<void> {
  try {
    await host.deleteDirectory(prepared.stagingRoot);
  } catch {
    // A private, hashed staging path is safe to leave for later maintenance.
  }
}

function cancelled(request: RsglMaterializationRequest): boolean {
  return request.isCancellationRequested?.() ?? false;
}

function cancellationFailure(): Error & { materializationFailure: RsglMaterializationFailure } {
  return operationError("cancel", undefined, new Error("Materialization was cancelled."));
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function preservesStaging(error: unknown): boolean {
  return error !== null && typeof error === "object"
    && "preserveRsglStaging" in error
    && error.preserveRsglStaging === true;
}
