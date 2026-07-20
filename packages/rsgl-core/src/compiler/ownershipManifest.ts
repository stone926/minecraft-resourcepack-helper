import { createHash } from "node:crypto";
import type { ResourceGraphLogicalKey } from "../../../mc-assets/src";

export const rsglOwnershipManifestVersion = 2;

export interface RsglOwnershipSourceOrigin {
  sourceUri: string;
  range?: { start: number; end: number };
}

export interface RsglOwnershipManifestFileV2 {
  outputPath: string;
  producerId: string;
  kind: string;
  logicalKeys: readonly ResourceGraphLogicalKey[];
  contentHash: string;
  sourceMapPath?: string;
  sourceOrigins: readonly RsglOwnershipSourceOrigin[];
}

export interface RsglOwnershipManifestV2 {
  version: typeof rsglOwnershipManifestVersion;
  projectId: string;
  sourceRoot: string;
  outputPackRootIdentity: string;
  buildRevision: string;
  files: readonly RsglOwnershipManifestFileV2[];
}

export type RsglPlannedOwnedOutput = RsglOwnershipManifestFileV2;

export interface RsglExistingOutputFact {
  outputPath: string;
  contentHash: string;
}

export type RsglOwnedWriteAction = "create" | "update" | "unchanged" | "conflict";
export type RsglOwnedWriteConflictReason =
  | "userModifiedOwnedOutput"
  | "ownedByOtherProject"
  | "unownedExistingOutput";

export interface RsglOwnedWritePlanEntry {
  output: RsglPlannedOwnedOutput;
  action: RsglOwnedWriteAction;
  conflictReason?: RsglOwnedWriteConflictReason;
  ownerProjectIds: readonly string[];
  existingContentHash?: string;
}

export type RsglStaleOutputAction = "delete" | "alreadyAbsent" | "preserve";
export type RsglStalePreserveReason = "userModified" | "ownedByOtherProject";

export interface RsglStaleOutputPlanEntry {
  previous: RsglOwnershipManifestFileV2;
  action: RsglStaleOutputAction;
  preserveReason?: RsglStalePreserveReason;
  ownerProjectIds: readonly string[];
  existingContentHash?: string;
}

export interface RsglOwnedMaterializationPlan {
  projectId: string;
  writes: readonly RsglOwnedWritePlanEntry[];
  stale: readonly RsglStaleOutputPlanEntry[];
  hasConflicts: boolean;
}

export interface RsglOwnedMaterializationPlanOptions {
  projectId: string;
  plannedOutputs: readonly RsglPlannedOwnedOutput[];
  previousManifest?: RsglOwnershipManifestV2;
  otherManifests?: readonly RsglOwnershipManifestV2[];
  existingOutputs: readonly RsglExistingOutputFact[];
}

export function createRsglOwnershipManifestV2(
  manifest: Omit<RsglOwnershipManifestV2, "version">
): RsglOwnershipManifestV2 {
  const files = normalizeManifestFiles(manifest.files);
  return {
    version: rsglOwnershipManifestVersion,
    projectId: requireIdentity(manifest.projectId, "projectId"),
    sourceRoot: normalizePortableRelativePath(manifest.sourceRoot, "sourceRoot", true),
    outputPackRootIdentity: requireIdentity(manifest.outputPackRootIdentity, "outputPackRootIdentity"),
    buildRevision: requireIdentity(manifest.buildRevision, "buildRevision"),
    files
  };
}

export function serializeRsglOwnershipManifestV2(
  manifest: RsglOwnershipManifestV2,
  indent = 2
): string {
  return `${JSON.stringify(createRsglOwnershipManifestV2(manifest), null, indent)}\n`;
}

export function parseRsglOwnershipManifestV2(value: unknown): RsglOwnershipManifestV2 {
  const record = requireRecord(value, "manifest");
  if (record.version !== rsglOwnershipManifestVersion) {
    throw new Error(`Unsupported RSGL ownership manifest version '${String(record.version)}'.`);
  }
  if (!Array.isArray(record.files)) {
    throw new Error("Invalid RSGL ownership manifest files: expected an array.");
  }
  return createRsglOwnershipManifestV2({
    projectId: requireString(record.projectId, "projectId"),
    sourceRoot: requireString(record.sourceRoot, "sourceRoot"),
    outputPackRootIdentity: requireString(record.outputPackRootIdentity, "outputPackRootIdentity"),
    buildRevision: requireString(record.buildRevision, "buildRevision"),
    files: record.files.map((file, index) => parseManifestFile(file, index))
  });
}

export function rsglOwnershipManifestPath(projectId: string): string {
  const safeProjectId = requireIdentity(projectId, "projectId").replace(/[^a-zA-Z0-9._-]/g, "_");
  return `.rsgl/manifests/${safeProjectId}.json`;
}

export function hashRsglOwnedContent(content: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function planRsglOwnedMaterialization(
  options: RsglOwnedMaterializationPlanOptions
): RsglOwnedMaterializationPlan {
  const projectId = requireIdentity(options.projectId, "projectId");
  if (options.previousManifest && options.previousManifest.projectId !== projectId) {
    throw new Error("The previous ownership manifest belongs to a different project.");
  }
  const plannedOutputs = normalizeManifestFiles(options.plannedOutputs);
  const previousFiles = normalizeManifestFiles(options.previousManifest?.files ?? []);
  const otherManifests = (options.otherManifests ?? []).map(parseTrustedManifest);
  const existingByPath = uniqueByPath(options.existingOutputs, output => ({
    ...output,
    outputPath: normalizePortableRelativePath(output.outputPath, "outputPath")
  }), "existing output");
  const previousByPath = new Map(previousFiles.map(file => [file.outputPath, file]));
  const plannedByPath = new Map(plannedOutputs.map(file => [file.outputPath, file]));
  const otherOwnersByPath = createOtherOwnersIndex(otherManifests, projectId);

  const writes = plannedOutputs.map(output => {
    const existing = existingByPath.get(output.outputPath);
    const previous = previousByPath.get(output.outputPath);
    const otherOwners = otherOwnersByPath.get(output.outputPath) ?? [];
    if (!existing) {
      return writeEntry(output, "create", otherOwners);
    }
    if (otherOwners.length > 0) {
      return writeEntry(output, "conflict", otherOwners, existing.contentHash, "ownedByOtherProject");
    }
    if (!previous) {
      return writeEntry(output, "conflict", [], existing.contentHash, "unownedExistingOutput");
    }
    if (existing.contentHash !== previous.contentHash) {
      return writeEntry(output, "conflict", [projectId], existing.contentHash, "userModifiedOwnedOutput");
    }
    return writeEntry(
      output,
      output.contentHash === existing.contentHash ? "unchanged" : "update",
      [projectId],
      existing.contentHash
    );
  });

  const stale = previousFiles
    .filter(previous => !plannedByPath.has(previous.outputPath))
    .map(previous => {
      const existing = existingByPath.get(previous.outputPath);
      const otherOwners = otherOwnersByPath.get(previous.outputPath) ?? [];
      if (!existing) {
        return staleEntry(previous, "alreadyAbsent", otherOwners);
      }
      if (otherOwners.length > 0) {
        return staleEntry(previous, "preserve", otherOwners, existing.contentHash, "ownedByOtherProject");
      }
      if (existing.contentHash !== previous.contentHash) {
        return staleEntry(previous, "preserve", [projectId], existing.contentHash, "userModified");
      }
      return staleEntry(previous, "delete", [projectId], existing.contentHash);
    });

  return {
    projectId,
    writes,
    stale,
    hasConflicts: writes.some(entry => entry.action === "conflict")
  };
}

function normalizeManifestFiles(
  files: readonly RsglOwnershipManifestFileV2[]
): RsglOwnershipManifestFileV2[] {
  return [...uniqueByPath(files, normalizeManifestFile, "manifest file").values()]
    .sort((left, right) => left.outputPath.localeCompare(right.outputPath, "en"));
}

function normalizeManifestFile(file: RsglOwnershipManifestFileV2): RsglOwnershipManifestFileV2 {
  return {
    outputPath: normalizePortableRelativePath(file.outputPath, "outputPath"),
    producerId: requireIdentity(file.producerId, "producerId"),
    kind: requireIdentity(file.kind, "kind"),
    logicalKeys: [...new Map(file.logicalKeys.map(key => [
      `${requireIdentity(key.kind, "logical key kind")}\0${requireIdentity(key.id, "logical key id")}`,
      { kind: key.kind, id: key.id }
    ])).values()].sort((left, right) =>
      left.kind.localeCompare(right.kind, "en") || left.id.localeCompare(right.id, "en")
    ),
    contentHash: requireContentHash(file.contentHash),
    ...(file.sourceMapPath
      ? { sourceMapPath: normalizePortableRelativePath(file.sourceMapPath, "sourceMapPath") }
      : {}),
    sourceOrigins: [...file.sourceOrigins].map(origin => ({
      sourceUri: requireIdentity(origin.sourceUri, "source origin URI"),
      ...(origin.range ? { range: normalizeRange(origin.range) } : {})
    })).sort((left, right) =>
      left.sourceUri.localeCompare(right.sourceUri, "en")
      || (left.range?.start ?? 0) - (right.range?.start ?? 0)
      || (left.range?.end ?? 0) - (right.range?.end ?? 0)
    )
  };
}

function parseManifestFile(value: unknown, index: number): RsglOwnershipManifestFileV2 {
  const file = requireRecord(value, `files[${index}]`);
  if (!Array.isArray(file.logicalKeys) || !Array.isArray(file.sourceOrigins)) {
    throw new Error(`Invalid RSGL ownership manifest files[${index}]: expected logicalKeys and sourceOrigins arrays.`);
  }
  return {
    outputPath: requireString(file.outputPath, `files[${index}].outputPath`),
    producerId: requireString(file.producerId, `files[${index}].producerId`),
    kind: requireString(file.kind, `files[${index}].kind`),
    logicalKeys: file.logicalKeys.map((key, keyIndex) => {
      const record = requireRecord(key, `files[${index}].logicalKeys[${keyIndex}]`);
      return {
        kind: requireString(record.kind, `files[${index}].logicalKeys[${keyIndex}].kind`),
        id: requireString(record.id, `files[${index}].logicalKeys[${keyIndex}].id`)
      };
    }),
    contentHash: requireString(file.contentHash, `files[${index}].contentHash`),
    ...(file.sourceMapPath === undefined
      ? {}
      : { sourceMapPath: requireString(file.sourceMapPath, `files[${index}].sourceMapPath`) }),
    sourceOrigins: file.sourceOrigins.map((origin, originIndex) => {
      const record = requireRecord(origin, `files[${index}].sourceOrigins[${originIndex}]`);
      const range = record.range === undefined
        ? undefined
        : parseRange(record.range, `files[${index}].sourceOrigins[${originIndex}].range`);
      return {
        sourceUri: requireString(record.sourceUri, `files[${index}].sourceOrigins[${originIndex}].sourceUri`),
        ...(range ? { range } : {})
      };
    })
  };
}

function parseTrustedManifest(manifest: RsglOwnershipManifestV2): RsglOwnershipManifestV2 {
  return createRsglOwnershipManifestV2(manifest);
}

function createOtherOwnersIndex(
  manifests: readonly RsglOwnershipManifestV2[],
  currentProjectId: string
): Map<string, string[]> {
  const result = new Map<string, Set<string>>();
  for (const manifest of manifests) {
    if (manifest.projectId === currentProjectId) {
      continue;
    }
    for (const file of manifest.files) {
      const owners = result.get(file.outputPath) ?? new Set<string>();
      owners.add(manifest.projectId);
      result.set(file.outputPath, owners);
    }
  }
  return new Map([...result].map(([outputPath, owners]) => [
    outputPath,
    [...owners].sort((left, right) => left.localeCompare(right, "en"))
  ]));
}

function uniqueByPath<TInput, TOutput extends { outputPath: string }>(
  values: readonly TInput[],
  normalize: (value: TInput) => TOutput,
  label: string
): Map<string, TOutput> {
  const result = new Map<string, TOutput>();
  for (const value of values) {
    const normalized = normalize(value);
    if (result.has(normalized.outputPath)) {
      throw new Error(`Duplicate ${label} path '${normalized.outputPath}'.`);
    }
    result.set(normalized.outputPath, normalized);
  }
  return result;
}

function writeEntry(
  output: RsglPlannedOwnedOutput,
  action: RsglOwnedWriteAction,
  ownerProjectIds: readonly string[],
  existingContentHash?: string,
  conflictReason?: RsglOwnedWriteConflictReason
): RsglOwnedWritePlanEntry {
  return {
    output,
    action,
    ownerProjectIds,
    ...(existingContentHash ? { existingContentHash } : {}),
    ...(conflictReason ? { conflictReason } : {})
  };
}

function staleEntry(
  previous: RsglOwnershipManifestFileV2,
  action: RsglStaleOutputAction,
  ownerProjectIds: readonly string[],
  existingContentHash?: string,
  preserveReason?: RsglStalePreserveReason
): RsglStaleOutputPlanEntry {
  return {
    previous,
    action,
    ownerProjectIds,
    ...(existingContentHash ? { existingContentHash } : {}),
    ...(preserveReason ? { preserveReason } : {})
  };
}

function normalizePortableRelativePath(value: string, field: string, allowDot = false): string {
  const raw = requireIdentity(value, field).replaceAll("\\", "/");
  if (/^(?:\/|[a-zA-Z]:\/)/.test(raw)) {
    throw new Error(`${field} must be a portable relative path.`);
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new Error(`${field} must not escape its owning root.`);
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    if (allowDot && raw === ".") {
      return ".";
    }
    throw new Error(`${field} must not be empty.`);
  }
  return segments.join("/");
}

function requireContentHash(value: string): string {
  const hash = requireIdentity(value, "contentHash");
  if (!/^sha256:[0-9a-f]{64}$/.test(hash)) {
    throw new Error("contentHash must be a lowercase SHA-256 identity.");
  }
  return hash;
}

function requireIdentity(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${field} must be a non-empty identity string.`);
  }
  return value.trim();
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Invalid RSGL ownership manifest ${field}: expected a string.`);
  }
  return value;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid RSGL ownership manifest ${field}: expected an object.`);
  }
  return value as Record<string, unknown>;
}

function normalizeRange(range: { start: number; end: number }): { start: number; end: number } {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start) {
    throw new Error("Source origin range must contain ordered non-negative offsets.");
  }
  return { start: range.start, end: range.end };
}

function parseRange(value: unknown, field: string): { start: number; end: number } {
  const range = requireRecord(value, field);
  if (typeof range.start !== "number" || typeof range.end !== "number") {
    throw new Error(`Invalid RSGL ownership manifest ${field}: expected numeric start/end.`);
  }
  return normalizeRange({ start: range.start, end: range.end });
}
