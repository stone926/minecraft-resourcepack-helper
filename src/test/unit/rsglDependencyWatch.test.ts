import * as assert from "node:assert";
import * as path from "node:path";
import {
  DependencyPatternWatchRegistry,
  DependencyWatchRegistry,
  dependencyPatternMatchesPath,
  dependencyPatternProbePath,
  dependencyBuildNeedsVerification,
  normalizeDependencyPath,
  rebaseDependencyWatchPattern,
  requiresExactDependencyWatcher,
  vscodeExactDependencyWatchPattern,
  vscodeGlobDependencyWatchPattern
} from "../../rsgl/host/dependencyWatch";
import {
  DependencyStructureWatchRegistry,
  type DependencyStructureWatchSelector
} from "../../rsgl/host/dependencyStructureWatch";

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

  it("uses exact watchers for external files and workspace non-source dependencies", () => {
    assert.strictEqual(requiresExactDependencyWatcher("inside/source.rsgl", true), false);
    assert.strictEqual(requiresExactDependencyWatcher("inside/base.json", true), true);
    assert.strictEqual(requiresExactDependencyWatcher("inside/texture.png", true), true);
    assert.strictEqual(requiresExactDependencyWatcher("inside/sound.ogg", true), true);
    assert.strictEqual(requiresExactDependencyWatcher("outside/base.json", false), true);
    assert.strictEqual(requiresExactDependencyWatcher("outside/source.rsgl", false), true);
  });

  it("deduplicates targeted pattern watchers and disposes removed selectors", () => {
    const created: string[] = [];
    const disposed: string[] = [];
    const root = path.resolve("virtual", "pattern-watchers");
    const pattern = { basePath: root, pattern: "**/*.json" };
    const registry = new DependencyPatternWatchRegistry(watchPattern => {
      const identity = `${watchPattern.basePath}:${watchPattern.pattern}`;
      created.push(identity);
      return { dispose: () => disposed.push(identity) };
    });

    assert.strictEqual(registry.update([pattern, pattern]).added.length, 1);
    assert.strictEqual(registry.update([pattern]).added.length, 0);
    assert.strictEqual(registry.update([]).removed.length, 1);
    assert.strictEqual(created.length, 1);
    assert.deepStrictEqual(disposed, created);
  });

  it("rebases missing watcher roots and produces a matching verification probe", () => {
    const existingRoot = path.resolve("virtual", "existing-root");
    const original = {
      basePath: path.join(existingRoot, "future", "nested"),
      pattern: "**/*.json"
    };
    const rebased = rebaseDependencyWatchPattern(
      original,
      fileName => normalizeDependencyPath(fileName) === normalizeDependencyPath(existingRoot)
    );
    const probe = dependencyPatternProbePath(original);

    assert.strictEqual(rebased.basePath, existingRoot);
    assert.strictEqual(rebased.pattern.replaceAll("\\", "/"), "future/nested/**/*.json");
    assert.strictEqual(dependencyPatternMatchesPath(original, probe), true);
    assert.strictEqual(
      dependencyPatternMatchesPath(original, path.join(existingRoot, "outside.json")),
      false
    );
  });

  it("widens VS Code metacharacters without changing RSGL wildcard intent", () => {
    const existingRoot = path.resolve("virtual", "safe-vscode-root");
    const exact = vscodeExactDependencyWatchPattern(
      path.join(existingRoot, "future", "[x]{y}.json"),
      fileName => normalizeDependencyPath(fileName) === normalizeDependencyPath(existingRoot)
    );
    const glob = vscodeGlobDependencyWatchPattern({
      basePath: path.join(existingRoot, "future", "[literal]"),
      pattern: "[x]/{y}/**/*.json"
    }, fileName => normalizeDependencyPath(fileName) === normalizeDependencyPath(existingRoot));

    assert.strictEqual(exact.basePath, existingRoot);
    assert.strictEqual(exact.pattern.replaceAll("\\", "/"), "future/?x??y?.json");
    assert.strictEqual(glob.basePath, existingRoot);
    assert.strictEqual(
      glob.pattern.replaceAll("\\", "/"),
      "future/?literal?/?x?/?y?/**/*.json"
    );

    const embeddedRootGlobstar = vscodeGlobDependencyWatchPattern({
      basePath: existingRoot,
      pattern: "**.json"
    }, () => true);
    const embeddedNestedGlobstar = vscodeGlobDependencyWatchPattern({
      basePath: existingRoot,
      pattern: "foo/**bar"
    }, () => true);
    assert.strictEqual(embeddedRootGlobstar.pattern, "**");
    assert.strictEqual(embeddedNestedGlobstar.pattern, "foo/**");
  });

  it("deduplicates narrow exact-ancestor and glob-prefix structure watchers", () => {
    const root = path.resolve("virtual", "structure-watchers");
    const exactPath = path.join(root, "exact", "nested", "file.json");
    const recursivePattern = { basePath: path.join(root, "generated"), pattern: "**/*.json" };
    const flatPattern = { basePath: path.join(root, "flat"), pattern: "*.json" };
    const created: DependencyStructureWatchSelector[] = [];
    let disposed = 0;
    const registry = new DependencyStructureWatchRegistry(selector => {
      created.push(selector);
      return { dispose: () => { disposed++; } };
    });

    const first = registry.update([exactPath, exactPath], [recursivePattern, flatPattern]);
    assert.ok(first.added.some(selector =>
      selector.kind === "ancestor"
      && normalizeDependencyPath(selector.path) === normalizeDependencyPath(path.dirname(exactPath))
    ));
    assert.ok(first.added.some(selector =>
      selector.kind === "pattern-prefix"
      && selector.pattern.pattern === "**"
      && normalizeDependencyPath(selector.pattern.basePath)
        === normalizeDependencyPath(recursivePattern.basePath)
    ));
    assert.strictEqual(first.added.some(selector =>
      selector.kind === "pattern-prefix"
      && normalizeDependencyPath(selector.pattern.basePath) === normalizeDependencyPath(flatPattern.basePath)
    ), false);
    assert.strictEqual(registry.update([exactPath], [recursivePattern, flatPattern]).added.length, 0);

    const removed = registry.update([], []);
    assert.strictEqual(removed.removed.length, created.length);
    assert.strictEqual(disposed, created.length);
  });

  it("forwards only exact-ancestor and possible glob-directory structure events", () => {
    const root = path.resolve("virtual", "structure-events");
    const exactPath = path.join(root, "exact", "nested", "file.json");
    const recursiveBase = path.join(root, "generated");
    const flatBase = path.join(root, "flat");
    const slottedBase = path.join(root, "slotted");
    const registry = new DependencyStructureWatchRegistry(() => ({ dispose: () => undefined }));
    registry.update([exactPath], [
      { basePath: recursiveBase, pattern: "**/*.json" },
      { basePath: flatBase, pattern: "*.json" },
      { basePath: slottedBase, pattern: "slot?/*.json" }
    ]);

    assert.strictEqual(registry.shouldForwardEvent(path.dirname(exactPath), "delete", false), true);
    assert.strictEqual(registry.shouldForwardEvent(path.dirname(exactPath), "create", false), true);
    assert.strictEqual(registry.shouldForwardEvent(exactPath, "delete", false), false);

    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "moved-in"), "create", true),
      true
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "ordinary.txt"), "create", false),
      false
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "removed-tree"), "delete", false),
      true
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "direct.json"), "delete", false),
      true
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "direct.json"), "create", true),
      true
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(recursiveBase, "direct.json"), "create", false),
      false
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(flatBase, "nested"), "create", true),
      false
    );
    assert.strictEqual(registry.shouldForwardEvent(flatBase, "delete", false), true);
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(slottedBase, "slot1"), "create", true),
      true
    );
    assert.strictEqual(
      registry.shouldForwardEvent(path.join(slottedBase, "other"), "create", true),
      false
    );
  });
});
