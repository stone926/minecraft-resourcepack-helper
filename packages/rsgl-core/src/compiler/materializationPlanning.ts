import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { uniqueValues } from "../../../mc-assets/src";
import {
  createLocalResourceLayerDescriptor,
  createResourceProjectId
} from "../../../resource-project/src";
import { resolvedRsglPathKey } from "../pathIdentity";
import type { RsglEmittedFile, RsglEmittedSourceOrigin } from "./emit";
import {
  createRsglOwnershipManifestV2,
  hashRsglOwnedContent,
  parseRsglOwnershipManifestV2,
  planRsglOwnedMaterialization,
  rsglOwnershipManifestPath,
  serializeRsglOwnershipManifestV2,
  type RsglExistingOutputFact,
  type RsglOwnershipManifestFileV2,
  type RsglOwnershipManifestV2
} from "./ownershipManifest";
import type {
  RsglMaterializationDeletePreview,
  RsglMaterializationPreview,
  RsglMaterializationProject,
  RsglMaterializationRequest
} from "./materializationTypes";
import { createRsglLineDiff, resolveRsglOutputPath, type RsglWritePlanEntry } from "./write";
import { RsglUnsafeOutputPathError } from "./writeErrors";

export const rsglOwnershipManifestDirectory = ".rsgl/manifests";
export const rsglMaterializationStagingDirectory = ".rsgl/staging";

export interface RsglPreparedMaterializationPayload {
  file: RsglEmittedFile;
  content: Uint8Array;
  contentHash: string;
  absolutePath: string;
}

export interface RsglLoadedOwnershipManifests {
  manifests: readonly RsglOwnershipManifestV2[];
  current?: RsglOwnershipManifestV2;
  /** Stable hash of every raw project manifest used for commit revalidation. */
  fingerprint: string;
}

export interface RsglPreparedMaterialization {
  preview: RsglMaterializationPreview;
  payloads: readonly RsglPreparedMaterializationPayload[];
  payloadByOutputPath: ReadonlyMap<string, RsglPreparedMaterializationPayload>;
  previousContentByPath: ReadonlyMap<string, Uint8Array>;
  manifestContent: Uint8Array;
  manifestFingerprint: string;
  stagingRoot: string;
  stagedManifestPath: string;
}

export function createRsglMaterializationProject(
  sourceRootPath: string,
  outputRoot: string,
  projectRootPath = outputRoot
): RsglMaterializationProject {
  const sourceRoot = path.resolve(sourceRootPath);
  const outputPackRoot = path.resolve(outputRoot);
  const projectRoot = path.resolve(projectRootPath);
  const sourceRootUri = pathToFileURL(sourceRoot).toString();
  const outputPackRootUri = pathToFileURL(outputPackRoot).toString();
  const projectRootUri = pathToFileURL(projectRoot).toString();
  return {
    projectId: createResourceProjectId({
      projectRootUri,
      outputPackRootUri,
      rsglSourceRootUris: [sourceRootUri]
    }),
    sourceRoot: portableProjectSourceRoot(projectRoot, sourceRoot),
    outputPackRootIdentity: createLocalResourceLayerDescriptor(outputPackRootUri).layerId
  };
}

export function createRsglMaterializationTransactionId(): string {
  return `transaction-${randomUUID()}`;
}

export function rsglMaterializationStagingRoot(outputRoot: string, transactionId: string): string {
  const safeId = digestIdentity(transactionId).slice(7, 39);
  return resolveRsglOutputPath(outputRoot, `${rsglMaterializationStagingDirectory}/${safeId}`);
}

export function prepareRsglMaterializationPayload(
  file: RsglEmittedFile,
  content: Uint8Array,
  outputRoot: string
): RsglPreparedMaterializationPayload {
  const normalizedFile = {
    ...file,
    outputPath: file.outputPath.replaceAll("\\", "/")
  } as RsglEmittedFile;
  return {
    file: normalizedFile,
    content,
    contentHash: hashRsglOwnedContent(content),
    absolutePath: resolveRsglMaterializationOutputPath(outputRoot, normalizedFile.outputPath)
  };
}

export function resolveRsglMaterializationOutputPath(outputRoot: string, outputPath: string): string {
  const normalized = outputPath.replaceAll("\\", "/");
  const firstSegment = normalized.split("/").find(segment => segment && segment !== ".");
  if (firstSegment?.toLowerCase() === ".rsgl") {
    throw new RsglUnsafeOutputPathError(outputPath);
  }
  return resolveRsglOutputPath(outputRoot, outputPath);
}

export function parseRsglOwnershipManifestFiles(
  rawManifests: readonly { fileName: string; content: Uint8Array }[],
  project: RsglMaterializationProject
): RsglLoadedOwnershipManifests {
  const manifests: RsglOwnershipManifestV2[] = [];
  const projectIds = new Set<string>();
  for (const raw of [...rawManifests].sort((left, right) =>
    left.fileName.localeCompare(right.fileName, "en")
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(raw.content));
    } catch (error) {
      throw new Error(
        `Failed to parse RSGL ownership manifest '${raw.fileName}': ${errorMessage(error)}`,
        { cause: error }
      );
    }
    let manifest: RsglOwnershipManifestV2;
    try {
      manifest = parseRsglOwnershipManifestV2(parsed);
    } catch (error) {
      throw new Error(
        `Invalid RSGL ownership manifest '${raw.fileName}': ${errorMessage(error)}`,
        { cause: error }
      );
    }
    if (manifest.outputPackRootIdentity !== project.outputPackRootIdentity) {
      throw new Error(`Ownership manifest '${raw.fileName}' belongs to another output pack root.`);
    }
    if (projectIds.has(manifest.projectId)) {
      throw new Error(`Duplicate ownership manifests for project '${manifest.projectId}'.`);
    }
    projectIds.add(manifest.projectId);
    manifests.push(manifest);
  }
  return {
    manifests,
    current: manifests.find(manifest => manifest.projectId === project.projectId),
    fingerprint: ownershipManifestFingerprint(rawManifests)
  };
}

export function createPreparedRsglMaterialization(
  request: RsglMaterializationRequest,
  transactionId: string,
  payloads: readonly RsglPreparedMaterializationPayload[],
  loaded: RsglLoadedOwnershipManifests,
  previousContentByPath: ReadonlyMap<string, Uint8Array>
): RsglPreparedMaterialization {
  const outputRoot = path.resolve(request.outputRoot);
  assertUniqueResolvedOutputPaths(outputRoot, payloads, loaded.manifests);
  const payloadByOutputPath = new Map(
    payloads.map(payload => [payload.file.outputPath, payload] as const)
  );
  const manifest = createRsglOwnershipManifestV2({
    ...request.project,
    buildRevision: materializationRevision(payloads),
    files: payloads.map(payload => manifestFile(
      request.project.projectId,
      payload,
      request.sourceRootPath
    ))
  });
  const existingOutputs: RsglExistingOutputFact[] = [...previousContentByPath].map(
    ([outputPath, content]) => ({ outputPath, contentHash: hashRsglOwnedContent(content) })
  );
  const ownershipPlan = planRsglOwnedMaterialization({
    projectId: request.project.projectId,
    plannedOutputs: manifest.files,
    previousManifest: loaded.current,
    otherManifests: loaded.manifests.filter(candidate => candidate.projectId !== request.project.projectId),
    existingOutputs,
    adoptUnownedIdentical: request.adoptUnownedIdentical
  });
  const manifestPath = resolveRsglOutputPath(outputRoot, rsglOwnershipManifestPath(request.project.projectId));
  const writeEntries = ownershipPlan.writes.flatMap(entry => {
    if (entry.action === "conflict") {
      return [];
    }
    const payload = payloadByOutputPath.get(entry.output.outputPath);
    if (!payload) {
      throw new Error(`Missing materialization payload for '${entry.output.outputPath}'.`);
    }
    const previous = previousContentByPath.get(entry.output.outputPath);
    return [writePlanEntry(payload, entry.action, previous)];
  });
  const writePlan = {
    outputRoot,
    entries: writeEntries,
    summary: writeEntries.reduce((summary, entry) => {
      summary[entry.status]++;
      return summary;
    }, { create: 0, update: 0, unchanged: 0 })
  };
  const deletes: RsglMaterializationDeletePreview[] = ownershipPlan.stale.map(entry => ({
    outputPath: entry.previous.outputPath,
    absolutePath: resolveRsglOutputPath(outputRoot, entry.previous.outputPath),
    status: entry.action,
    ...(entry.preserveReason ? { preserveReason: entry.preserveReason } : {})
  }));
  const stagingRoot = rsglMaterializationStagingRoot(outputRoot, transactionId);
  return {
    preview: {
      outputRoot,
      manifestPath,
      manifest,
      ownershipPlan,
      writePlan,
      deletes
    },
    payloads,
    payloadByOutputPath,
    previousContentByPath,
    manifestContent: encodeText(serializeRsglOwnershipManifestV2(manifest)),
    manifestFingerprint: loaded.fingerprint,
    stagingRoot,
    stagedManifestPath: path.join(stagingRoot, "manifest.json")
  };
}

export function materializationOutputPaths(
  payloads: readonly RsglPreparedMaterializationPayload[],
  current: RsglOwnershipManifestV2 | undefined
): string[] {
  return uniqueValues([
    ...payloads.map(payload => payload.file.outputPath),
    ...(current?.files.map(file => file.outputPath) ?? [])
  ]).sort((left, right) => left.localeCompare(right, "en"));
}

export function ownershipManifestFingerprint(
  rawManifests: readonly { fileName: string; content: Uint8Array }[]
): string {
  return digestIdentity([...rawManifests]
    .sort((left, right) => left.fileName.localeCompare(right.fileName, "en"))
    .map(raw => `${path.basename(raw.fileName)}\0${hashRsglOwnedContent(raw.content)}`)
    .join("\n"));
}

export function stagedOutputPath(
  prepared: RsglPreparedMaterialization,
  outputPath: string
): string {
  const normalized = outputPath.replaceAll("\\", "/");
  return path.join(prepared.stagingRoot, "files", ...normalized.split("/"));
}

export function serializedFileUri(fileName: string): string {
  return pathToFileURL(path.resolve(fileName)).toString();
}

export function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

export function encodeText(value: string): Uint8Array {
  return Buffer.from(value, "utf8");
}

export function decodeText(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function manifestFile(
  projectId: string,
  payload: RsglPreparedMaterializationPayload,
  sourceRootPath: string | undefined
): RsglOwnershipManifestFileV2 {
  const hint = payload.file.ownership;
  return {
    outputPath: payload.file.outputPath,
    producerId: `rsgl:${encodeURIComponent(projectId)}:${encodeURIComponent(payload.file.outputPath)}`,
    kind: hint?.kind ?? payload.file.kind,
    logicalKeys: hint?.logicalKeys ?? [],
    contentHash: payload.contentHash,
    ...(hint?.sourceMapPath ? { sourceMapPath: hint.sourceMapPath } : {}),
    sourceOrigins: (hint?.sourceOrigins ?? []).map(origin =>
      portableManifestSourceOrigin(origin, sourceRootPath)
    )
  };
}

function portableManifestSourceOrigin(
  origin: RsglEmittedSourceOrigin,
  sourceRootPath: string | undefined
): RsglOwnershipManifestFileV2["sourceOrigins"][number] {
  return {
    sourcePath: portableManifestSourcePath(origin.sourceUri, sourceRootPath),
    ...(origin.range ? { range: origin.range } : {})
  };
}

function portableManifestSourcePath(sourceUri: string, sourceRootPath: string | undefined): string {
  if (sourceRootPath) {
    try {
      const sourceUrl = new URL(sourceUri);
      if (sourceUrl.protocol === "file:") {
        const relative = path.relative(path.resolve(sourceRootPath), path.resolve(fileURLToPath(sourceUrl)))
          .replaceAll("\\", "/");
        if (relative && !path.isAbsolute(relative) && !/^[a-zA-Z]:/.test(relative)) {
          return relative;
        }
      }
    } catch {
      // Non-file or malformed compile identities become opaque portable IDs.
    }
  }
  return `@external/${digestIdentity(sourceUri).slice("sha256:".length)}`;
}

function portableProjectSourceRoot(projectRoot: string, sourceRoot: string): string {
  const relative = path.relative(projectRoot, sourceRoot).replaceAll("\\", "/");
  return !relative || relative === "." || relative === ".." || relative.startsWith("../")
    ? "."
    : relative;
}

function materializationRevision(payloads: readonly RsglPreparedMaterializationPayload[]): string {
  return digestIdentity([...payloads]
    .sort((left, right) => left.file.outputPath.localeCompare(right.file.outputPath, "en"))
    .map(payload => `${payload.file.outputPath}\0${payload.contentHash}`)
    .join("\n"));
}

function digestIdentity(value: string): string {
  return hashRsglOwnedContent(value);
}

function writePlanEntry(
  payload: RsglPreparedMaterializationPayload,
  status: "create" | "update" | "unchanged" | "adopt",
  previous: Uint8Array | undefined
): RsglWritePlanEntry {
  const writeStatus = status === "adopt" ? "unchanged" : status;
  if ("copyFrom" in payload.file) {
    return {
      ...payload.file,
      absolutePath: payload.absolutePath,
      status: writeStatus
    };
  }
  const previousContent = previous === undefined ? undefined : decodeText(previous);
  return {
    ...payload.file,
    absolutePath: payload.absolutePath,
    status: writeStatus,
    previousContent,
    diff: previousContent !== undefined && previousContent !== payload.file.content
      ? createRsglLineDiff(previousContent, payload.file.content)
      : undefined
  };
}

function assertUniqueResolvedOutputPaths(
  outputRoot: string,
  payloads: readonly RsglPreparedMaterializationPayload[],
  manifests: readonly RsglOwnershipManifestV2[]
): void {
  const planned = new Map<string, string>();
  for (const payload of payloads) {
    const key = resolvedRsglPathKey(payload.absolutePath);
    const previous = planned.get(key);
    if (previous) {
      throw new Error(`Case-colliding materialization outputs '${previous}' and '${payload.file.outputPath}'.`);
    }
    planned.set(key, payload.file.outputPath);
  }
  for (const manifest of manifests) {
    for (const file of manifest.files) {
      const key = resolvedRsglPathKey(resolveRsglOutputPath(outputRoot, file.outputPath));
      const plannedPath = planned.get(key);
      if (plannedPath && plannedPath !== file.outputPath) {
        throw new Error(`Case-colliding ownership paths '${plannedPath}' and '${file.outputPath}'.`);
      }
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
