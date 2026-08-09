import { parseJsonAst, type JsonDocumentNode } from "../jsonAst";
import { ScopedRegistry, type ScopedRegistration } from "../scopedRegistry";
import type {
  ResourceReference,
  ResourceReferenceDocument,
  ResourceReferenceDocumentKind
} from "./types";

export interface ResourceReferenceCacheDescriptor {
  readonly key: string;
  readonly fileName: string;
  readonly documentKind: ResourceReferenceDocumentKind;
  readonly version: string;
}

export interface ResourceReferenceHost {
  getJsonAst(document: ResourceReferenceDocument): JsonDocumentNode | null;
  getResourceReferenceDocumentVersion(document: ResourceReferenceDocument): string | null;
  getCachedResourceReferences(
    descriptor: ResourceReferenceCacheDescriptor
  ): ResourceReference[] | null;
  setCachedResourceReferences(
    descriptor: ResourceReferenceCacheDescriptor,
    references: ResourceReference[]
  ): void;
}

const defaultHostRegistry = new ScopedRegistry<"default", ResourceReferenceHost>();
const standaloneResourceReferenceHost: ResourceReferenceHost = {
  getJsonAst: document => parseJsonAst(document.getText()),
  getResourceReferenceDocumentVersion: () => null,
  getCachedResourceReferences: () => null,
  setCachedResourceReferences: () => undefined
};

export function registerDefaultResourceReferenceHost(
  host: ResourceReferenceHost
): ScopedRegistration {
  return defaultHostRegistry.register("default", host);
}

export function resolveResourceReferenceHost(
  host?: ResourceReferenceHost
): ResourceReferenceHost {
  // Headless/provider adapters keep the legacy pure extraction behavior. The
  // application composition root installs the workspace host for versioning,
  // caching, and coordinated invalidation.
  return host ?? defaultHostRegistry.get("default") ?? standaloneResourceReferenceHost;
}
