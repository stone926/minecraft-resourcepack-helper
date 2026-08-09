import * as assert from "node:assert/strict";
import * as path from "node:path";
import { ModelResourceCache } from "../../services/modelResourceCache";
import { ResourceCacheMetrics } from "../../services/resourceCacheMetrics";
import { parseJsonAst } from "../../utils/jsonAst";

describe("model resource cache", () => {
  it("retries an in-flight parent chain when a higher-priority candidate appears", async () => {
    const childFile = path.resolve("pack", "assets", "minecraft", "models", "block", "child.json");
    const highParent = path.resolve("pack", "assets", "minecraft", "models", "block", "parent.json");
    const lowParent = path.resolve("fallback", "assets", "minecraft", "models", "block", "parent.json");
    const childAst = parseJsonAst(JSON.stringify({ parent: "minecraft:block/parent" }));
    const parentAst = parseJsonAst("{}");
    assert.ok(childAst);
    assert.ok(parentAst);

    let finishLowParent: (ast: NonNullable<typeof parentAst>) => void = () => undefined;
    const lowParentRead = new Promise<NonNullable<typeof parentAst>>(resolve => {
      finishLowParent = resolve;
    });
    let winner = lowParent;
    let mutationGeneration = 0;
    const pathMutations = new Map<string, number>();
    const cache = new ModelResourceCache({
      resolveResourcePathWithDependencies: () => ({
        fileName: winner,
        verificationPaths: [childFile, highParent, lowParent]
      }),
      getJsonFileAst: () => parentAst,
      getJsonFileAstAsync: fileName => fileName === lowParent
        ? lowParentRead
        : Promise.resolve(parentAst),
      getFileVersion: () => "version-1",
      canReuseVerifiedPaths: () => true,
      verificationTimestamp: () => 0
    }, {
      getConfigurationVersion: () => 0,
      getResourceFsGeneration: () => 0,
      getResourceMutationGeneration: () => mutationGeneration,
      hasAnyResourceChangedSince: (generation, fileNames) => [...fileNames]
        .some(fileName => (pathMutations.get(path.normalize(fileName)) ?? 0) > generation)
    }, new ResourceCacheMetrics());
    const document = {
      fileName: childFile,
      languageId: "json",
      getText: () => JSON.stringify({ parent: "minecraft:block/parent" })
    };

    const pending = cache.getModelParentChainAsync(
      document,
      childAst,
      { defaultAssetsPath: null, resourcePackRoots: [] },
      "models/block"
    );
    winner = highParent;
    mutationGeneration++;
    pathMutations.set(path.normalize(highParent), mutationGeneration);
    finishLowParent(parentAst);

    const chain = await pending;
    assert.deepStrictEqual(chain.map(model => model.fileName), [childFile, highParent]);
    assert.strictEqual(
      await cache.getModelParentChainAsync(
        document,
        childAst,
        { defaultAssetsPath: null, resourcePackRoots: [] },
        "models/block"
      ),
      chain,
      "the retried current snapshot should be cached"
    );
  });
});
