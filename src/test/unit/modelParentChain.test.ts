import * as assert from "node:assert/strict";
import * as path from "node:path";
import {
  loadModelParentChain,
  modelSourceForFile
} from "../../services/modelParentChain";
import { parseJsonAst } from "../../utils/jsonAst";

describe("model parent chain", () => {
  it("derives the model lookup source from Windows and POSIX paths", () => {
    assert.strictEqual(
      modelSourceForFile("C:\\pack\\assets\\minecraft\\models\\item\\handheld.json"),
      "models/item"
    );
    assert.strictEqual(
      modelSourceForFile("/pack/assets/minecraft/models/block/cube.json"),
      "models/block"
    );
    assert.strictEqual(
      modelSourceForFile("/pack/assets/minecraft/models/entity/zombie.json"),
      "models"
    );
  });

  it("preserves the traversal termination reason for diagnostics", () => {
    const entryFile = path.resolve("pack", "assets", "custom", "models", "block", "entry.json");
    const middleFile = path.resolve("pack", "assets", "custom", "models", "block", "middle.json");
    const entryAst = parseJsonAst(JSON.stringify({ parent: "custom:block/middle" }));
    const middleAst = parseJsonAst(JSON.stringify({ parent: "custom:block/entry" }));
    assert.ok(entryAst);
    assert.ok(middleAst);

    const result = loadModelParentChain({
      resolveResourcePathWithDependencies: request => ({
        fileName: request.resourcePath.endsWith("middle") ? middleFile : entryFile,
        verificationPaths: []
      }),
      getJsonFileAst: fileName => fileName === middleFile ? middleAst : entryAst
    }, entryFile, entryAst, "models/block", {
      defaultAssetsPath: null,
      resourcePackRoots: []
    });

    assert.deepStrictEqual(result.models.map(model => model.fileName), [entryFile, middleFile]);
    assert.deepStrictEqual(result.issue, { kind: "cycle", fileName: entryFile });
  });
});
