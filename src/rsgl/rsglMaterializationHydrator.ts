import { createHash } from "node:crypto";
import { uniqueValues } from "../../packages/mc-assets/src";
import {
  joinResourceProjectUri,
  type ResourcePackProjectContextDto
} from "../../packages/resource-project/src";
import {
  parseRsglGeneratedOwnershipManifest,
  projectParsedRsglGeneratedOwnershipManifest,
  type RsglGeneratedMaterializationEntry,
  type RsglGeneratedMaterializationSnapshot,
  type RsglGeneratedOwnershipManifest
} from "../resourceUniverse";

export interface RsglMaterializationHydrationHost {
  readTextUri?(uri: string): Promise<string | undefined>;
  readBinaryUri?(uri: string): Promise<Uint8Array | undefined>;
  listDirectoryUris?(uri: string): Promise<readonly string[] | undefined>;
}

export interface RsglExpectedCommittedManifest {
  manifestUri: string;
  projectId: string;
  ownershipRevision: string;
}

export interface RsglMaterializationHydrationResult {
  snapshot: RsglGeneratedMaterializationSnapshot;
  expectedManifestVerified: boolean;
}

interface LoadedManifest {
  uri: string;
  textHash: string;
  manifest: RsglGeneratedOwnershipManifest;
  actualContentHashes: ReadonlyMap<string, string>;
}

/** Reads provenance only after a project becomes RSGL-relevant. */
export async function hydrateRsglMaterializations(
  context: ResourcePackProjectContextDto,
  host: RsglMaterializationHydrationHost,
  expected?: RsglExpectedCommittedManifest
): Promise<RsglMaterializationHydrationResult> {
  const manifestDirectoryUri = joinResourceProjectUri(
    context.outputPackRootUri,
    ".rsgl/manifests"
  );
  const listed = await safeList(host, manifestDirectoryUri);
  const manifestUris = uniqueSorted([
    ...(listed ?? []).filter(isJsonUri),
    ...(expected ? [expected.manifestUri] : [])
  ]);
  const issues: string[] = [];
  const loaded: LoadedManifest[] = [];

  for (const manifestUri of manifestUris) {
    const text = await safeReadText(host, manifestUri);
    if (text === undefined) {
      issues.push(`Ownership manifest could not be read: ${manifestUri}`);
      continue;
    }
    try {
      const manifest = parseRsglGeneratedOwnershipManifest(text);
      if (manifest.outputPackRootIdentity !== context.localLayer.layerId) {
        throw new Error("outputPackRootIdentity does not match the canonical local layer");
      }
      const actualContentHashes = new Map<string, string>();
      for (const file of manifest.files) {
        const bytes = await safeReadBinary(
          host,
          joinResourceProjectUri(context.outputPackRootUri, file.outputPath)
        );
        if (bytes !== undefined) {
          actualContentHashes.set(file.outputPath, sha256(bytes));
        }
      }
      loaded.push({
        uri: manifestUri,
        textHash: sha256(text),
        manifest,
        actualContentHashes
      });
    } catch (error) {
      issues.push(`Invalid ownership manifest '${manifestUri}': ${errorMessage(error)}`);
    }
  }

  const ownedOutputPaths = uniqueSorted(loaded.flatMap(item =>
    item.manifest.files.map(file => file.outputPath)
  ));
  const ownersByPath = new Map<string, Set<string>>();
  for (const item of loaded) {
    for (const file of item.manifest.files) {
      let owners = ownersByPath.get(file.outputPath);
      if (!owners) {
        owners = new Set<string>();
        ownersByPath.set(file.outputPath, owners);
      }
      owners.add(item.manifest.projectId);
    }
  }

  const entriesByProducer = new Map<string, RsglGeneratedMaterializationEntry>();
  const ownProjectIds = new Set([
    context.projectId,
    ...(expected ? [expected.projectId] : [])
  ]);
  const own = loaded.filter(item => ownProjectIds.has(item.manifest.projectId));
  for (const item of own) {
    const projected = projectParsedRsglGeneratedOwnershipManifest(item.manifest, {
      canonicalProjectId: context.projectId,
      ownershipProjectId: item.manifest.projectId,
      ownershipRevision: item.manifest.buildRevision,
      outputPackRootUri: context.outputPackRootUri,
      actualContentHashes: item.actualContentHashes
    });
    for (const entry of projected.entries) {
      if (entriesByProducer.has(entry.producerId)) {
        issues.push(`Duplicate ownership producer '${entry.producerId}'.`);
        continue;
      }
      entriesByProducer.set(entry.producerId, {
        ...entry,
        ...(ownersByPath.get(entry.outputPath)?.size ?? 0) > 1
          ? { state: "conflict" }
          : {}
      });
    }
  }

  const expectedManifestVerified = expected === undefined || loaded.some(item =>
    sameUri(item.uri, expected.manifestUri)
    && item.manifest.projectId === expected.projectId
    && item.manifest.buildRevision === expected.ownershipRevision
  );
  if (!expectedManifestVerified) {
    issues.push("The committed ownership manifest did not match its transaction notification.");
  }
  const status = issues.length > 0
    ? "partial" as const
    : own.length === 0
      ? "missing" as const
      : "authoritative" as const;
  const revision = stableRevision({
    contextRevision: context.contextRevision,
    manifests: loaded.map(item => ({
      uri: item.uri,
      projectId: item.manifest.projectId,
      buildRevision: item.manifest.buildRevision,
      textHash: item.textHash,
      actualContentHashes: [...item.actualContentHashes].sort(([left], [right]) =>
        left.localeCompare(right, "en"))
    })),
    issues: uniqueSorted(issues),
    status
  });
  return {
    expectedManifestVerified,
    snapshot: {
      projectId: context.projectId,
      revision,
      entries: [...entriesByProducer.values()],
      ownedOutputPaths,
      status,
      issues: uniqueSorted(issues)
    }
  };
}

async function safeList(
  host: RsglMaterializationHydrationHost,
  uri: string
): Promise<readonly string[] | undefined> {
  try {
    return await host.listDirectoryUris?.(uri);
  } catch {
    return undefined;
  }
}

async function safeReadText(
  host: RsglMaterializationHydrationHost,
  uri: string
): Promise<string | undefined> {
  try {
    return await host.readTextUri?.(uri);
  } catch {
    return undefined;
  }
}

async function safeReadBinary(
  host: RsglMaterializationHydrationHost,
  uri: string
): Promise<Uint8Array | undefined> {
  try {
    return await host.readBinaryUri?.(uri);
  } catch {
    return undefined;
  }
}

function isJsonUri(uri: string): boolean {
  try {
    return new URL(uri).pathname.toLowerCase().endsWith(".json");
  } catch {
    return false;
  }
}

function sameUri(left: string, right: string): boolean {
  return left === right || (process.platform === "win32"
    && left.startsWith("file:")
    && right.startsWith("file:")
    && left.toLowerCase() === right.toLowerCase());
}

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function stableRevision(value: unknown): string {
  return sha256(JSON.stringify(value));
}

function uniqueSorted(values: readonly string[]): string[] {
  return uniqueValues(values).sort((left, right) => left.localeCompare(right, "en"));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
