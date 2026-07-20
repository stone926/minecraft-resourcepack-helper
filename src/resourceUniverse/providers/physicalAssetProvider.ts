import type {
  ProviderCoverage,
  ResourceContributionProvider,
  ResourceContributionRequest,
  ResourceProviderSnapshot,
  ResourceDocumentDescriptor,
  ResourceDocumentProjection,
  ResourceDocumentProjectionRequest
} from "../core";
import { canonicalizeResourceGraphOutputPath } from "../../../packages/mc-assets/src";
import {
  adaptPhysicalAssetDocuments,
  type PhysicalAssetScannedDocument
} from "./physicalAssetReferenceAdapter";
import { createPhysicalAssetSnapshot } from "./physicalAssetSnapshot";

export interface PhysicalAssetProjectScan {
  revision: string;
  documents: readonly PhysicalAssetScannedDocument[];
  coverage?: ProviderCoverage;
  ownedOutputPaths?: ReadonlySet<string>;
}

export interface PhysicalAssetProjectSource {
  scanProject(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<PhysicalAssetProjectScan>;
  setOwnedOutputLookup?(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void };
}

/** Read-only cross-provider seam; querying it must never start the RSGL runtime. */
export interface PhysicalAssetOwnedOutputLookup {
  getOwnedOutputPaths(projectId: string): ReadonlySet<string>;
  getOwnershipRevision(projectId: string): string | undefined;
}

export class PhysicalAssetContributionProvider implements ResourceContributionProvider {
  public readonly providerId = "physical";

  public constructor(private readonly source: PhysicalAssetProjectSource) {}

  public setOwnedOutputLookup(lookup: PhysicalAssetOwnedOutputLookup): { dispose(): void } {
    return this.source.setOwnedOutputLookup?.(lookup) ?? { dispose: () => undefined };
  }

  public async getSnapshot(
    request: ResourceContributionRequest,
    signal: AbortSignal
  ): Promise<ResourceProviderSnapshot> {
    const scan = await this.source.scanProject(request, signal);
    return createPhysicalAssetSnapshot({
      providerId: this.providerId,
      projectId: request.projectId,
      generation: request.requestGeneration,
      revision: scan.revision,
      documents: adaptPhysicalAssetDocuments(scan.documents),
      ownedOutputPaths: scan.ownedOutputPaths,
      coverage: scan.coverage
    });
  }

  public canHandleDocument(document: ResourceDocumentDescriptor): boolean {
    return canonicalizeResourceGraphOutputPath(document.fileName, {
      fileSystemCaseSensitive: false
    }) !== null;
  }

  public getDocumentProjection(
    request: ResourceDocumentProjectionRequest
  ): ResourceDocumentProjection {
    const resources = request.producers.filter(producer =>
      producer.physicalOrigins.some(origin => sameDocumentUri(origin.uri, request.document.uri))
    );
    return {
      providerId: this.providerId,
      projectId: request.projectId,
      documentUri: request.document.uri,
      resources,
      contributesTo: []
    };
  }
}

function sameDocumentUri(left: string, right: string): boolean {
  return normalizeDocumentUri(left) === normalizeDocumentUri(right);
}

function normalizeDocumentUri(value: string): string {
  return process.platform === "win32" && value.startsWith("file:")
    ? value.toLowerCase()
    : value;
}
