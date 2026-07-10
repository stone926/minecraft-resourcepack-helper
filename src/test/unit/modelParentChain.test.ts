import * as assert from "node:assert";
import { modelSourceForFile } from "../../services/modelParentChain";

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
});
