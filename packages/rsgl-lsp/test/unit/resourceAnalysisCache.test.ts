import * as assert from "node:assert/strict";
import type {
  RsglResourceAnalysisResult,
  RsglWorkspaceSemanticProgram
} from "../../../rsgl-core/src";
import { RsglResourceAnalysisCache } from "../../src/resourceAnalysisCache";

describe("RSGL resource analysis cache", () => {
  it("retains an entry identity on hits and advances it after recompilation", () => {
    let compileCount = 0;
    const analysis = {
      compileResult: { dependencies: [] }
    } as unknown as RsglResourceAnalysisResult;
    const cache = new RsglResourceAnalysisCache({
      compile: () => {
        compileCount++;
        return analysis;
      }
    });
    const semanticProgram = {} as RsglWorkspaceSemanticProgram;
    const configuration = { cacheKey: "config-a", options: {} };

    const first = cache.getOrCreate(semanticProgram, configuration);
    const hit = cache.getOrCreate(semanticProgram, configuration);
    assert.strictEqual(hit, first);
    assert.strictEqual(hit.cacheIdentity, first.cacheIdentity);
    assert.strictEqual(compileCount, 1);

    const otherConfiguration = cache.getOrCreate(semanticProgram, {
      cacheKey: "config-b",
      options: {}
    });
    assert.notStrictEqual(otherConfiguration.cacheIdentity, first.cacheIdentity);
    assert.strictEqual(compileCount, 2);

    cache.invalidateAll();
    const recompiled = cache.getOrCreate(semanticProgram, configuration);
    assert.notStrictEqual(recompiled.cacheIdentity, first.cacheIdentity);
    assert.strictEqual(compileCount, 3);
  });
});
