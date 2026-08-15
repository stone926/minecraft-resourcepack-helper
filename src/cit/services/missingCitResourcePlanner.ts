import * as path from "node:path";
import { workspaceResourceCache } from "../../services/workspaceResourceCache";
import type { ResourceReference } from "../../utils/resourceReferences";
import { citResourceTypeFor } from "../citAssetResolver";
import type { CitResourceType } from "../citKeyResolution";
import {
  resolveCitPackRoot, getCitPathCandidates } from "../citPaths";

export interface CitPackRootResolver {
  getPackRoot(fileName: string): string | null;
}

export interface MissingCitResourcePlan {
  packRoot: string;
  targetPath: string;
  content: Uint8Array;
}

const missingPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAFgwJ/lLD9WQAAAABJRU5ErkJggg==",
  "base64"
);

/** Plans target selection and initial content without depending on VS Code APIs. */
export class MissingCitResourcePlanner {
  public constructor(
    private readonly packRoots: CitPackRootResolver = workspaceResourceCache
  ) {}

  public targetPath(documentFileName: string, reference: ResourceReference): string | null {
    return this.resolveTarget(documentFileName, reference)?.targetPath ?? null;
  }

  public plan(documentFileName: string, reference: ResourceReference): MissingCitResourcePlan | null {
    const target = this.resolveTarget(documentFileName, reference);
    if (!target) {
      return null;
    }
    return {
      ...target,
      content: defaultContentFor(reference)
    };
  }

  private resolveTarget(
    documentFileName: string,
    reference: ResourceReference
  ): Pick<MissingCitResourcePlan, "packRoot" | "targetPath"> | null {
    const resourceType = resourceTypeFor(reference);
    if (!resourceType) {
      return null;
    }

    const packRoot = resolveCitPackRoot(documentFileName, fileName => this.packRoots.getPackRoot(fileName));
    if (!packRoot) {
      return null;
    }

    const candidates = getCitPathCandidates(
      documentFileName,
      packRoot,
      reference.value,
      resourceType
    );
    const targetPath = candidates.find(candidate => isPathWithinPack(packRoot, candidate));
    if (!targetPath) {
      return null;
    }
    return {
      packRoot,
      targetPath
    };
  }
}

function isPathWithinPack(packRoot: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(packRoot), path.resolve(candidate));
  return relative.length > 0
    && !path.isAbsolute(relative)
    && relative !== ".."
    && !relative.startsWith(`..${path.sep}`);
}

function resourceTypeFor(reference: ResourceReference): CitResourceType | null {
  if (reference.origin === "citAutoDiscovery") {
    return "models";
  }
  return citResourceTypeFor(reference.target, reference.extension);
}

function defaultContentFor(reference: ResourceReference): Uint8Array {
  if (resourceTypeFor(reference) === "textures") {
    return missingPng;
  }

  return Buffer.from(`${JSON.stringify({
    parent: "minecraft:item/generated",
    textures: {
      layer0: "minecraft:item/generated"
    }
  }, null, 2)}\n`, "utf8");
}
