import { lm, type LocalizedMessage } from "../../i18n/messages";
import { isCancellationError } from "../cancellation";
import { ModelPreviewConsistencyError } from "../service/ModelPreviewService";

export function getModelPreviewExportErrorMessage(error: unknown): LocalizedMessage | null {
  if (isCancellationError(error)) {
    return null;
  }

  if (error instanceof ModelPreviewConsistencyError) {
    return lm("Model preview export failed because resources kept changing while the preview was being built.");
  }

  return lm("Model preview export failed: {0}", String(error));
}
