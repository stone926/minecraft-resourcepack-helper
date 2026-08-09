import { isShaderSourceFileName } from "../resources/resourceSurfaceRegistry";
import * as path from "node:path";
import {
  isValidMinecraftNamespace,
  isSamePath,
  minecraftReferenceKindForResourceKind,
  parseResourceLocation,
  startsWithPathSegment
} from "../../packages/mc-assets/src";
import { getCitDocumentNamespace } from "../cit/citPaths";
import {
  buildResourceCompletionText,
  getAssetsRootCandidates,
  parsePartialResourcePath,
  shouldCompleteNamespaces,
  splitResourcePath,
  type PartialResourcePath
} from "../utils/resourceCompletionPaths";
import type { ResourceReference } from "../utils/resourceReferences";

export type ResourceCompletionCandidateKind = "namespace" | "directory" | "file";

export interface ResourceCompletionCandidate {
  label: string;
  kind: ResourceCompletionCandidateKind;
  value: string;
  filterText: string;
  retriggerSuggest: boolean;
}

export interface ResourceCompletionConfiguration {
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface ResourceCompletionRequest {
  documentFileName: string;
  reference: ResourceReference;
  configuration: ResourceCompletionConfiguration;
}

export interface ResourceCompletionDirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface ResourceCompletionRootRequest {
  resourcePath: string;
  sourceFileName: string;
  target: string;
  source: string;
  targetFileExtension: string | null;
  defaultAssetsPath?: string | null;
  resourcePackRoots?: string[];
}

export interface ResourceCompletionHost {
  getDirectoryEntries(directory: string): Promise<readonly ResourceCompletionDirectoryEntry[] | null>;
  getResourceRootCandidates(
    request: ResourceCompletionRootRequest,
    resourcePath: string,
    namespace: string
  ): string[];
}

export interface ResourceCompletionInventoryHost {
  getKnownResources(kinds: readonly string[]): Promise<{
    resources: readonly {
      target: { kind: string; id: string };
      producer: { origin: string };
    }[];
  }>;
}

export class ResourceCompletionService {
  constructor(
    private readonly host: ResourceCompletionHost,
    private readonly inventory?: ResourceCompletionInventoryHost
  ) {}

  async getCompletionCandidates(request: ResourceCompletionRequest): Promise<ResourceCompletionCandidate[]> {
    if (request.reference.value.startsWith("#")) {
      return [];
    }

    const partialPath = parsePartialResourcePath(request.reference.value);
    const lookupNamespace = getCompletionLookupNamespace(
      request.documentFileName,
      request.reference,
      partialPath
    );
    const roots = this.getResourceRoots(request, lookupNamespace, request.reference.value, false);
    if (request.reference.resolveMode === "cit" && shouldCompleteCitLocalPath(request.reference.value)) {
      roots.unshift(path.dirname(request.documentFileName));
    }

    const physicalCandidates = await this.collectCompletionCandidates(roots, partialPath, request);
    const generatedCandidates = await this.collectGeneratedCompletionCandidates(
      partialPath,
      request.reference
    );
    return uniqueCompletionCandidates([...physicalCandidates, ...generatedCandidates]);
  }

  /**
   * Reads only last-known generated inventory; callers decide whether the
   * inventory host is lazy-load neutral. Filtering stays in this domain layer
   * beside physical completion filtering.
   */
  private async collectGeneratedCompletionCandidates(
    partialPath: PartialResourcePath,
    reference: ResourceReference
  ): Promise<ResourceCompletionCandidate[]> {
    if (!this.inventory) {
      return [];
    }

    try {
      const inventory = await this.inventory.getKnownResources([reference.kind]);
      return inventory.resources.flatMap(item => {
        if (item.producer.origin !== "generated") {
          return [];
        }
        if (minecraftReferenceKindForResourceKind(item.target.kind) !== reference.kind) {
          return [];
        }

        const separator = item.target.id.indexOf(":");
        if (separator < 0) {
          return [];
        }
        const namespace = item.target.id.slice(0, separator);
        const idPath = item.target.id.slice(separator + 1);
        if (partialPath.explicitNamespace && namespace !== partialPath.namespace) {
          return [];
        }
        if (partialPath.directory && !idPath.startsWith(`${partialPath.directory}/`)) {
          return [];
        }

        const fileName = idPath.split("/").pop() ?? idPath;
        if (!fileName.startsWith(partialPath.prefix)) {
          return [];
        }
        return [{
          label: fileName,
          kind: "file" as const,
          value: `${namespace}:${idPath}`,
          filterText: idPath,
          retriggerSuggest: false
        }];
      });
    } catch {
      return [];
    }
  }

  private getResourceRoots(
    request: ResourceCompletionRequest,
    namespace: string,
    value: string,
    isDirectory: boolean
  ): string[] {
    const completionResource = getResourcePathForCompletionValue(request.reference, value, isDirectory);
    return this.host.getResourceRootCandidates(
      {
        resourcePath: value,
        sourceFileName: request.documentFileName,
        target: request.reference.target,
        source: request.reference.source,
        targetFileExtension: isDirectory ? null : request.reference.extension,
        defaultAssetsPath: request.configuration.defaultAssetsPath,
        resourcePackRoots: request.configuration.resourcePackRoots
      },
      completionResource?.resourcePath ?? "",
      namespace
    );
  }

  private async collectCompletionCandidates(
    roots: string[],
    partialPath: PartialResourcePath,
    request: ResourceCompletionRequest
  ): Promise<ResourceCompletionCandidate[]> {
    const candidatesByValue = new Map<string, ResourceCompletionCandidate>();

    await this.collectNamespaceCompletionCandidates(candidatesByValue, roots, partialPath, request.reference);

    for (const root of roots) {
      const directoryPath = path.join(root, ...splitResourcePath(partialPath.directory));
      const entries = await this.host.getDirectoryEntries(directoryPath);
      if (!entries) {
        continue;
      }

      for (const entry of entries) {
        if (!isCompletableEntry(entry, request.reference)) {
          continue;
        }

        const isDirectory = entry.isDirectory();
        const label = isDirectory ? entry.name : stripExtension(entry.name, request.reference.extension);
        if (!label.startsWith(partialPath.prefix)) {
          continue;
        }

        const completionText = buildResourceCompletionText(partialPath, label, isDirectory);
        if (candidatesByValue.has(completionText.value)) {
          continue;
        }
        if (!this.isRootAllowedForCompletionEntry(root, completionText.value, isDirectory, request)) {
          continue;
        }

        candidatesByValue.set(completionText.value, {
          label,
          kind: isDirectory ? "directory" : "file",
          value: completionText.value,
          filterText: completionText.filterText,
          retriggerSuggest: isDirectory
        });
      }
    }

    return [...candidatesByValue.values()].sort((left, right) => left.label.localeCompare(right.label));
  }

  private async collectNamespaceCompletionCandidates(
    candidatesByValue: Map<string, ResourceCompletionCandidate>,
    roots: string[],
    partialPath: PartialResourcePath,
    reference: ResourceReference
  ): Promise<void> {
    if (!shouldCompleteNamespaces(partialPath)) {
      return;
    }

    for (const assetsRoot of getAssetsRootCandidates(roots, partialPath.namespace, reference.target)) {
      const entries = await this.host.getDirectoryEntries(assetsRoot);
      if (!entries) {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || !isValidMinecraftNamespace(entry.name)) {
          continue;
        }

        const label = `${entry.name}:`;
        if (!label.startsWith(partialPath.prefix) || candidatesByValue.has(label)) {
          continue;
        }

        candidatesByValue.set(label, {
          label,
          kind: "namespace",
          value: label,
          filterText: label,
          retriggerSuggest: true
        });
      }
    }
  }

  private isRootAllowedForCompletionEntry(
    root: string,
    value: string,
    isDirectory: boolean,
    request: ResourceCompletionRequest
  ): boolean {
    if (
      request.reference.resolveMode === "cit" &&
      isSamePath(root, path.dirname(request.documentFileName))
    ) {
      return true;
    }

    const completionResource = getResourcePathForCompletionValue(request.reference, value, isDirectory);
    if (!completionResource) {
      return true;
    }

    const allowedRoots = this.getResourceRoots(
      request,
      completionResource.namespace,
      value,
      isDirectory
    );
    return allowedRoots.some(candidate => isSamePath(candidate, root));
  }
}

function getCompletionLookupNamespace(
  fileName: string,
  reference: ResourceReference,
  partialPath: PartialResourcePath
): string {
  if (reference.resolveMode === "cit" && !partialPath.explicitNamespace) {
    return getCitDocumentNamespace(fileName);
  }

  return partialPath.namespace;
}

function shouldCompleteCitLocalPath(value: string): boolean {
  const cleanValue = value.trim();
  if (cleanValue.length === 0) {
    return true;
  }

  return !path.isAbsolute(cleanValue) &&
    !cleanValue.includes(":") &&
    !startsWithPathSegment(cleanValue, "assets");
}

function getResourcePathForCompletionValue(
  reference: ResourceReference,
  value: string,
  isDirectory: boolean
): { namespace: string; resourcePath: string } | null {
  const cleanValue = isDirectory ? value.replace(/[\\/]+$/g, "") : value;
  if (cleanValue.trim().length === 0) {
    return null;
  }

  const location = parseResourceLocation(cleanValue, isDirectory ? null : reference.extension);
  if (!location.isValid || location.resourcePath.length === 0) {
    return null;
  }

  return {
    namespace: location.namespace,
    resourcePath: path.posix.join(
      reference.target.replaceAll("\\", "/"),
      location.resourcePath.replaceAll(path.sep, "/")
    )
  };
}

function stripExtension(fileName: string, extension: string | null): string {
  return extension && fileName.endsWith(`.${extension}`)
    ? fileName.slice(0, -extension.length - 1)
    : fileName;
}

function isCompletableEntry(
  entry: ResourceCompletionDirectoryEntry,
  reference: ResourceReference
): boolean {
  if (reference.kind === "fontFile") {
    return entry.isDirectory() || entry.isFile();
  }

  if (reference.kind === "shader" && reference.extension === null) {
    return entry.isDirectory() || (entry.isFile() && isShaderSourceFileName(entry.name));
  }

  if (reference.extension === null) {
    return entry.isDirectory();
  }

  return entry.isDirectory() || (entry.isFile() && entry.name.endsWith(`.${reference.extension}`));
}

function uniqueCompletionCandidates(
  candidates: readonly ResourceCompletionCandidate[]
): ResourceCompletionCandidate[] {
  const unique = new Map<string, ResourceCompletionCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\0${candidate.value}`;
    if (!unique.has(key)) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()];
}
