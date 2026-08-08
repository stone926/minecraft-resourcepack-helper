import * as assert from "node:assert";
import { getDisplayedPreviewDependencies } from "../../../modelPreview/host/ModelPreviewDependencyPresentation";
import type { PreviewDependency } from "../../../modelPreview/ir/PreviewDocument";

describe("model preview dependency presentation", () => {
  it("hides resolution candidates without removing them from the tracked dependency list", () => {
    const dependencies: PreviewDependency[] = [
      { uri: "file:///pack/model.json", kind: "model" },
      { uri: "file:///candidate/parent.json", kind: "model", watchOnly: true },
      { uri: "file:///pack/texture.png", kind: "texture" },
      { uri: "file:///candidate/texture.png", kind: "texture", watchOnly: true },
      { uri: "file:///candidate/pack.mcmeta", kind: "packMetadata", watchOnly: true },
      { uri: "configuration:McResHelper.resourcePackLoadOrder", kind: "configuration" }
    ];

    const displayed = getDisplayedPreviewDependencies(dependencies);

    assert.deepStrictEqual(displayed, [dependencies[0], dependencies[2], dependencies[5]]);
    assert.strictEqual(dependencies.length, 6, "presentation must not mutate dependencies used for invalidation");
  });
});
