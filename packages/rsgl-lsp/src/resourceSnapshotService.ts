import { createHash } from "node:crypto";
import * as path from "node:path";
import { normalizePathKey, uniqueValues } from "../../mc-assets/src";
import {
  createRsglResourceSnapshot,
  type RsglResourceSnapshot,
  type RsglResourceSnapshotDocumentFact
} from "../../rsgl-core/src";
import {
  isRsglResourceSnapshotRequest,
  isRsglResourceSnapshotResponse,
  rsglResourceSnapshotProtocolVersion,
  type RsglProviderCoverageDto,
  type RsglResourceCoverageScopeDto,
  type RsglResourceDto,
  type RsglResourceEdgeDto,
  type RsglResourceIssueDto,
  type RsglResourceSnapshotInvalidationNotification,
  type RsglResourceSnapshotRequest,
  type RsglResourceSnapshotResponse
} from "../../rsgl-shared/src";
import type { RsglResourceAnalysisEntry } from "./resourceAnalysisCache";
import { RsglResourceSnapshotProjectRegistry } from "./resourceSnapshotInvalidation";
import {
  fileNameFromSerializedResourceUri,
  isNativePathInsideOrEqual,
  resourceUriNativePathMappingsFromRequest,
  type RsglResourceUriNativePathMapping,
  rsglSourceUriFromFileName
} from "./resourceSnapshotUris";

type RsglProjectContext = RsglResourceSnapshotRequest["projectContext"];

export interface RsglResourceSnapshotServiceDeps {
  loadAnalysis(
    sourceRootFileName: string,
    projectContext: RsglProjectContext,
    nativePathMappings: readonly RsglResourceUriNativePathMapping[]
  ): RsglResourceAnalysisEntry;
  documentFact?: (fileName: string) => RsglResourceSnapshotDocumentFact | undefined;
}

export type RsglResourceSnapshotProtocolErrorCode = "invalidRequest" | "protocolMismatch";

export class RsglResourceSnapshotProtocolError extends Error {
  public constructor(public readonly code: RsglResourceSnapshotProtocolErrorCode) {
    super(code === "protocolMismatch"
      ? `RSGL resource snapshot protocol version ${rsglResourceSnapshotProtocolVersion} is required.`
      : "Malformed RSGL resource snapshot request.");
    this.name = "RsglResourceSnapshotProtocolError";
  }
}

/**
 * Guarded, transport-neutral snapshot request handler. Failed analysis is
 * represented as unavailable and never as an authoritative empty snapshot.
 */
export class RsglResourceSnapshotService {
  public constructor(
    private readonly deps: RsglResourceSnapshotServiceDeps,
    private readonly projects = new RsglResourceSnapshotProjectRegistry()
  ) { }

  public handle(value: unknown): RsglResourceSnapshotResponse {
    const request = requireSnapshotRequest(value);
    const nativePathMappings = resourceUriNativePathMappingsFromRequest(value);
    this.projects.register(request.projectContext, nativePathMappings);

    let selection: RsglSnapshotSourceSelection;
    try {
      selection = selectSnapshotSources(request, nativePathMappings);
    } catch {
      return this.unavailable(request, "notProbed");
    }
    if (selection.sourceRoots.length === 0) {
      return this.unavailable(request, "notProbed");
    }

    const snapshots: RsglResourceSnapshot[] = [];
    const failedSourceUris = [...selection.unavailableSourceUris];
    const unavailableResolutionScopes = new Set<"local" | "custom" | "vanilla">();
    let documentObserved = request.scope.kind !== "document";
    for (const source of selection.sourceRoots) {
      try {
        const entry = this.deps.loadAnalysis(
          source.fileName,
          request.projectContext,
          nativePathMappings
        );
        if (selection.documentFileName && entry.semanticProgram.files.some(file =>
          normalizePathKey(path.resolve(file.fileName)) === normalizePathKey(selection.documentFileName!)
        )) {
          documentObserved = true;
        }
        this.projects.recordDependencies(request.projectContext.projectId, entry.dependencies);
        for (const scope of entry.unavailableResolutionScopes) {
          unavailableResolutionScopes.add(scope);
        }
        snapshots.push(createRsglResourceSnapshot(entry.analysis, {
          projectId: request.projectContext.projectId,
          analysisRevision: entry.configurationKey,
          resolutionContextId: request.projectContext.contextRevision,
          sourceUri: fileName => rsglSourceUriFromFileName(fileName, nativePathMappings),
          documentFact: this.deps.documentFact
        }));
      } catch {
        failedSourceUris.push(source.uri);
      }
    }

    if (snapshots.length === 0 || !documentObserved) {
      return this.unavailable(request, "notProbed");
    }

    const response = createSnapshotResponse(
      request,
      snapshots,
      failedSourceUris,
      [...unavailableResolutionScopes]
    );
    if (response.revision) {
      this.projects.recordSnapshotRevision(request.projectContext.projectId, response.revision);
    }
    return requireSnapshotResponse(response);
  }

  public invalidations(
    reason: RsglResourceSnapshotInvalidationNotification["reason"],
    changedFileNames: readonly string[] = []
  ): RsglResourceSnapshotInvalidationNotification[] {
    return this.projects.invalidate(reason, changedFileNames);
  }

  private unavailable(
    request: RsglResourceSnapshotRequest,
    reason: Extract<RsglProviderCoverageDto, { status: "unavailable" }>["reason"]
  ): RsglResourceSnapshotResponse {
    return requireSnapshotResponse({
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: request.projectContext.projectId,
      requestGeneration: request.requestGeneration,
      status: "unavailable",
      coverage: {
        status: "unavailable",
        reason,
        ...(this.projects.lastKnownRevision(request.projectContext.projectId)
          ? { lastKnownRevision: this.projects.lastKnownRevision(request.projectContext.projectId) }
          : {})
      }
    });
  }
}

interface RsglSnapshotSourceSelection {
  sourceRoots: Array<{ uri: string; fileName: string }>;
  unavailableSourceUris: string[];
  documentFileName?: string;
}

function selectSnapshotSources(
  request: RsglResourceSnapshotRequest,
  nativePathMappings: readonly RsglResourceUriNativePathMapping[]
): RsglSnapshotSourceSelection {
  const available = request.projectContext.rsglSourceRootUris.flatMap(uri => {
    const fileName = fileNameFromSerializedResourceUri(uri, nativePathMappings);
    return fileName ? [{ uri, fileName: path.resolve(fileName) }] : [];
  });
  const unavailableSourceUris = request.projectContext.rsglSourceRootUris.filter(uri =>
    fileNameFromSerializedResourceUri(uri, nativePathMappings) === null
  );

  if (request.scope.kind === "project") {
    return {
      sourceRoots: uniqueSourceRoots(available),
      unavailableSourceUris
    };
  }

  const documentFileName = fileNameFromSerializedResourceUri(
    request.scope.documentUri,
    nativePathMappings
  );
  if (!documentFileName) {
    return { sourceRoots: [], unavailableSourceUris, documentFileName: undefined };
  }
  const resolvedDocument = path.resolve(documentFileName);
  const containing = available
    .filter(source => isNativePathInsideOrEqual(resolvedDocument, source.fileName))
    .sort((left, right) => right.fileName.length - left.fileName.length);
  return {
    sourceRoots: containing.length > 0 ? [containing[0]] : [],
    unavailableSourceUris,
    documentFileName: resolvedDocument
  };
}

function uniqueSourceRoots(
  sources: readonly { uri: string; fileName: string }[]
): Array<{ uri: string; fileName: string }> {
  const unique = new Map<string, { uri: string; fileName: string }>();
  for (const source of sources) {
    unique.set(normalizePathKey(source.fileName), source);
  }
  return [...unique.values()].sort((left, right) =>
    normalizePathKey(left.fileName).localeCompare(normalizePathKey(right.fileName), "en")
  );
}

function createSnapshotResponse(
  request: RsglResourceSnapshotRequest,
  snapshots: readonly RsglResourceSnapshot[],
  failedSourceUris: readonly string[],
  unavailableResolutionScopes: readonly ("local" | "custom" | "vanilla")[]
): RsglResourceSnapshotResponse {
  const documentUri = request.scope.kind === "document" ? request.scope.documentUri : null;
  const resources = uniqueBy(snapshots.flatMap(snapshot => snapshot.resources), resource => resource.producerId);
  const includedProducerIds = documentUri
    ? documentProducerIds(documentUri, resources, snapshots)
    : null;
  const scopedResources = includedProducerIds
    ? resources.filter(resource => includedProducerIds.has(resource.producerId))
    : resources;
  const scopedEdges = uniqueBy(snapshots.flatMap(snapshot => snapshot.edges), edge => edge.edgeId)
    .filter(edge => !includedProducerIds || includedProducerIds.has(edge.sourceProducerId));
  const allSkippedSourceUris = uniqueStrings([
    ...snapshots.flatMap(snapshot => snapshot.skippedSourceUris),
    ...failedSourceUris
  ]);
  const skippedSourceUris = documentUri
    ? allSkippedSourceUris.filter(uri => uri === documentUri)
    : allSkippedSourceUris;
  const issues = uniqueBy(snapshots.flatMap(snapshot => snapshot.issues), issueIdentity)
    .filter(issue => !documentUri
      || !issue.location
      || issue.location.uri === documentUri);
  const revision = stableRevision({
    projectId: request.projectContext.projectId,
    contextRevision: request.projectContext.contextRevision,
    scope: request.scope,
    resources: scopedResources,
    edges: scopedEdges,
    skippedSourceUris,
    issues
  });
  const coveredScope = projectCoverageScope(request.projectContext.projectId);
  const partial = skippedSourceUris.length > 0 || unavailableResolutionScopes.length > 0;

  if (!partial && request.knownRevision === revision) {
    return {
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: request.projectContext.projectId,
      requestGeneration: request.requestGeneration,
      revision,
      status: "notModified",
      coverage: { status: "authoritative", revision, coveredScope }
    };
  }

  const coverage: RsglProviderCoverageDto = partial
    ? partialCoverage(
        request.projectContext.projectId,
        revision,
        skippedSourceUris,
        unavailableResolutionScopes
      )
    : { status: "authoritative", revision, coveredScope };
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: request.projectContext.projectId,
    requestGeneration: request.requestGeneration,
    revision,
    status: partial ? "partial" : "ok",
    coverage,
    resources: scopedResources as RsglResourceDto[],
    edges: scopedEdges as RsglResourceEdgeDto[],
    ...(skippedSourceUris.length > 0 ? { skippedSourceUris } : {}),
    ...(issues.length > 0 ? { issues: issues as RsglResourceIssueDto[] } : {})
  };
}

function partialCoverage(
  projectId: string,
  revision: string,
  skippedSourceUris: readonly string[],
  unavailableResolutionScopes: readonly ("local" | "custom" | "vanilla")[]
): Extract<RsglProviderCoverageDto, { status: "partial" }> {
  if (skippedSourceUris.length > 0) {
    const projectScope = projectCoverageScope(projectId);
    return {
      status: "partial",
      revision,
      authoritativeScopes: [projectScope],
      unavailableScopes: [projectScope],
      skippedSourceUris
    };
  }
  const unavailable = new Set(unavailableResolutionScopes);
  const availableScopes = (["effective", "local", "custom", "vanilla"] as const)
    .filter(scope => !unavailable.has(scope as "local" | "custom" | "vanilla"));
  return {
    status: "partial",
    revision,
    authoritativeScopes: [{ projectId, resolutionScopes: availableScopes }],
    unavailableScopes: [{
      projectId,
      resolutionScopes: [...unavailable].sort((left, right) => left.localeCompare(right, "en"))
    }],
    skippedSourceUris: []
  };
}

function documentProducerIds(
  documentUri: string,
  resources: readonly RsglResourceSnapshot["resources"][number][],
  snapshots: readonly RsglResourceSnapshot[]
): Set<string> {
  const producerIds = new Set(resources
    .filter(resource => resource.sourceOrigins.some(origin => origin.uri === documentUri))
    .map(resource => resource.producerId));
  for (const edge of snapshots.flatMap(snapshot => snapshot.edges)) {
    if (edge.sourceLocation.uri === documentUri) {
      producerIds.add(edge.sourceProducerId);
    }
  }
  return producerIds;
}

function projectCoverageScope(projectId: string): RsglResourceCoverageScopeDto {
  return {
    projectId,
    resolutionScopes: ["effective", "local", "custom", "vanilla"]
  };
}

function requireSnapshotRequest(value: unknown): RsglResourceSnapshotRequest {
  if (isRsglResourceSnapshotRequest(value)) {
    return value;
  }
  const version = value && typeof value === "object" && "protocolVersion" in value
    ? (value as { protocolVersion?: unknown }).protocolVersion
    : undefined;
  throw new RsglResourceSnapshotProtocolError(
    version !== undefined && version !== rsglResourceSnapshotProtocolVersion
      ? "protocolMismatch"
      : "invalidRequest"
  );
}

function requireSnapshotResponse(value: RsglResourceSnapshotResponse): RsglResourceSnapshotResponse {
  if (!isRsglResourceSnapshotResponse(value)) {
    throw new Error("Constructed an invalid RSGL resource snapshot response.");
  }
  return value;
}

function uniqueBy<T>(values: readonly T[], identity: (value: T) => string): T[] {
  return [...new Map(values.map(value => [identity(value), value])).values()];
}

function uniqueStrings(values: readonly string[]): string[] {
  return uniqueValues(values).sort((left, right) => left.localeCompare(right, "en"));
}

function issueIdentity(issue: RsglResourceSnapshotIssue): string {
  return JSON.stringify(issue);
}

type RsglResourceSnapshotIssue = RsglResourceSnapshot["issues"][number];

function stableRevision(value: unknown): string {
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
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, child]) => [key, sortJson(child)]));
}
