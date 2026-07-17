import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  findRsglProjectConfig,
  getRsglProjectConfigWatchPaths
} from "../../../../packages/rsgl-core/src/rsglConfig";
import {
  RsglProjectConfigWatchRegistry,
  type RsglProjectConfigWatcherFactory
} from "../../src/projectConfigWatch";
import { mergeRsglValidationConfiguration } from "../../src/validationConfiguration";

describe("RSGL project config watcher", () => {
  it("tracks the nearest ancestor config across edits, deletion fallbacks, and closer creation", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mc-resourcepack-helper-rsgl-config-watch-"));
    const sourceRoot = path.join(root, "project", "src");
    const sourceConfig = path.join(sourceRoot, "rsgl.config.json");
    const projectConfig = path.join(root, "project", "rsgl.config.json");
    const outerConfig = path.join(root, "rsgl.config.json");
    const activeWatchers = new Map<string, FakeWatcher>();
    const createdWatchers: FakeWatcher[] = [];
    let refreshes = 0;
    let registry: RsglProjectConfigWatchRegistry | undefined;

    const createWatcher: RsglProjectConfigWatcherFactory = (fileName, onDidChange) => {
      const key = path.resolve(fileName);
      const watcher: FakeWatcher = {
        fileName: key,
        disposed: false,
        fire: onDidChange,
        dispose: () => {
          watcher.disposed = true;
          if (activeWatchers.get(key) === watcher) {
            activeWatchers.delete(key);
          }
        }
      };
      activeWatchers.set(key, watcher);
      createdWatchers.push(watcher);
      return watcher;
    };

    try {
      fs.mkdirSync(sourceRoot, { recursive: true });
      fs.writeFileSync(outerConfig, "{}");
      registry = new RsglProjectConfigWatchRegistry(
        sourceRoot,
        "directory",
        createWatcher,
        () => refreshes++
      );

      assert.deepStrictEqual(
        [...activeWatchers.keys()],
        [sourceConfig, projectConfig, outerConfig].map(fileName => path.resolve(fileName))
      );
      assert.deepStrictEqual(
        getRsglProjectConfigWatchPaths(sourceRoot, "directory"),
        [sourceConfig, projectConfig, outerConfig].map(fileName => path.resolve(fileName))
      );
      assert.strictEqual(findRsglProjectConfig(sourceRoot), path.resolve(outerConfig));

      activeWatcher(activeWatchers, outerConfig).fire();
      assert.strictEqual(refreshes, 1, "editing the current nearest config should refresh");

      fs.writeFileSync(projectConfig, "{}");
      activeWatcher(activeWatchers, projectConfig).fire();
      assert.strictEqual(refreshes, 2, "creating a closer parent config should refresh");
      assert.strictEqual(findRsglProjectConfig(sourceRoot), path.resolve(projectConfig));
      assert.strictEqual(activeWatchers.has(path.resolve(outerConfig)), false);

      activeWatcher(activeWatchers, projectConfig).fire();
      assert.strictEqual(refreshes, 3, "editing the new nearest config should refresh");

      const deletedProjectConfigWatcher = activeWatcher(activeWatchers, projectConfig);
      fs.rmSync(projectConfig);
      deletedProjectConfigWatcher.fire();
      assert.strictEqual(refreshes, 4, "deleting the nearest config should refresh");
      assert.strictEqual(findRsglProjectConfig(sourceRoot), path.resolve(outerConfig));
      assert.ok(activeWatchers.has(path.resolve(outerConfig)), "the fallback config should be watched again");

      fs.writeFileSync(sourceConfig, "{}");
      activeWatcher(activeWatchers, sourceConfig).fire();
      assert.strictEqual(refreshes, 5, "creating a source-root config should refresh");
      assert.strictEqual(findRsglProjectConfig(sourceRoot), path.resolve(sourceConfig));
      assert.deepStrictEqual([...activeWatchers.keys()], [path.resolve(sourceConfig)]);

      const deletedSourceConfigWatcher = activeWatcher(activeWatchers, sourceConfig);
      fs.rmSync(sourceConfig);
      deletedSourceConfigWatcher.fire();
      assert.strictEqual(refreshes, 6, "deleting the source-root config should restore ancestor watches");
      assert.strictEqual(findRsglProjectConfig(sourceRoot), path.resolve(outerConfig));
      assert.ok(activeWatchers.has(path.resolve(projectConfig)));
      assert.ok(activeWatchers.has(path.resolve(outerConfig)));
    } finally {
      registry?.dispose();
      assert.ok(createdWatchers.every(watcher => watcher.disposed));
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("preserves explicit null, empty, and false API validation overrides", () => {
    const projectConfiguration = {
      defaultAssetsPath: "configured/vanilla",
      resourcePackRoots: ["configured/custom"],
      globalExterns: [{
        source: "vanilla" as const,
        kind: "texture" as const,
        patterns: ["minecraft:**"]
      }],
      checkExternExistence: true
    };
    assert.deepStrictEqual(
      mergeRsglValidationConfiguration({}, projectConfiguration),
      projectConfiguration
    );
    assert.deepStrictEqual(mergeRsglValidationConfiguration({
      defaultAssetsPath: null,
      resourcePackRoots: [],
      globalExterns: [],
      checkExternExistence: false
    }, projectConfiguration), {
      defaultAssetsPath: null,
      resourcePackRoots: [],
      globalExterns: [],
      checkExternExistence: false
    });
  });
});

interface FakeWatcher {
  fileName: string;
  disposed: boolean;
  fire(): void;
  dispose(): void;
}

function activeWatcher(watchers: ReadonlyMap<string, FakeWatcher>, fileName: string): FakeWatcher {
  const watcher = watchers.get(path.resolve(fileName));
  assert.ok(watcher, `Expected an active watcher for ${fileName}`);
  return watcher;
}
