import * as assert from "node:assert";
import type { PhysicalAssetOwnedOutputLookup } from "../../resourceUniverse";
import { bindRsglPhysicalOwnership } from "../../rsgl/rsglOwnershipBinding";

describe("RSGL physical ownership binding", () => {
  const lookup: PhysicalAssetOwnedOutputLookup = {
    getOwnedOutputPaths: () => new Set(["assets/demo/models/generated.json"]),
    getOwnershipRevision: () => "ownership-r1"
  };

  it("binds a structural cross-bundle capability and exposes its subscription", () => {
    let boundLookup: PhysicalAssetOwnedOutputLookup | undefined;
    let disposals = 0;
    const provider = {
      providerId: "physical" as const,
      setOwnedOutputLookup(value: PhysicalAssetOwnedOutputLookup) {
        boundLookup = value;
        return {
          dispose: () => {
            boundLookup = undefined;
            disposals++;
          }
        };
      },
      async getSnapshot(): Promise<never> {
        throw new Error("not used");
      }
    };

    const binding = bindRsglPhysicalOwnership(provider, lookup);

    assert.strictEqual(binding?.providerId, "physical");
    assert.strictEqual(boundLookup, lookup);
    binding?.subscription.dispose();
    assert.strictEqual(boundLookup, undefined);
    assert.strictEqual(disposals, 1);
  });

  it("rejects missing or malformed capabilities without invoking snapshot work", () => {
    let snapshots = 0;
    const provider = {
      providerId: "physical" as const,
      setOwnedOutputLookup: () => ({ close: () => undefined }),
      async getSnapshot(): Promise<never> {
        snapshots++;
        throw new Error("not used");
      }
    };

    assert.strictEqual(bindRsglPhysicalOwnership(undefined, lookup), undefined);
    assert.strictEqual(bindRsglPhysicalOwnership(provider, lookup), undefined);
    assert.strictEqual(snapshots, 0);
  });

  it("isolates errors thrown by a foreign ownership provider", () => {
    const provider = {
      providerId: "physical" as const,
      setOwnedOutputLookup(): { dispose(): void } {
        throw new Error("foreign binding failed");
      },
      async getSnapshot(): Promise<never> {
        throw new Error("not used");
      }
    };

    assert.strictEqual(bindRsglPhysicalOwnership(provider, lookup), undefined);
  });
});
