import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceGraphLogicalKey } from "../../../../packages/mc-assets/src";
import type { RsglResourceSnapshot } from "../../../../packages/rsgl-core/src";
import {
  rsglResourceSnapshotProtocolVersion,
  type RsglResourceSnapshotResponse
} from "../../../../packages/rsgl-shared/src";
import {
  adaptPhysicalAssetDocuments,
  createPhysicalAssetSnapshot,
  type PhysicalAssetScannedDocument,
  type ResourceContributionRequest,
  type ResourceProviderSnapshot
} from "../../../resourceUniverse";

export type MixedWorkflowId =
  | "rsgl-build-to-assets"
  | "rsgl-to-local"
  | "rsgl-to-vanilla"
  | "assets-to-unbuilt-rsgl"
  | "both-to-custom";

export interface MixedGoldenEdge {
  from: string;
  to: string;
  relationship: string;
  scope: "effective" | "local" | "custom" | "vanilla";
}

export interface MixedGoldenWorkflow {
  id: MixedWorkflowId;
  logicalTarget: ResourceGraphLogicalKey & { key: string };
  winner: { uri: string };
  definition: { primaryUri: string; anchor?: string };
  graph: { edges: readonly MixedGoldenEdge[]; nodeCountAfterBuild: number };
  build: { destination?: string };
}

export interface MixedFixtureGolden {
  project: {
    id: string;
    sourceRoot: string;
  };
  archive: {
    path: string;
    entries: readonly { path: string; content: string }[];
  };
  workflows: readonly MixedGoldenWorkflow[];
}

interface FixtureLayer {
  layerId: string;
  layerRole: "local" | "custom" | "vanilla";
  packRoot: string;
}

export class CompilerSnapshotSource {
  public constructor(private readonly snapshot: RsglResourceSnapshot) {}

  public async requestSnapshot(
    request: ResourceContributionRequest
  ): Promise<RsglResourceSnapshotResponse> {
    return {
      protocolVersion: rsglResourceSnapshotProtocolVersion,
      projectId: request.projectId,
      requestGeneration: request.requestGeneration,
      revision: this.snapshot.revision,
      status: "ok",
      coverage: {
        status: "authoritative",
        revision: this.snapshot.revision,
        coveredScope: { projectId: request.projectId }
      },
      resources: this.snapshot.resources,
      edges: this.snapshot.edges,
      skippedSourceUris: this.snapshot.skippedSourceUris
    };
  }
}

export function createMixedPhysicalSnapshot(
  fixtureRoot: string,
  projectId: string,
  archiveModelText: string,
  archiveUri: string,
  generation: number,
  ownedOutputPaths?: ReadonlySet<string>
): ResourceProviderSnapshot {
  const layers: FixtureLayer[] = [{
    layerId: "local",
    layerRole: "local",
    packRoot: fixturePath(fixtureRoot, "project")
  }, {
    layerId: "custom-directory",
    layerRole: "custom",
    packRoot: fixturePath(fixtureRoot, "extern-directory")
  }, {
    layerId: "vanilla-directory",
    layerRole: "vanilla",
    packRoot: fixturePath(fixtureRoot, "vanilla")
  }];
  const documents = layers.flatMap(layer => scanJsonLayer(layer, generation));
  documents.push({
    uri: archiveUri,
    fileName: "/assets/external/models/block/shared_custom.json",
    languageId: "json",
    version: generation,
    revision: revisionOf(archiveModelText),
    layerId: "custom-zip",
    layerRole: "custom",
    outputPath: "assets/external/models/block/shared_custom.json",
    getText: () => archiveModelText
  });
  return createPhysicalAssetSnapshot({
    projectId,
    generation,
    revision: `physical-r${generation}`,
    documents: adaptPhysicalAssetDocuments(documents),
    ownedOutputPaths
  });
}

export function resolveExternFixture(
  fixtureRoot: string,
  source: "local" | "custom" | "vanilla",
  kind: string,
  id: string
): string | null {
  if (kind !== "model") {
    return null;
  }
  const locations = new Map<string, string>([
    ["local|demo:block/handwritten", "project/assets/demo/models/block/handwritten.json"],
    ["vanilla|minecraft:block/cube_all", "vanilla/assets/minecraft/models/block/cube_all.json"],
    ["custom|external:block/shared_custom", "extern-directory/assets/external/models/block/shared_custom.json"]
  ]);
  const relative = locations.get(`${source}|${id}`);
  return relative ? fixturePath(fixtureRoot, relative) : null;
}

export function readMixedGolden(fixtureRoot: string): MixedFixtureGolden {
  return JSON.parse(fs.readFileSync(
    fixturePath(fixtureRoot, "expected/workflows.json"),
    "utf8"
  )) as MixedFixtureGolden;
}

export function mixedWorkflow(
  golden: MixedFixtureGolden,
  id: MixedWorkflowId
): MixedGoldenWorkflow {
  const value = golden.workflows.find(candidate => candidate.id === id);
  if (!value) {
    throw new Error(`Missing workflow golden '${id}'.`);
  }
  return value;
}

export function mixedWorkflowTarget(value: MixedGoldenWorkflow): ResourceGraphLogicalKey {
  const key = `${value.logicalTarget.kind}|${value.logicalTarget.id}`;
  if (value.logicalTarget.key !== key) {
    throw new Error(`Invalid workflow logical key '${value.logicalTarget.key}'; expected '${key}'.`);
  }
  return { kind: value.logicalTarget.kind, id: value.logicalTarget.id };
}

export function findPackRoot(resourcePath: string): string {
  const assets = `${path.sep}assets${path.sep}`;
  const index = resourcePath.indexOf(assets);
  return index >= 0 ? resourcePath.slice(0, index) : path.dirname(resourcePath);
}

export function fixturePath(fixtureRoot: string, relativePath: string): string {
  return path.join(fixtureRoot, ...relativePath.split("/"));
}

export function slash(value: string): string {
  return value.replaceAll("\\", "/");
}

function scanJsonLayer(layer: FixtureLayer, generation: number): PhysicalAssetScannedDocument[] {
  const assetsRoot = path.join(layer.packRoot, "assets");
  return walkJsonFiles(assetsRoot).map(fileName => {
    const text = fs.readFileSync(fileName, "utf8");
    return {
      uri: pathToFileURL(fileName).toString(),
      fileName,
      languageId: "json",
      version: generation,
      revision: revisionOf(text),
      layerId: layer.layerId,
      layerRole: layer.layerRole,
      outputPath: `assets/${slash(path.relative(assetsRoot, fileName))}`,
      getText: () => text
    };
  });
}

function walkJsonFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const candidate = path.join(directory, entry.name);
    return entry.isDirectory()
      ? walkJsonFiles(candidate)
      : entry.isFile() && entry.name.endsWith(".json")
        ? [candidate]
        : [];
  }).sort((left, right) => left.localeCompare(right, "en"));
}

function revisionOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}
