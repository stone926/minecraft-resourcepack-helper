import * as assert from "node:assert";
import * as path from "node:path";
import { getResourceReferences, type ResourceReferenceDocument } from "./helpers/resourceReferences";

interface VersionedResourceReferenceDocument extends ResourceReferenceDocument {
  uri: {
    toString(): string;
  };
}

describe("resource reference cache", () => {
  it("reuses references across document wrappers with the same uri and version", () => {
    const fileName = path.join("pack", "assets", "minecraft", "models", "block", "shared_cache_test.json");
    const uri = { toString: () => "file:///pack/assets/minecraft/models/block/shared_cache_test.json" };
    let reads = 0;

    const createDocument = (version: number, parent: string): VersionedResourceReferenceDocument => ({
      uri,
      fileName,
      languageId: "json",
      version,
      getText: () => {
        reads++;
        return JSON.stringify({ parent });
      }
    });

    const firstReferences = getResourceReferences(createDocument(1, "minecraft:block/parent_one"));
    const secondReferences = getResourceReferences(createDocument(1, "minecraft:block/parent_two"));
    const thirdReferences = getResourceReferences(createDocument(2, "minecraft:block/parent_three"));

    assert.strictEqual(secondReferences, firstReferences);
    assert.notStrictEqual(thirdReferences, firstReferences);
    assert.strictEqual(reads, 2);
    assert.deepStrictEqual(firstReferences.map(reference => reference.value), ["minecraft:block/parent_one"]);
    assert.deepStrictEqual(thirdReferences.map(reference => reference.value), ["minecraft:block/parent_three"]);
  });
});
