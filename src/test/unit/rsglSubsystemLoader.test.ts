import * as assert from "node:assert/strict";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createInstalledRsglSubsystemLoader,
  normalizeSubsystemModule
} from "../../rsgl/loadInstalledRsglSubsystem";

describe("installed RSGL subsystem loader", () => {
  it("loads the separate host entry by a Windows-safe file URL", async () => {
    const extensionRoot = path.resolve("C:/extension path/资源包助手");
    const projects = {};
    const universe = {};
    const navigation = {};
    const registration = { dispose() {}, shutdown: async () => undefined };
    let importedUrl = "";
    let received: Record<string, unknown> | undefined;
    const context = {
      asAbsolutePath: (relative: string) => path.join(extensionRoot, relative)
    };
    const loader = createInstalledRsglSubsystemLoader(context as never, async url => {
      importedUrl = url;
      return {
        default: {
          createRsglSubsystem: (options: Record<string, unknown>) => {
            received = options;
            return registration;
          }
        }
      };
    });

    const loaded = await loader({ projects, universe, navigation } as never);

    assert.strictEqual(loaded, registration);
    assert.strictEqual(
      fileURLToPath(importedUrl),
      path.join(extensionRoot, "bundle", "features", "rsglHost.js")
    );
    assert.strictEqual(received?.extensionContext, context);
    assert.strictEqual(received?.projects, projects);
    assert.strictEqual(received?.universe, universe);
    assert.strictEqual(received?.navigation, navigation);
  });

  it("normalizes direct and CJS default exports and rejects malformed bundles", () => {
    const direct = { createRsglSubsystem: () => ({ dispose() {}, shutdown: async () => undefined }) };
    assert.strictEqual(normalizeSubsystemModule(direct), direct);
    assert.strictEqual(normalizeSubsystemModule({ default: direct }), direct);
    assert.throws(() => normalizeSubsystemModule({ default: {} }), /does not export/);
  });
});
