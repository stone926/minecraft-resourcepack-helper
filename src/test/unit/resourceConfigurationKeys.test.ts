import * as assert from "node:assert/strict";
import {
  affectsResourceResolutionConfiguration,
  isResourceResolutionConfigurationKey,
  resourceConfigurationKeys
} from "../../utils/resourceConfigurationKeys";

describe("resource configuration keys", () => {
  it("detects only configuration changes that affect resource resolution", () => {
    for (const changedKey of [
      resourceConfigurationKeys.defaultAssetsPath,
      resourceConfigurationKeys.resourcePackLoadOrder
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
      isResourceResolutionConfigurationKey(resourceConfigurationKeys.defaultAssetsPath),
      true
    );
    assert.strictEqual(
      isResourceResolutionConfigurationKey(resourceConfigurationKeys.undefinedTextureVariableColor),
      false
    );
  });
});
