import { createHash } from "node:crypto";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import {
  canonicalizeResourceGraphIdentity,
  canonicalizeResourceGraphOutputPath,
  uniqueValues,
  type ResourceGraphLogicalKey
} from "../../../mc-assets/src";
import { isVirtualBuiltinModelId } from "./resourceReferenceValidation";
import type { ResourceUnit, RsglCompileDiagnostic } from "./ir";
import type { RsglResourceAnalysisResult } from "./resourceNavigation";
import type {
  RsglExternalResourceUsage,
  RsglResourceReferenceUsage
} from "./validationTypes";

export const rsglResourceSnapshotVersion = 1;

export interface RsglResourceSnapshotDocumentFact {
  version?: number;
  signature?: string;
}

export interface RsglResourceSnapshotOptions {
  projectId: string;
  analysisRevision?: string;
  resolutionContextId?: string;
  sourceUri?: (fileName: string) => string;
  documentFact?: (fileName: string) => RsglResourceSnapshotDocumentFact | undefined;
}

export interface RsglResourceSnapshotLocation {
  uri: string;
  range?: { start: number; end: number };
  documentVersion?: number;
  documentSignature?: string;
}

export interface RsglResourceSnapshotProducer {
  producerId: string;
  kind: string;
  logicalKeys: readonly ResourceGraphLogicalKey[];
  aliasKeys: readonly ResourceGraphLogicalKey[];
  aggregateMemberships: readonly ResourceGraphLogicalKey[];
  outputPath: string;
  sourceOrigins: readonly RsglResourceSnapshotLocation[];
  revision: string;
}

export interface RsglResourceSnapshotResolvedTarget {
  status: "generated" | "physical" | "missing" | "unchecked";
  source?: "local" | "custom" | "vanilla";
  uri?: string;
  candidateUris?: readonly string[];
  metadataUris?: readonly string[];
  reason?: string;
}

export type RsglResourceRelationship =
  | "modelInheritance"
  | "blockstateModel"
  | "itemModel"
  | "texture"
  | "textureDirectory"
  | "sound"
  | "font"
  | "fontFile"
  | "shader"
  | "resourceReference";

export interface RsglResourceSnapshotEdge {
  edgeId: string;
  sourceProducerId: string;
  target: ResourceGraphLogicalKey;
  resolutionScope: "effective" | "local" | "custom" | "vanilla";
  resolutionContextId: string;
  sourceLocation: RsglResourceSnapshotLocation;
  sourceGeneratedPath?: string;
  relationship: RsglResourceRelationship;
  origin: "direct" | "inherited";
  resolvedTarget: RsglResourceSnapshotResolvedTarget;
}

export interface RsglResourceSnapshotIssue {
  code: string;
  severity: RsglCompileDiagnostic["severity"];
  message: string;
  location?: RsglResourceSnapshotLocation;
}

/** Compiler-owned, contentless projection of one shared resource analysis. */
export interface RsglResourceSnapshot {
  version: typeof rsglResourceSnapshotVersion;
  projectId: string;
  revision: string;
  resources: readonly RsglResourceSnapshotProducer[];
  edges: readonly RsglResourceSnapshotEdge[];
  skippedSourceUris: readonly string[];
  issues: readonly RsglResourceSnapshotIssue[];
}

export function createRsglResourceSnapshot(
  analysis: RsglResourceAnalysisResult,
  options: RsglResourceSnapshotOptions
): RsglResourceSnapshot {
  const projectId = requireIdentity(options.projectId, "projectId");
  const sourceUri = options.sourceUri ?? defaultSourceUri;
  const resources = analysis.compileResult.units
    .filter(unit => unit.external?.kind !== "external")
    .map(unit => snapshotProducer(unit, projectId, sourceUri, options.documentFact))
    .filter((producer): producer is RsglResourceSnapshotProducer => producer !== null)
    .sort((left, right) => compareOrdinal(left.producerId, right.producerId));
  const producersByOutput = new Map(resources.map(resource => [resource.outputPath, resource]));
  const generatedTargets = new Set(resources.flatMap(resource => [
    ...resource.logicalKeys,
    ...resource.aliasKeys,
    ...resource.aggregateMemberships
  ]).map(logicalKeyIdentity));
  const externalByOccurrence = indexExternalResources(analysis.externalResources);
  const resolutionContextId = options.resolutionContextId
    ?? `rsgl:${encodeURIComponent(projectId)}:effective`;
  const edges = analysis.resourceReferences
    .map(reference => snapshotEdge(
      reference,
      externalByOccurrence.get(referenceOccurrenceIdentity(reference)),
      producersByOutput,
      generatedTargets,
      resolutionContextId,
      sourceUri,
      options.documentFact
    ))
    .filter((edge): edge is RsglResourceSnapshotEdge => edge !== null);
  const normalizedEdges = uniqueByIdentity(edges, edge => edge.edgeId)
    .sort((left, right) => compareOrdinal(left.edgeId, right.edgeId));
  const skippedSourceUris = uniqueStrings(analysis.skippedSourceFiles.map(sourceUri));
  const issues = analysis.compileResult.diagnostics
    .map(diagnostic => snapshotIssue(diagnostic, sourceUri, options.documentFact))
    .sort(compareIssues);
  const revision = stableHash({
    projectId,
    analysisRevision: options.analysisRevision,
    resources,
    edges: normalizedEdges,
    skippedSourceUris,
    issues
  });

  return {
    version: rsglResourceSnapshotVersion,
    projectId,
    revision,
    resources,
    edges: normalizedEdges,
    skippedSourceUris,
    issues
  };
}

function snapshotProducer(
  unit: ResourceUnit,
  projectId: string,
  sourceUri: (fileName: string) => string,
  documentFact: RsglResourceSnapshotOptions["documentFact"]
): RsglResourceSnapshotProducer | null {
  const outputPath = normalizeOutputPath(unit.outputPath);
  const identity = canonicalizeResourceGraphOutputPath(outputPath)
    ?? (unit.id
      ? canonicalizeResourceGraphIdentity(
          unit.kind,
          `${unit.id.namespace}:${unit.id.path}`
        )
      : null);
  if (!identity || identity.primaryCategory !== "concrete") {
    return null;
  }
  const sourceOrigins = snapshotDefinitionOrigins(unit, sourceUri, documentFact);
  const producerId = producerIdentity(projectId, outputPath);
  return {
    producerId,
    kind: unit.kind,
    logicalKeys: [identity.primaryKey],
    aliasKeys: [...identity.aliasKeys],
    aggregateMemberships: [...identity.aggregateMemberships],
    outputPath,
    sourceOrigins,
    revision: stableHash({
      outputPath,
      kind: unit.kind,
      id: unit.id,
      content: unit.content,
      sourceOrigins
    })
  };
}

function snapshotDefinitionOrigins(
  unit: ResourceUnit,
  sourceUri: (fileName: string) => string,
  documentFact: RsglResourceSnapshotOptions["documentFact"]
): RsglResourceSnapshotLocation[] {
  const exact = unit.validation?.resourceDefinitionOrigins ?? [];
  const origins = exact.length > 0
    ? exact.map(origin => ({ fileName: origin.sourceFile, range: origin.sourceRange }))
    : unit.sourceMap.mappings
        .filter(mapping => !mapping.validationOnly)
        .map(mapping => ({ fileName: mapping.sourceFile, range: mapping.sourceRange }));
  return uniqueByIdentity(origins.map(origin => location(
    origin.fileName,
    origin.range,
    sourceUri,
    documentFact
  )), locationIdentity).sort(compareLocations);
}

function snapshotEdge(
  reference: RsglResourceReferenceUsage,
  external: RsglExternalResourceUsage | undefined,
  producersByOutput: ReadonlyMap<string, RsglResourceSnapshotProducer>,
  generatedTargets: ReadonlySet<string>,
  resolutionContextId: string,
  sourceUri: (fileName: string) => string,
  documentFact: RsglResourceSnapshotOptions["documentFact"]
): RsglResourceSnapshotEdge | null {
  const sourceProducer = producersByOutput.get(normalizeOutputPath(reference.consumerOutputPath));
  const identity = canonicalizeResourceGraphIdentity(reference.targetKind, reference.id);
  if (!sourceProducer || !identity) {
    return null;
  }
  const target = identity.primaryKey;
  const sourceLocation = location(
    reference.sourceFile,
    reference.range,
    sourceUri,
    documentFact
  );
  const resolutionScope = external?.source ?? "effective";
  const edgeWithoutId = {
    sourceProducerId: sourceProducer.producerId,
    target,
    resolutionScope,
    resolutionContextId,
    sourceLocation,
    ...(reference.sourceGeneratedPath
      ? { sourceGeneratedPath: reference.sourceGeneratedPath }
      : {}),
    relationship: relationshipFor(reference),
    origin: reference.origin,
    resolvedTarget: resolvedTarget(reference, external, target, generatedTargets, sourceUri)
  } satisfies Omit<RsglResourceSnapshotEdge, "edgeId">;
  return {
    edgeId: `rsgl-edge:${stableHash(edgeWithoutId).slice("sha256:".length)}`,
    ...edgeWithoutId
  };
}

function resolvedTarget(
  reference: RsglResourceReferenceUsage,
  external: RsglExternalResourceUsage | undefined,
  target: ResourceGraphLogicalKey,
  generatedTargets: ReadonlySet<string>,
  sourceUri: (fileName: string) => string
): RsglResourceSnapshotResolvedTarget {
  if (generatedTargets.has(logicalKeyIdentity(target))) {
    return { status: "generated" };
  }
  if (isVirtualBuiltinModelId(reference.id)) {
    return { status: "unchecked", source: "vanilla", reason: "virtualBuiltin" };
  }
  if (!external) {
    return { status: "missing", reason: "undeclaredExternal" };
  }
  if (external.skipExistenceCheck) {
    return {
      status: "unchecked",
      source: external.source,
      reason: "existenceCheckDisabled",
      ...externalResolutionUris(external, sourceUri)
    };
  }
  if (external.resolvedPath) {
    return {
      status: "physical",
      source: external.source,
      uri: sourceUri(external.resolvedPath),
      ...externalResolutionUris(external, sourceUri)
    };
  }
  return {
    status: "missing",
    source: external.source,
    reason: "notFound",
    ...externalResolutionUris(external, sourceUri)
  };
}

function externalResolutionUris(
  external: RsglExternalResourceUsage,
  sourceUri: (fileName: string) => string
): Pick<RsglResourceSnapshotResolvedTarget, "candidateUris" | "metadataUris"> {
  return {
    ...(external.candidatePaths?.length
      ? { candidateUris: uniqueStrings(external.candidatePaths.map(sourceUri)) }
      : {}),
    ...(external.metadataPaths?.length
      ? { metadataUris: uniqueStrings(external.metadataPaths.map(sourceUri)) }
      : {})
  };
}

function relationshipFor(reference: RsglResourceReferenceUsage): RsglResourceRelationship {
  if (reference.targetKind === "model") {
    if (reference.consumerKind === "model" && reference.sourceGeneratedPath === "/parent") {
      return "modelInheritance";
    }
    if (reference.consumerKind === "blockstate") {
      return "blockstateModel";
    }
    if (reference.consumerKind === "item") {
      return "itemModel";
    }
  }
  if (reference.targetKind === "texture") {
    return "texture";
  }
  if (reference.targetKind === "textureDirectory") {
    return "textureDirectory";
  }
  if (reference.targetKind === "sound") {
    return "sound";
  }
  if (reference.targetKind === "font") {
    return "font";
  }
  if (reference.targetKind === "fontFile") {
    return "fontFile";
  }
  if (reference.targetKind === "shaderVertex" || reference.targetKind === "shaderFragment") {
    return "shader";
  }
  return "resourceReference";
}

function indexExternalResources(
  usages: readonly RsglExternalResourceUsage[]
): ReadonlyMap<string, RsglExternalResourceUsage> {
  const result = new Map<string, RsglExternalResourceUsage>();
  for (const usage of usages) {
    result.set(referenceOccurrenceIdentity(usage), usage);
  }
  return result;
}

function referenceOccurrenceIdentity(
  usage: RsglResourceReferenceUsage | RsglExternalResourceUsage
): string {
  return [
    normalizeOutputPath(usage.consumerOutputPath),
    usage.targetKind,
    usage.id,
    usage.sourceFile.replaceAll("\\", "/").toLowerCase(),
    usage.range.start,
    usage.range.end,
    usage.origin
  ].join("\0");
}

function snapshotIssue(
  diagnostic: RsglCompileDiagnostic,
  sourceUri: (fileName: string) => string,
  documentFact: RsglResourceSnapshotOptions["documentFact"]
): RsglResourceSnapshotIssue {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    message: diagnostic.message,
    ...(diagnostic.fileName
      ? { location: location(diagnostic.fileName, diagnostic.range, sourceUri, documentFact) }
      : {})
  };
}

function location(
  fileName: string,
  range: { start: number; end: number } | undefined,
  sourceUri: (fileName: string) => string,
  documentFact: RsglResourceSnapshotOptions["documentFact"]
): RsglResourceSnapshotLocation {
  const uri = requireSerializedUri(sourceUri(fileName));
  const document = documentFact?.(fileName);
  return {
    uri,
    ...(range ? { range: { start: range.start, end: range.end } } : {}),
    ...(document?.version === undefined ? {} : { documentVersion: document.version }),
    ...(document?.signature ? { documentSignature: document.signature } : {})
  };
}

function defaultSourceUri(fileName: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(fileName) && !/^[a-zA-Z]:[\\/]/.test(fileName)) {
    return fileName;
  }
  if (fileName.startsWith("<")) {
    return `rsgl-source:${encodeURIComponent(fileName)}`;
  }
  return pathToFileURL(path.resolve(fileName)).toString();
}

function producerIdentity(projectId: string, outputPath: string): string {
  return `rsgl:${encodeURIComponent(projectId)}:${encodeURIComponent(outputPath)}`;
}

function normalizeOutputPath(outputPath: string): string {
  const normalized = outputPath.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized
    || normalized.startsWith("/")
    || /^[a-zA-Z]:\//.test(normalized)
    || normalized.split("/").some(segment => !segment || segment === "..")) {
    throw new Error(`Invalid RSGL resource snapshot output path '${outputPath}'.`);
  }
  return normalized;
}

function stableHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => compareOrdinal(left, right))
    .map(([key, child]) => [key, sortJson(child)]));
}

function uniqueByIdentity<T>(values: readonly T[], identity: (value: T) => string): T[] {
  return [...new Map(values.map(value => [identity(value), value])).values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return uniqueValues(values).sort(compareOrdinal);
}

function logicalKeyIdentity(key: ResourceGraphLogicalKey): string {
  return `${key.kind}\0${key.id}`;
}

function locationIdentity(value: RsglResourceSnapshotLocation): string {
  return `${value.uri}\0${value.range?.start ?? ""}\0${value.range?.end ?? ""}`;
}

function compareLocations(
  left: RsglResourceSnapshotLocation,
  right: RsglResourceSnapshotLocation
): number {
  return compareOrdinal(left.uri, right.uri)
    || (left.range?.start ?? 0) - (right.range?.start ?? 0)
    || (left.range?.end ?? 0) - (right.range?.end ?? 0);
}

function compareIssues(left: RsglResourceSnapshotIssue, right: RsglResourceSnapshotIssue): number {
  return compareOrdinal(left.location?.uri ?? "", right.location?.uri ?? "")
    || (left.location?.range?.start ?? 0) - (right.location?.range?.start ?? 0)
    || compareOrdinal(left.code, right.code)
    || compareOrdinal(left.message, right.message);
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty identity.`);
  }
  return value.trim();
}

function requireSerializedUri(value: string): string {
  if (typeof value !== "string"
    || !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)
    || value.includes("\0")) {
    throw new Error(`Resource snapshot location '${String(value)}' is not a serialized URI.`);
  }
  return value;
}
