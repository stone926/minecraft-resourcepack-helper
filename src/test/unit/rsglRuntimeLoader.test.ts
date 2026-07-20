import * as assert from "node:assert";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInstalledRsglRuntimeLoader,
  normalizeRuntimeModule,
  type RsglRuntimeInstance
} from "../../rsgl/runtime";

describe("installed RSGL runtime loader", () => {
  it("uses a file URL for Windows-safe paths and injects explicit runtime paths", async () => {
    const extensionRoot = path.resolve("C:/extension path/资源包助手");
    let importedUrl = "";
    let received: Record<string, unknown> | undefined;
    const instance: RsglRuntimeInstance = { dispose: () => undefined };
    const context = {
      asAbsolutePath: (relative: string) => path.join(extensionRoot, relative)
    };
    const loader = createInstalledRsglRuntimeLoader(context as never, async url => {
      importedUrl = url;
      return {
        default: {
          createRsglRuntime: (options: Record<string, unknown>) => {
            received = options;
            return instance;
          }
        }
      };
    });

    const loaded = await loader({
      reason: "openDocument",
      generation: 1,
      signal: new AbortController().signal
    });
    assert.strictEqual(loaded, instance);
    assert.strictEqual(fileURLToPath(importedUrl), path.join(extensionRoot, "bundle", "features", "rsglHost.js"));
    assert.strictEqual(received?.serverPath, path.join(extensionRoot, "bundle", "rsgl", "server.js"));
    assert.strictEqual(received?.workerPath, path.join(extensionRoot, "bundle", "rsgl", "worker.js"));
    assert.strictEqual(received?.stdlibRoot, path.join(extensionRoot, "bundle", "rsgl", "stdlib"));
  });

  it("normalizes direct and CJS default exports and rejects malformed bundles", () => {
    const direct = { createRsglRuntime: () => ({ dispose() {} }) };
    assert.strictEqual(normalizeRuntimeModule(direct), direct);
    assert.strictEqual(normalizeRuntimeModule({ default: direct }), direct);
    assert.throws(() => normalizeRuntimeModule({ default: {} }), /does not export/);
  });
});
