import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  affectsResourceResolutionConfiguration,
  isResourceResolutionConfigurationKey,
  resourceConfigurationKeys
} from "../../utils/resourceConfigurationKeys";

describe("resource configuration keys", () => {
  it("publishes canonical settings and marks the legacy aliases as deprecated", () => {
    const manifest = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "package.json"),
      "utf8"
    )) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { deprecationMessage?: string }>;
        };
      };
    };
    const properties = manifest.contributes?.configuration?.properties ?? {};
    const messages = JSON.parse(fs.readFileSync(
      path.join(process.cwd(), "package.nls.json"),
      "utf8"
    )) as Record<string, string>;

    assert.ok(properties[resourceConfigurationKeys.vanillaResourcePackPath]);
    assert.ok(properties[resourceConfigurationKeys.customResourcePackPaths]);
    assert.strictEqual(
      properties[resourceConfigurationKeys.legacyDefaultMcAssetsPath]?.deprecationMessage,
      "%config.deprecation.defaultMcAssetsPath%"
    );
    assert.strictEqual(
      properties[resourceConfigurationKeys.legacyResourcePackLoadOrder]?.deprecationMessage,
      "%config.deprecation.resourcePackLoadOrder%"
    );
    assert.match(
      messages["config.deprecation.defaultMcAssetsPath"] ?? "",
      /vanillaResourcePackPath/
    );
    assert.match(
      messages["config.deprecation.resourcePackLoadOrder"] ?? "",
      /customResourcePackPaths/
    );
  });

  it("detects only configuration changes that affect resource resolution", () => {
    for (const changedKey of [
      resourceConfigurationKeys.vanillaResourcePackPath,
      resourceConfigurationKeys.customResourcePackPaths,
      resourceConfigurationKeys.legacyDefaultMcAssetsPath,
      resourceConfigurationKeys.legacyResourcePackLoadOrder
    ]) {
      assert.strictEqual(
        affectsResourceResolutionConfiguration({
          affectsConfiguration: section => section === changedKey
        }),
        true
      );
    }

    assert.strictEqual(
      affectsResourceResolutionConfiguration({
        affectsConfiguration: section => section === resourceConfigurationKeys.undefinedTextureVariableColor
      }),
      false
    );
    assert.strictEqual(
      isResourceResolutionConfigurationKey(resourceConfigurationKeys.vanillaResourcePackPath),
      true
    );
    assert.strictEqual(
      isResourceResolutionConfigurationKey(resourceConfigurationKeys.undefinedTextureVariableColor),
      false
    );
  });
});
