import {
  isRsglResourceSnapshotInvalidationNotification,
  isRsglResourceSnapshotResponse,
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceIssueDto,
  type RsglResourceSnapshotInvalidationNotification,
  type RsglResourceSnapshotRequest,
  type RsglResourceSnapshotResponse
} from "../../../packages/rsgl-shared/src/resourceSnapshotProtocol";
import { isRsglDocumentLike } from "../../../packages/rsgl-shared/src";
import type { ResourcePackProjectContextDto } from "../../../packages/resource-project/src";
import { abortSignalError } from "../../utils/abortError";
import type {
  ProviderCoverage,
  ResourceContributionProvider,
  ResourceContributionRequest,
  ResourceDocumentDescriptor,
  ResourceDocumentProjection,
  ResourceDocumentProjectionRequest,
  ResourceProviderSnapshot,
  ResourceProviderUnavailableReason
} from "../core";
import {
  RsglGeneratedMaterializationIndex,
  type RsglGeneratedMaterializationSnapshot
} from "./rsglGeneratedMaterialization";
import {
  createRsglGeneratedProviderSnapshot,
  cloneProviderCoverage,
  cloneRsglResourceIssues,
  createRsglSnapshotFacts,
  mapRsglCoverage,
  mergeRsglSnapshotFacts,
  rsglCoverageBelongsToProject,
  uniqueRsglStrings,
  type RsglGeneratedSnapshotFacts
} from "./rsglGeneratedSnapshotMapper";
import { sameResourceDocumentUri } from "./resourceDocumentUri";

export const rsglGeneratedProviderId = "rsgl";

export type { RsglGeneratedMaterializationSnapshot } from "./rsglGeneratedMaterialization";

export interface RsglGeneratedSnapshotSource {
  /** Implemented by the lazy host adapter; the provider has no LanguageClient dependency. */
  requestSnapshot(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<unknown>;
}

/** Builds the exact-version, contentless request at the main/host boundary. */
export function createRsglResourceSnapshotRequest(
  request: ResourceContributionRequest,
  projectContext: ResourcePackProjectContextDto
): RsglResourceSnapshotRequest {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectContext,
    scope: { kind: "project", projectId: request.projectId },
    ...(request.knownRevision ? { knownRevision: request.knownRevision } : {}),
    requestGeneration: request.requestGeneration
  };
}

/**
 * Produces a guarded response when the lazy subsystem cannot be queried. This
 * keeps unavailable coverage distinct from an authoritative empty snapshot.
 */
export function createRsglUnavailableSnapshotResponse(
  request: ResourceContributionRequest,
  reason: ResourceProviderUnavailableReason,
  lastKnownRevision?: string
): RsglResourceSnapshotResponse {
  return {
    protocolVersion: rsglResourceSnapshotProtocolVersion,
    projectId: request.projectId,
    requestGeneration: request.requestGeneration,
    status: "unavailable",
    coverage: {
      status: "unavailable",
      reason,
      ...(lastKnownRevision ? { lastKnownRevision } : {})
    }
  };
}

export interface RsglGeneratedProviderOptions {
  providerId?: string;
  /** Returns the canonical project-context local layer id without doing discovery. */
  localLayerIdForProject(projectId: string): string | undefined;
}

export interface RsglGeneratedProjectState {
  projectId: string;
  revision?: string;
  coverage: ProviderCoverage;
  stale: boolean;
  invalidationRevision?: string;
  materializationRevision?: string;
  materializationStatus?: "authoritative" | "missing" | "partial";
  materializationIssues?: readonly string[];
  skippedSourceUris: readonly string[];
  issues: readonly RsglResourceIssueDto[];
  protocolError?: string;
}

interface MutableProjectState {
  epoch: number;
  facts?: RsglGeneratedSnapshotFacts;
  coverage: ProviderCoverage;
  stale: boolean;
  invalidationRevision?: string;
  skippedSourceUris: readonly string[];
  issues: readonly RsglResourceIssueDto[];
  protocolError?: string;
}

/**
 * Pure main-side adapter from the contentless LSP DTO to ResourceUniverse
 * contributions. It retains last-known facts, but ResourceUniverse remains the
 * only winner/index authority.
 */
export class RsglGeneratedProvider implements ResourceContributionProvider {
  public readonly providerId: string;
  private readonly projects = new Map<string, MutableProjectState>();
  private readonly materializations = new RsglGeneratedMaterializationIndex();

  public constructor(
    private readonly source: RsglGeneratedSnapshotSource,
    private readonly options: RsglGeneratedProviderOptions
  ) {
    this.providerId = requireIdentity(options.providerId ?? rsglGeneratedProviderId, "providerId");
  }

  public async getSnapshot(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<ResourceProviderSnapshot> {
    const state = this.stateFor(request.projectId);
    const requestEpoch = state.epoch;
    let value: unknown;
    try {
      value = await this.source.requestSnapshot(request, signal);
    } catch (error) {
      if (signal.aborted) {
        throw abortSignalError(signal, "The RSGL resource snapshot request was aborted.");
      }
      return this.unavailableSnapshot(
        request,
        state,
        "lspFailed",
        errorMessage(error)
      );
    }
    if (signal.aborted) {
      throw abortSignalError(signal, "The RSGL resource snapshot request was aborted.");
    }
    if (state.epoch !== requestEpoch) {
      return this.unavailableSnapshot(request, state, "stale");
    }
    if (!isRsglResourceSnapshotResponse(value)) {
      return this.unavailableSnapshot(
        request,
        state,
        "protocolMismatch",
        "The RSGL resource snapshot response failed its runtime guard."
      );
    }
    if (value.projectId !== request.projectId
      || value.requestGeneration !== request.requestGeneration
      || !rsglCoverageBelongsToProject(value.coverage, request.projectId)) {
      return this.unavailableSnapshot(
        request,
        state,
        "protocolMismatch",
        "The RSGL resource snapshot response does not match its project or generation."
      );
    }

    if (value.status === "unavailable") {
      return this.responseUnavailableSnapshot(request, state, value);
    }
    if (value.status === "notModified") {
      return this.notModifiedSnapshot(request, state, value);
    }
    return this.updatedSnapshot(request, state, value);
  }

  public canHandleDocument(document: ResourceDocumentDescriptor): boolean {
    return isRsglDocumentLike({
      languageId: document.languageId,
      fileName: document.fileName,
      uriPath: serializedUriPath(document.uri)
    });
  }

  public getDocumentProjection(
    request: ResourceDocumentProjectionRequest
  ): ResourceDocumentProjection {
    const resources = request.producers.filter(producer => {
      const primary = producer.sourceOrigins[0];
      return primary !== undefined
        && sameResourceDocumentUri(primary.uri, request.document.uri);
    });
    const primaryIds = new Set(resources.map(producer => producer.producerId));
    const contributesTo = request.producers.filter(producer =>
      !primaryIds.has(producer.producerId)
      && producer.sourceOrigins.slice(1).some(origin =>
        sameResourceDocumentUri(origin.uri, request.document.uri)
      )
    );
    return {
      providerId: this.providerId,
      projectId: request.projectId,
      documentUri: request.document.uri,
      resources,
      contributesTo
    };
  }

  /**
   * Records an LSP invalidation without accepting pushed facts. The returned
   * project id is used by the connection to synchronously stale the Universe.
   */
  public acceptInvalidation(value: unknown): string | undefined {
    if (!isRsglResourceSnapshotInvalidationNotification(value)) {
      return undefined;
    }
    const notification: RsglResourceSnapshotInvalidationNotification = value;
    const state = this.stateFor(notification.projectId);
    if (state.invalidationRevision === notification.invalidationRevision) {
      return undefined;
    }
    state.epoch += 1;
    state.invalidationRevision = notification.invalidationRevision;
    state.stale = true;
    state.protocolError = undefined;
    state.coverage = {
      status: "unavailable",
      reason: "stale",
      ...(state.facts?.revision ? { lastKnownRevision: state.facts.revision } : {})
    };
    return notification.projectId;
  }

  public replaceMaterializations(snapshot: RsglGeneratedMaterializationSnapshot): boolean {
    return this.materializations.replace(snapshot);
  }

  /** Ownership-proven output paths for physical-provider source/materialized dedupe. */
  public getOwnedOutputPaths(projectId: string): ReadonlySet<string> {
    return this.materializations.getOwnedOutputPaths(projectId);
  }

  public getOwnershipRevision(projectId: string): string | undefined {
    return this.materializations.getRevision(projectId);
  }

  public getProjectState(projectId: string): RsglGeneratedProjectState | undefined {
    const state = this.projects.get(projectId);
    if (!state) {
      return undefined;
    }
    const materialization = this.materializations.getStatus(projectId);
    return {
      projectId,
      ...(state.facts?.revision ? { revision: state.facts.revision } : {}),
      coverage: cloneProviderCoverage(state.coverage),
      stale: state.stale,
      ...(state.invalidationRevision ? { invalidationRevision: state.invalidationRevision } : {}),
      ...(this.materializations.getRevision(projectId)
        ? { materializationRevision: this.materializations.getRevision(projectId) }
        : {}),
      ...(materialization ? {
        materializationStatus: materialization.status,
        materializationIssues: [...materialization.issues]
      } : {}),
      skippedSourceUris: [...state.skippedSourceUris],
      issues: cloneRsglResourceIssues(state.issues),
      ...(state.protocolError ? { protocolError: state.protocolError } : {})
    };
  }

  public removeProject(projectId: string): void {
    this.projects.delete(projectId);
    this.materializations.removeProject(projectId);
  }

  public dispose(): void {
    this.projects.clear();
    this.materializations.clear();
  }

  private updatedSnapshot(
    request: ResourceContributionRequest,
    state: MutableProjectState,
    response: RsglResourceSnapshotResponse
  ): ResourceProviderSnapshot {
    if (response.status !== "ok" && response.status !== "partial") {
      return this.unavailableSnapshot(request, state, "protocolMismatch");
    }
    const incoming = createRsglSnapshotFacts(response);
    const facts = response.status === "partial" && state.facts
      ? mergeRsglSnapshotFacts(state.facts, incoming)
      : incoming;
    const localLayerId = this.localLayerId(request.projectId);
    if (!localLayerId) {
      return this.unavailableSnapshot(request, state, "notProbed");
    }

    let snapshot: ResourceProviderSnapshot;
    try {
      snapshot = createRsglGeneratedProviderSnapshot({
        providerId: this.providerId,
        projectId: request.projectId,
        generation: request.requestGeneration,
        localLayerId,
        coverage: response.coverage,
        facts,
        materializations: this.materializations
      });
    } catch (error) {
      return this.unavailableSnapshot(
        request,
        state,
        "protocolMismatch",
        errorMessage(error)
      );
    }

    state.facts = facts;
    state.coverage = snapshot.coverage;
    state.stale = false;
    state.skippedSourceUris = uniqueRsglStrings([
      ...(response.skippedSourceUris ?? []),
      ...(response.coverage.status === "partial" ? response.coverage.skippedSourceUris : [])
    ]);
    state.issues = cloneRsglResourceIssues(response.issues ?? []);
    state.protocolError = undefined;
    return snapshot;
  }

  private notModifiedSnapshot(
    request: ResourceContributionRequest,
    state: MutableProjectState,
    response: RsglResourceSnapshotResponse
  ): ResourceProviderSnapshot {
    const facts = state.facts;
    if (!facts?.authoritative
      || facts.revision !== response.revision
      || request.knownRevision !== response.revision) {
      return this.unavailableSnapshot(
        request,
        state,
        "protocolMismatch",
        "RSGL returned notModified without a matching authoritative cached revision."
      );
    }
    const localLayerId = this.localLayerId(request.projectId);
    if (!localLayerId) {
      return this.unavailableSnapshot(request, state, "notProbed");
    }
    try {
      const snapshot = createRsglGeneratedProviderSnapshot({
        providerId: this.providerId,
        projectId: request.projectId,
        generation: request.requestGeneration,
        localLayerId,
        coverage: response.coverage,
        facts,
        materializations: this.materializations
      });
      state.coverage = snapshot.coverage;
      state.stale = false;
      state.protocolError = undefined;
      return snapshot;
    } catch (error) {
      return this.unavailableSnapshot(
        request,
        state,
        "protocolMismatch",
        errorMessage(error)
      );
    }
  }

  private responseUnavailableSnapshot(
    request: ResourceContributionRequest,
    state: MutableProjectState,
    response: RsglResourceSnapshotResponse
  ): ResourceProviderSnapshot {
    if (response.coverage.status !== "unavailable") {
      return this.unavailableSnapshot(request, state, "protocolMismatch");
    }
    const coverage = mapRsglCoverage(response.coverage);
    state.coverage = coverage;
    state.stale = response.coverage.reason === "stale";
    state.skippedSourceUris = [...(response.skippedSourceUris ?? [])];
    state.issues = cloneRsglResourceIssues(response.issues ?? []);
    state.protocolError = undefined;
    return {
      providerId: this.providerId,
      projectId: request.projectId,
      generation: request.requestGeneration,
      coverage,
      producers: [],
      edges: []
    };
  }

  private unavailableSnapshot(
    request: ResourceContributionRequest,
    state: MutableProjectState,
    reason: ResourceProviderUnavailableReason,
    protocolError?: string
  ): ResourceProviderSnapshot {
    const coverage: ProviderCoverage = {
      status: "unavailable",
      reason,
      ...(state.facts?.revision ? { lastKnownRevision: state.facts.revision } : {})
    };
    state.coverage = coverage;
    state.stale = reason === "stale";
    state.protocolError = protocolError;
    return {
      providerId: this.providerId,
      projectId: request.projectId,
      generation: request.requestGeneration,
      coverage,
      producers: [],
      edges: []
    };
  }

  private localLayerId(projectId: string): string | undefined {
    try {
      const value = this.options.localLayerIdForProject(projectId);
      return value === undefined ? undefined : requireIdentity(value, "localLayerId");
    } catch {
      return undefined;
    }
  }

  private stateFor(projectId: string): MutableProjectState {
    let state = this.projects.get(projectId);
    if (!state) {
      state = {
        epoch: 0,
        coverage: { status: "unavailable", reason: "notProbed" },
        stale: false,
        skippedSourceUris: [],
        issues: []
      };
      this.projects.set(projectId, state);
    }
    return state;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireIdentity(value: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty identity.`);
  }
  return value.trim();
}

function serializedUriPath(value: string): string {
  try {
    return new URL(value).pathname;
  } catch {
    return value;
  }
}
