import * as assert from "node:assert/strict";
import { ModelPreviewCancellationError } from "../../modelPreview/cancellation";
import { getModelPreviewExportErrorMessage } from "../../modelPreview/host/modelPreviewErrorPresentation";
import { ModelPreviewConsistencyError } from "../../modelPreview/service/ModelPreviewService";

describe("model preview error presentation", () => {
  it("maps consistency failures to a static localization key", () => {
    assert.deepStrictEqual(
      getModelPreviewExportErrorMessage(new ModelPreviewConsistencyError()),
      { message: "Model preview export failed because resources kept changing while the preview was being built." }
    );
  });

  it("suppresses cancellation and preserves unexpected error details", () => {
    assert.strictEqual(getModelPreviewExportErrorMessage(new ModelPreviewCancellationError()), null);
    assert.deepStrictEqual(
      getModelPreviewExportErrorMessage(new Error("boom")),
      { message: "Model preview export failed: {0}", args: ["Error: boom"] }
    );
  });
});
