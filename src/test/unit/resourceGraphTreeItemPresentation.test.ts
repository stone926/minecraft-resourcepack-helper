import * as assert from "node:assert";
import { createResourceGraphTreeItemPresentation } from "../../views/resourceGraphTreeItemPresentation";

describe("resource graph TreeItem presentation", () => {
  it("maps label, icon, context value, and supporting fields without VS Code APIs", () => {
    const presentation = createResourceGraphTreeItemPresentation({
      label: "Stone model",
      collapsibleState: "collapsed",
      description: "minecraft:block/stone",
      icon: "symbol-object",
      contextValue: "modelResource",
      tooltip: "assets/minecraft/models/block/stone.json",
      getChildren: async () => []
    });

    assert.deepStrictEqual(presentation, {
      label: "Stone model",
      collapsibleState: "collapsed",
      description: "minecraft:block/stone",
      icon: "symbol-object",
      contextValue: "modelResource",
      tooltip: "assets/minecraft/models/block/stone.json"
    });
  });
});
