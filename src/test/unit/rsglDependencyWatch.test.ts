import * as assert from "node:assert";
import * as path from "node:path";
import {
  DependencyWatchRegistry,
  dependencyBuildNeedsVerification,
  normalizeDependencyPath
} from "../../../extensions/vscode-rsgl/src/dependencyWatch";

describe("RSGL dependency watcher state", () => {
  it("adds, retains, removes, and disposes exact dependency watchers", () => {
    const disposed: string[] = [];
    const created: string[] = [];
    const registry = new DependencyWatchRegistry(fileName => {
      created.push(fileName);
      return { dispose: () => disposed.push(fileName) };
    });
    const root = path.resolve("virtual", "watchers");
    const first = path.join(root, "first.json");
    const second = path.join(root, "second.json");

    assert.deepStrictEqual(registry.update([first, first]).added, [first]);
    assert.deepStrictEqual(registry.update([first, second]).added, [second]);
    assert.deepStrictEqual(registry.update([second]).removed, [first]);
    assert.deepStrictEqual(created, [first, second]);
    assert.deepStrictEqual(disposed, [first]);

    registry.dispose();
    assert.deepStrictEqual(disposed, [first, second]);
  });

  it("requires verification for newly discovered or concurrently invalidated dependencies", () => {
    const first = normalizeDependencyPath(path.resolve("virtual", "first.json"));
    const second = normalizeDependencyPath(path.resolve("virtual", "second.json"));

    assert.strictEqual(
      dependencyBuildNeedsVerification(new Set([first]), new Set([first, second]), new Set()),
      true
    );
    assert.strictEqual(
      dependencyBuildNeedsVerification(new Set([first]), new Set([first]), new Set([first])),
      true
    );
    assert.strictEqual(
      dependencyBuildNeedsVerification(new Set([first]), new Set([first]), new Set()),
      false
    );
  });
});
