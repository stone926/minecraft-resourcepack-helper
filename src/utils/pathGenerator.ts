import type { Uri } from "vscode";
import type { ResourceFileRequest } from "../../packages/mc-assets/src";
import type { ResourceConfiguration } from "./resourceConfigurationTypes";
import type { ResourceReference } from "./resourceReferences";
import { ScopedRegistry, type ScopedRegistration } from "./scopedRegistry";

interface ResourcePathDocument {
  fileName: string;
}

export type ResourceReferencePathResolver = (
  reference: ResourceReference,
  document: ResourcePathDocument
) => Uri | null;

export interface ResourcePathResolutionHost {
  resolveResourcePath(request: ResourceFileRequest): string | null;
  getPathExists(fileName: string): boolean;
  getPackRoot(fileName: string): string | null;
  getResourceConfiguration(): ResourceConfiguration;
  createFileUri(fileName: string): Uri;
}

export interface ResourceReferencePathResolutionContext {
  readonly reference: ResourceReference;
  readonly document: ResourcePathDocument;
  readonly host: ResourcePathResolutionHost;
  resolveTypedResource(): string | null;
}

export type RegisteredResourceReferencePathResolver = (
  context: ResourceReferencePathResolutionContext
) => string | null;

interface ResourcePathResolverOptions {
  host?: ResourcePathResolutionHost;
}

const defaultHostRegistry = new ScopedRegistry<"default", ResourcePathResolutionHost>();
const modeResolverRegistry = new ScopedRegistry<string, RegisteredResourceReferencePathResolver>();

export function registerDefaultResourcePathResolutionHost(
  host: ResourcePathResolutionHost
): ScopedRegistration {
  return defaultHostRegistry.register("default", host);
}

export function registerResourceReferencePathResolver(
  resolveMode: string,
  resolver: RegisteredResourceReferencePathResolver
): ScopedRegistration {
  return modeResolverRegistry.register(resolveMode, resolver);
}

/**
 * Creates a resolver whose default host is looked up when it runs. This keeps
 * module-level consumers safe while the application composition root installs
 * and disposes the workspace adapter.
 */
export function createResourceReferencePathResolver(
  host?: ResourcePathResolutionHost
): ResourceReferencePathResolver {
  return (reference, document) => generateReferenceRedirectPath(reference, document, { host });
}

export function generateReferenceRedirectPath(
  reference: ResourceReference,
  document: ResourcePathDocument,
  options: ResourcePathResolverOptions = {}
): Uri | null {
  const host = getResolutionHost(options);
  if (reference.resolveMode) {
    const resolver = modeResolverRegistry.get(reference.resolveMode);
    if (!resolver) {
      return null;
    }
    const resolvedPath = resolver({
      reference,
      document,
      host,
      resolveTypedResource: () => resolveRedirectFilePath(
        reference.value,
        document,
        reference.target,
        reference.source,
        reference.extension,
        host
      )
    });
    return resolvedPath ? host.createFileUri(resolvedPath) : null;
  }

  const resolvedPath = resolveRedirectFilePath(
    reference.value,
    document,
    reference.target,
    reference.source,
    reference.extension,
    host
  );
  return resolvedPath ? host.createFileUri(resolvedPath) : null;
}

function resolveRedirectFilePath(
  resourcePath: string,
  document: ResourcePathDocument,
  target: string,
  source: string,
  targetFileExtension: string | null,
  host: ResourcePathResolutionHost
): string | null {
  const configuration = host.getResourceConfiguration();
  return host.resolveResourcePath({
    resourcePath,
    sourceFileName: document.fileName,
    source,
    target,
    targetFileExtension,
    defaultAssetsPath: configuration.defaultAssetsPath,
    resourcePackRoots: configuration.resourcePackRoots ?? []
  });
}

function getResolutionHost(options: ResourcePathResolverOptions): ResourcePathResolutionHost {
  const host = options.host ?? defaultHostRegistry.get("default");
  if (!host) {
    throw new Error("Resource path resolution host has not been registered.");
  }
  return host;
}
