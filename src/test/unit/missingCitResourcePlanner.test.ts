import * as assert from "node:assert/strict";
import * as path from "node:path";
import { MissingCitResourcePlanner } from "../../cit/services/missingCitResourcePlanner";
import type { ResourceReference } from "../../utils/resourceReferences";

describe("missing CIT resource planner", () => {
  const packRoot = path.resolve("workspace", "pack");
  const documentFileName = path.join(
    packRoot,
    "assets",
    "minecraft",
    "citresewn",
    "cit",
    "swords",
    "diamond.properties"
  );
  const planner = new MissingCitResourcePlanner({ getPackRoot: () => packRoot });

  it("plans a local texture and embeds a valid PNG seed", () => {
    const plan = planner.plan(documentFileName, reference("diamond_sword", "textures", "png"));

    assert.strictEqual(
      plan?.targetPath,
      path.join(path.dirname(documentFileName), "diamond_sword.png")
    );
    assert.deepStrictEqual(Buffer.from(plan?.content ?? []).subarray(0, 8), Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
    ]));
  });

  it("plans model JSON independently from the VS Code write boundary", () => {
    const plan = planner.plan(
      documentFileName,
      reference("custom:item/diamond_sword", "models", "json")
    );
    const json = JSON.parse(Buffer.from(plan?.content ?? []).toString("utf8")) as {
      parent?: string;
    };

    assert.strictEqual(
      plan?.targetPath,
      path.join(packRoot, "assets", "custom", "item", "diamond_sword.json")
    );
    assert.strictEqual(json.parent, "minecraft:item/generated");
  });

  it("refuses absolute and traversal-based creation targets outside the pack", () => {
    const outside = path.resolve(packRoot, "..", "outside", "escaped");

    assert.strictEqual(
      planner.plan(documentFileName, reference("../../../../../../escaped", "textures", "png")),
      null
    );
    assert.strictEqual(
      planner.plan(documentFileName, reference(outside, "models", "json")),
      null
    );
  });
});

function reference(value: string, target: string, extension: string): ResourceReference {
  return {
    value,
    target,
    extension,
    source: "citresewn/cit",
    kind: target === "textures" ? "texture" : "model",
    resolveMode: "cit",
    valueNode: {}
  };
}
